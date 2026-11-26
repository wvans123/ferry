// Explicit, account-scoped skill sync (global ~/.ferry/skills by default, or per-project .ferry/skills).
// File bytes never enter model tool results.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { FERRY_HOME, chunkSize, serverHeaders } from "./config.mjs";
import { createUploader } from "./upload.mjs";
import { gatewayPage } from "./gateway.mjs";
import { multiSelectDialog, patchUISelect } from "./dialog.mjs";

const MAX_FILE = 16 * 1024 * 1024;
const MAX_FILES = 2048;
const MAX_BUNDLE = 96 * 1024 * 1024;
export const GLOBAL_PROJECT_NAME = "全局 Skill 库";
const GLOBAL_NAMES = new Set([GLOBAL_PROJECT_NAME, "_global"]);
const BUILTIN_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
const EXCLUDED = new Set([".git", "node_modules", "__pycache__", ".ds_store", "thumbs.db", "desktop.ini",
	".env", "credentials.json", "secrets.json", ".ssh", ".aws", ".npmrc", ".netrc", "id_rsa", "id_ed25519",
	"local.md", "local.json", ".local"]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
	? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const jsonHash = (value) => hash(JSON.stringify(canonical(value)));
const id = () => randomUUID().replaceAll("-", "");
const excluded = (name) => EXCLUDED.has(name.toLowerCase()) || name.startsWith("~$")
	|| /^\.env\./i.test(name) || /\.(pem|key|pyc|pyo)$/i.test(name) || /\.local\.(md|json|ya?ml|py|txt)$/i.test(name);

export const isGlobalProject = (project) => Boolean(project && GLOBAL_NAMES.has(project.name));

const fmtBytes = (n) => n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB`
	: n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

/** Human-readable summary of a skill directory's files (proving scripts, references, templates, etc. are bundled). */
export function summarizeSkillFiles(files = [], basePath = "") {
	const prefix = basePath ? `${basePath.replace(/\/$/, "")}/` : "";
	let totalBytes = 0;
	const topFiles = [];
	const groups = new Map();
	for (const f of files) {
		totalBytes += f.bytes ?? 0;
		const rel = prefix && f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path;
		const slash = rel.indexOf("/");
		if (slash === -1) topFiles.push(rel);
		else {
			const dir = `${rel.slice(0, slash)}/`;
			groups.set(dir, (groups.get(dir) ?? 0) + 1);
		}
	}
	topFiles.sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b)));
	const parts = [...topFiles, ...[...groups.entries()].map(([dir, n]) => `${dir}×${n}`)];
	const shown = parts.length <= 5 ? parts.join(", ") : `${parts.slice(0, 5).join(", ")}, +${parts.length - 5} 项`;
	return `${files.length} 个文件, ${fmtBytes(totalBytes)}${shown ? ` (${shown})` : ""}`;
}

export function builtinSkillNames() {
	if (!existsSync(BUILTIN_SKILLS_DIR)) return [];
	return readdirSync(BUILTIN_SKILLS_DIR).sort().filter((name) => existsSync(join(BUILTIN_SKILLS_DIR, name, "SKILL.md")));
}

/** Return a first-time setup hint from SKILL.md frontmatter (`metadata.onboarding`) when this machine has no local KB index yet. */
export function extractSkillOnboarding(skillDir, ferryHome = FERRY_HOME) {
	try {
		const mdPath = join(skillDir, "SKILL.md");
		if (!existsSync(mdPath)) return null;
		if (existsSync(join(ferryHome, "local.md")) || existsSync(join(skillDir, "references", "local.md"))
			|| existsSync(join(skillDir, "local.md"))) {
			return null;
		}
		const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readFileSync(mdPath, "utf8"))?.[1];
		if (!fm) return null;
		const m = /^\s*onboarding:\s*(.+)$/m.exec(fm);
		if (!m) return null;
		const raw = m[1].trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
		return raw || null;
	} catch {
		return null;
	}
}

export function resourcePath(path) {
	if (typeof path !== "string" || !path || path.length > 240 || path.split("/").some((p) => !p || p === "." || p === ".."
		|| /[\\:*?"<>|\x00-\x1f]/.test(p) || /[ .]$/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p) || excluded(p))) {
		throw new Error("Choose a portable project-relative resource path without credentials or generated files.");
	}
	return path;
}

export function resourceKind(path) {
	resourcePath(path);
	if (/^\.(ferry|claude)\/skills\/[^/]+$/.test(path)) return "skill";
	if (/^\.(ferry|claude)\/agents\/[^/]+\.md$/.test(path)) return "agent";
	if (path === ".ferry/hooks.json") return "hooks";
	if (["AGENTS.md", "CLAUDE.md"].includes(path.split("/").at(-1))) return "rule";
	throw new Error("Select a skill directory, agent definition, AGENTS.md, CLAUDE.md or .ferry/hooks.json.");
}

export function projectRoot(cwd) {
	let p = resolve(cwd);
	for (;;) {
		if (existsSync(join(p, ".git"))) return p;
		if (dirname(p) === p) return resolve(cwd);
		p = dirname(p);
	}
}

// Check every existing component, including Windows junctions and case-insensitive collisions.
export function checkedFile(root, path) {
	resourcePath(path);
	let at = resolve(root);
	if (existsSync(at) && lstatSync(at).isSymbolicLink()) throw new Error("Use a real project directory, not a symlink.");
	for (const component of path.split("/")) {
		if (existsSync(at) && lstatSync(at).isDirectory()) {
			const collision = readdirSync(at).find((name) => name.toLowerCase() === component.toLowerCase() && name !== component);
			if (collision) throw new Error(`Case-conflicting path: ${path}`);
		}
		at = join(at, component);
		try {
			if (lstatSync(at).isSymbolicLink()) throw new Error(`Symlinks cannot be synced: ${path}`);
		} catch (e) {
			if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
		}
	}
	return at;
}

export function collectResource(root, path, source = null) {
	const kind = resourceKind(path);
	const start = source ? realpathSync(source) : checkedFile(root, path);
	if (source && lstatSync(source).isSymbolicLink()) throw new Error("A resource source cannot be a symlink.");
	const files = [];
	const skipped = [];
	function visit(file, name, depth) {
		if (depth > 24) throw new Error("Resource directory is too deep.");
		const s = lstatSync(file);
		if (s.isSymbolicLink()) throw new Error(`Symlinks cannot be synced: ${name}`);
		if (s.isDirectory()) {
			for (const child of readdirSync(file).sort()) {
				if (excluded(child)) { skipped.push(`${name}/${child}`); continue; }
				visit(join(file, child), `${name}/${child}`, depth + 1);
			}
		} else {
			resourcePath(name);
			if (!s.isFile() || s.size > MAX_FILE) throw new Error(`Only regular files up to 16 MiB can be synced: ${name}`);
			const bytes = readFileSync(file);
			files.push({ path: name, data: bytes.toString("base64"), sha256: hash(bytes), executable: !!(s.mode & 0o111), bytes: bytes.length });
			if (files.length > MAX_FILES) throw new Error(`A resource can contain at most ${MAX_FILES} files.`);
		}
	}
	visit(start, path, 0);
	if (kind === "skill" && !files.some((f) => f.path === path + "/SKILL.md")) throw new Error("A skill needs SKILL.md.");
	if (kind !== "skill" && (files.length !== 1 || files[0].path !== path)) throw new Error("This resource must be a single file.");
	// UTF-8 ordering agrees with the Server's Unicode ordering, including astral characters.
	files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
	const meta = files.map(({ path, sha256, executable }) => ({ path, sha256, executable }));
	const result = { path, kind, files, hash: jsonHash(meta) };
	if (Buffer.byteLength(JSON.stringify(result)) > MAX_BUNDLE) throw new Error("Resource bundle exceeds 96 MiB.");
	return { resource: result, skipped };
}

export function discoverResources(root, cwd = root) {
	const result = [];
	const seenDirs = new Set();
	for (const base of [...new Set([resolve(root), resolve(cwd)])]) {
		const isRoot = base === resolve(root);
		for (const prefix of [".ferry", ".claude"]) {
			const dir = join(base, prefix, "skills");
			if (!existsSync(dir)) continue;
			checkedFile(base, `${prefix}/skills`);
			for (const name of readdirSync(dir).sort()) {
				const full = join(dir, name);
				if (!existsSync(join(full, "SKILL.md"))) continue;
				const key = process.platform === "win32" ? full.toLowerCase() : full;
				if (seenDirs.has(key)) continue;
				seenDirs.add(key);
				const path = isRoot ? `${prefix}/skills/${name}` : `.ferry/skills/${name}`;
				result.push({
					name, path, source: isRoot ? null : full,
					label: isRoot ? path : `cwd:${name}`,
					scope: "project", origin: `当前项目 ${prefix}/skills`,
				});
			}
		}
	}
	const user = join(FERRY_HOME, "skills");
	if (existsSync(user)) for (const name of readdirSync(user).sort()) {
		const full = join(user, name);
		if (existsSync(join(full, "SKILL.md"))) {
			result.push({ name, path: `.ferry/skills/${name}`, source: full, label: `user:${name}`, scope: "global", origin: "全局 ~/.ferry/skills" });
		}
	}
	return result;
}

export function selectResource(root, selector, cwd = root) {
	const all = discoverResources(root, cwd);
	const exact = all.find((r) => r.label === selector);
	if (exact) return exact;
	const matched = all.filter((r) => basename(r.path) === selector || basename(r.path, ".md") === selector);
	if (matched.length === 1) return matched[0];
	if (matched.length > 1) throw new Error(`Ambiguous name. Choose one of: ${matched.map((r) => r.label).join(", ")}`);
	const source = resolve(root, selector);
	if (existsSync(join(source, "SKILL.md"))) {
		const name = basename(source);
		const path = `.ferry/skills/${name}`;
		resourceKind(path);
		return { name, path, source, label: selector, scope: "external", origin: selector };
	}
	const path = selector.replaceAll("\\", "/").replace(/^\.\//, "");
	if (resourceKind(path) === "skill") {
		checkedFile(root, path);
		if (existsSync(join(root, path, "SKILL.md"))) return { name: basename(path), path, source: null, label: path, scope: "project", origin: path };
	}
	throw new Error("Only skills can be synced. Choose a skill directory containing SKILL.md.");
}

export function parseSyncArgs(raw) {
	let rest = String(raw ?? "").trim();
	let revision;
	const revMatch = /(?:^|\s)--revision\s+(\d+)(?=\s|$)/.exec(rest);
	if (revMatch) {
		revision = Number(revMatch[1]);
		rest = `${rest.slice(0, revMatch.index)} ${rest.slice(revMatch.index + revMatch[0].length)}`.trim();
	}
	let flagGlobal = false, flagProject = false, fromProject = false, all = false;
	const tokens = [];
	const tokenRe = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (const m of rest.matchAll(tokenRe)) {
		const quoted = m[1] !== undefined || m[2] !== undefined;
		const val = m[1] ?? m[2] ?? m[3];
		if (!quoted && (val === "--global" || val === "-g")) flagGlobal = true;
		else if (!quoted && (val === "--project" || val === "-p")) flagProject = true;
		else if (!quoted && val === "--from-project") fromProject = true;
		else if (!quoted && val === "--all") all = true;
		else tokens.push(val);
	}
	if (flagGlobal && flagProject) throw new Error("Choose either --global or --project, not both.");
	let action = tokens[0];
	if (action === "push") action = "upload";
	const rawSelectors = tokens.slice(1).flatMap((t) => action === "bind" ? [t] : t.split(",").map((s) => s.trim()).filter(Boolean));
	const selector = tokens.slice(1).join(" ").trim();
	const isInstall = action === "install" || action === "pull";
	return {
		action,
		selector,
		selectors: action === "bind" ? (selector ? [selector] : []) : rawSelectors,
		scope: fromProject ? "project" : isInstall ? undefined : (flagGlobal ? "global" : flagProject ? "project" : undefined),
		target: isInstall ? (flagGlobal ? "global" : flagProject ? "project" : undefined) : undefined,
		all,
		revision,
	};
}

export function changes(local, remote) {
	const a = new Map((local?.files ?? []).map((f) => [f.path, f]));
	const b = new Map((remote?.files ?? []).map((f) => [f.path, f]));
	return [...new Set([...a.keys(), ...b.keys()])].sort().flatMap((path) => {
		const before = a.get(path), after = b.get(path);
		if (before?.sha256 === after?.sha256 && before?.executable === after?.executable) return [];
		return [`${!before ? "+" : !after ? "-" : "~"} ${path} (${before?.bytes ?? 0} → ${after?.bytes ?? 0} bytes)`];
	});
}

export function textDiff(local, remote) {
	const old = new Map((local?.files ?? []).map((f) => [f.path, f]));
	return (remote?.files ?? []).flatMap((file) => {
		const before = old.get(file.path);
		if (before?.sha256 === file.sha256) return [];
		try {
			const decode = (f) => f ? new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(f.data, "base64")) : "";
			const a = decode(before).split(/\r?\n/), b = decode(file).split(/\r?\n/);
			if (a.join("").includes("\0") || b.join("").includes("\0")) return [`${file.path}\nBinary file changed.`];
			let first = 0, lastA = a.length, lastB = b.length;
			while (first < lastA && first < lastB && a[first] === b[first]) first++;
			while (lastA > first && lastB > first && a[lastA - 1] === b[lastB - 1]) { lastA--; lastB--; }
			return [`${file.path}\n@@ line ${first + 1} @@\n` +
				a.slice(first, Math.min(lastA, first + 200)).map((s) => `- ${s}`).join("\n") + "\n" +
				b.slice(first, Math.min(lastB, first + 200)).map((s) => `+ ${s}`).join("\n") +
				(lastA - first > 200 || lastB - first > 200 ? "\n[Preview limited to 200 changed lines per side.]" : "")];
		} catch { return [`${file.path}\nBinary file changed.`]; }
	}).join("\n\n");
}

function stateDir(root, cfg) {
	// Exact path case preserves separate projects on case-sensitive filesystems. Tokens never become paths or metadata.
	return join(FERRY_HOME, "resource-sync", hash(`${cfg.server}\0${cfg.token}\0${realpathSync(root)}`));
}
function globalStateDir(cfg) {
	return join(FERRY_HOME, "resource-sync", hash(`${cfg.server}\0${cfg.token}\0global`));
}
function readState(dir) {
	try { return JSON.parse(readFileSync(join(dir, "state.json"), "utf8")); }
	catch (e) { if (e.code === "ENOENT") return { bases: {} }; throw e; }
}
function atomicJson(file, value) {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${id()}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
	renameSync(tmp, file);
}
function localResource(root, path) {
	const file = checkedFile(root, path);
	return existsSync(file) ? collectResource(root, path).resource : null;
}
function relocateResource(res, fromPrefix, toPrefix) {
	if (!res || fromPrefix === toPrefix) return res;
	const files = res.files.map((f) => ({
		...f,
		path: f.path === fromPrefix ? toPrefix : f.path.startsWith(`${fromPrefix}/`) ? `${toPrefix}${f.path.slice(fromPrefix.length)}` : f.path,
	}));
	return { ...res, path: toPrefix, files };
}
function collectExistingSkill(installRoot, relPath, canonicalPath) {
	const full = checkedFile(installRoot, relPath);
	if (!existsSync(full)) return null;
	if (existsSync(join(full, "SKILL.md"))) return collectResource(installRoot, canonicalPath, full).resource;
	const files = [];
	function walk(at, logical, depth) {
		if (depth > 24) throw new Error("Resource directory is too deep.");
		const s = lstatSync(at);
		if (s.isSymbolicLink()) throw new Error(`Symlinks cannot be synced: ${logical}`);
		if (s.isDirectory()) {
			for (const child of readdirSync(at).sort()) {
				if (excluded(child)) continue;
				walk(join(at, child), `${logical}/${child}`, depth + 1);
			}
		} else if (s.isFile() && s.size <= MAX_FILE) {
			const bytes = readFileSync(at);
			files.push({ path: logical, data: bytes.toString("base64"), sha256: hash(bytes), executable: !!(s.mode & 0o111), bytes: bytes.length });
		}
	}
	walk(full, canonicalPath, 0);
	files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
	return { path: canonicalPath, kind: "skill", files, hash: `incomplete:${jsonHash(files.map((f) => [f.path, f.sha256]))}` };
}

function acquireLock(dir) {
	const lock = join(dir, "lock");
	function stale(observed) {
		let pid;
		try { pid = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).pid; } catch { /* a new lock may still be writing its owner */ }
		if (Number.isInteger(pid) && pid > 0) {
			try { process.kill(pid, 0); }
			catch (e) { return e.code === "ESRCH"; }
			return false;
		}
		const info = statSync(lock);
		return Date.now() - (observed?.ino === info.ino ? observed.mtimeMs : info.mtimeMs) > 30000;
	}
	if (existsSync(lock) && stale()) {
		// Serialize stale-lock reclamation, then recheck in case another Client already replaced it.
		const reclaim = join(lock, "reclaim");
		const observed = statSync(lock);
		try { mkdirSync(reclaim); }
		catch {
			if (existsSync(reclaim) && Date.now() - statSync(reclaim).mtimeMs > 30000) rmSync(reclaim, { recursive: true });
			throw new Error("Another Client is recovering this project's sync lock. Retry the sync.");
		}
		if (stale(observed)) rmSync(lock, { recursive: true });
		else rmSync(reclaim, { recursive: true });
	}
	try { mkdirSync(lock); } catch { throw new Error("Another Client is syncing skills right now. Wait for it to finish."); }
	writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
	return lock;
}

function writeFiles(root, files, remove) {
	for (const path of remove) {
		const file = checkedFile(root, path);
		if (existsSync(file) && !lstatSync(file).isDirectory()) rmSync(file);
	}
	function removeEmptyDirectory(dir) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) throw new Error(`A local file blocks the pull: ${join(dir, entry.name)}`);
			removeEmptyDirectory(join(dir, entry.name));
		}
		rmdirSync(dir);
	}
	for (const f of files) {
		const file = checkedFile(root, f.path);
		if (existsSync(file) && lstatSync(file).isDirectory()) removeEmptyDirectory(file);
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.${id()}.tmp`;
		try {
			writeFileSync(tmp, Buffer.from(f.data, "base64"), { mode: f.executable ? 0o700 : 0o600 });
			renameSync(tmp, file);
			if (process.platform !== "win32") chmodSync(file, f.executable ? 0o700 : 0o600);
		} finally { rmSync(tmp, { force: true }); }
	}
}

export function recoverPull(root, dir) {
	const file = join(dir, "pending.json");
	if (!existsSync(file)) return;
	const journal = JSON.parse(readFileSync(file, "utf8"));
	// A completed state commit proves the files were installed before the process exited.
	if (readState(dir).transaction === journal.id) { rmSync(file); return; }
	for (const path of new Set([...journal.before.map((f) => f.path), ...journal.after.map((f) => f.path)])) {
		const current = checkedFile(root, path);
		const sha = existsSync(current) && lstatSync(current).isFile() ? hash(readFileSync(current)) : null;
		const allowed = [null, ...[...journal.before, ...journal.after].filter((f) => f.path === path).map((f) => f.sha256)];
		if (!allowed.includes(sha)) throw new Error(`An interrupted pull has a later local edit at ${path}. Restore from ${dir} before syncing.`);
	}
	writeFiles(root, journal.before, journal.after.filter((f) => !journal.before.some((b) => b.path === f.path)).map((f) => f.path));
	rmSync(file);
}

export function applyPull(root, dir, before, after, state) {
	const oldFiles = before.flatMap((r) => r?.files ?? []);
	const newFiles = after.flatMap((r) => r?.files ?? []);
	const journal = { id: id(), before: oldFiles, after: newFiles };
	// Validate all destinations before changing any file.
	for (const f of [...oldFiles, ...newFiles]) checkedFile(root, f.path);
	atomicJson(join(dir, "backups", `${Date.now()}-${journal.id}.json`), journal);
	atomicJson(join(dir, "pending.json"), journal);
	try {
		writeFiles(root, newFiles, oldFiles.filter((f) => !newFiles.some((n) => n.path === f.path)).map((f) => f.path));
		atomicJson(join(dir, "state.json"), { ...state, transaction: journal.id });
		rmSync(join(dir, "pending.json"));
	} catch (e) {
		recoverPull(root, dir);
		throw e;
	}
}

export function createResourceClient(cfg, { fetch: send = fetch, sleep, say } = {}) {
	const state = { chunk: chunkSize(cfg.chunkBytes) };
	const url = (path) => cfg.server.replace(/\/$/, "") + path;
	async function response(res) {
		const raw = await res.text();
		let b = {};
		if (raw) {
			try { b = JSON.parse(raw); }
			catch (e) {
				if (res.ok) throw new Error(`Resource sync stream interrupted (${raw.length} chars received): ${e.message}`);
			}
		}
		if (!res.ok) throw new Error(b.error?.message ?? b.detail ?? `Ferry resource sync HTTP ${res.status}`);
		return b;
	}
	async function api(path, body, signal) {
		if (!cfg.server || !cfg.token) throw new Error("Log in to Ferry first.");
		const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
		if (bytes?.length > state.chunk) throw new Error("Resource metadata exceeds the configured upload part size.");
		return response(await send(url(`/v1/ferry/resources/${path}`), {
			method: body === undefined ? "GET" : "POST", headers: serverHeaders(cfg, { "Content-Type": "application/json" }),
			body: bytes, signal: signal ?? AbortSignal.timeout(90000), redirect: "manual",
		}));
	}
	const uploader = createUploader(state, {
		sleep, say,
		gatewayConfirm: (res, text) => gatewayPage(res.headers.get("location"), text),
		post: (path, body, signal) => send(url(path), { method: "POST", headers: serverHeaders(cfg, { "Content-Type": "application/octet-stream" }),
			body, redirect: "manual", signal: signal ?? AbortSignal.timeout(90000) }),
	}, { upload: "/v1/ferry/resources/upload", commit: "/v1/ferry/resources/commit" });

	async function hydrateResource(project, remoteMeta, knownRes, revision, signal, { onlyTextUnderBytes = null } = {}) {
		if (!remoteMeta) return null;
		const files = remoteMeta.files ?? [];
		if (files.every((f) => typeof f.data === "string")) return remoteMeta;
		if (files.some((f) => typeof f.bytes !== "number" || typeof f.sha256 !== "string")) {
			const q = new URLSearchParams({ path: remoteMeta.path, ...(revision !== undefined ? { revision: String(revision) } : {}) });
			return (await api(`projects/${project}?${q}`, undefined, signal)).resource ?? null;
		}
		const knownBySha = new Map();
		for (const kf of knownRes?.files ?? []) {
			if (typeof kf.sha256 === "string" && typeof kf.data === "string") knownBySha.set(kf.sha256, kf.data);
		}
		const need = new Map();
		for (const f of files) {
			if (typeof f.data === "string" || knownBySha.has(f.sha256)) continue;
			if (onlyTextUnderBytes !== null && f.bytes > onlyTextUnderBytes) continue;
			need.set(f.sha256, f.bytes);
		}
		const fetched = new Map();
		if (need.size > 0) {
			const sliceLimit = Math.max(32768, Math.min(262144, Math.floor(state.chunk * 0.65)));
			const smallBatch = [];
			let smallBytes = 0;
			const flushSmall = async () => {
				if (!smallBatch.length) return true;
				const batch = smallBatch.splice(0, smallBatch.length);
				smallBytes = 0;
				let res;
				try {
					res = await api(`projects/${project}/blobs`, { shas: batch }, signal);
				} catch (e) {
					if (/HTTP 40[45]/.test(e.message)) return false;
					throw e;
				}
				if (!res?.blobs || typeof res.blobs !== "object") return false;
				for (const [k, v] of Object.entries(res.blobs)) fetched.set(k, v);
				return true;
			};
			let supported = true;
			for (const [sha, totalBytes] of need.entries()) {
				if (totalBytes === 0) {
					fetched.set(sha, "");
					continue;
				}
				if (totalBytes <= sliceLimit) {
					if (smallBatch.length >= 64 || (smallBatch.length > 0 && smallBytes + totalBytes > sliceLimit)) {
						if (!await flushSmall()) { supported = false; break; }
					}
					smallBatch.push(sha);
					smallBytes += totalBytes;
				} else {
					if (!await flushSmall()) { supported = false; break; }
					const chunks = [];
					for (let offset = 0; offset < totalBytes; offset += sliceLimit) {
						let part;
						try {
							part = await api(`projects/${project}/blobs`, { sha, offset, limit: Math.min(sliceLimit, totalBytes - offset) }, signal);
						} catch (e) {
							if (/HTTP 40[45]/.test(e.message)) { supported = false; break; }
							throw e;
						}
						if (typeof part?.data !== "string") { supported = false; break; }
						chunks.push(Buffer.from(part.data, "base64"));
					}
					if (!supported) break;
					fetched.set(sha, Buffer.concat(chunks).toString("base64"));
				}
			}
			if (supported && smallBatch.length) supported = await flushSmall();
			if (!supported) {
				const q = new URLSearchParams({ path: remoteMeta.path, ...(revision !== undefined ? { revision: String(revision) } : {}) });
				return (await api(`projects/${project}?${q}`, undefined, signal)).resource ?? null;
			}
		}
		return {
			...remoteMeta,
			files: files.map((f) => ({
				...f,
				data: typeof f.data === "string" ? f.data : (knownBySha.get(f.sha256) ?? fetched.get(f.sha256) ?? ""),
			})),
		};
	}

	return {
		api,
		hydrateResource,
		async upload(project, revision, resources, signal, deletes = []) {
			const bytes = Buffer.from(JSON.stringify({ put: resources, delete: deletes }));
			if (bytes.length > MAX_BUNDLE) throw new Error("Resource bundle exceeds 96 MiB.");
			const q = new URLSearchParams({ project, base: String(revision), operation: id() });
			return response(await uploader.commit(bytes, q, signal));
		},
	};
}

async function confirmed(ctx, text, action) {
	if (!ctx.hasUI) throw new Error("Run /sync in the interactive Client to review and approve resource changes.");
	patchUISelect(ctx.ui);
	return await ctx.ui.select(text, [action, "取消"]) === action;
}

async function review(ctx, text, action, diff) {
	if (!ctx.hasUI) throw new Error("Run /sync in the interactive Client to review resource changes.");
	patchUISelect(ctx.ui);
	for (;;) {
		const choice = await ctx.ui.select(text, [action, "查看文本差异", "取消"]);
		if (choice !== "查看文本差异") return choice === action;
		await ctx.ui.editor("文本差异预览（此处编辑不会写入文件）", diff || "没有文本差异。二进制或删除文件见文件清单。");
	}
}

export function createResources(cfg) {
	return (pi) => {
		const client = createResourceClient(cfg, { say: (text) => pi.sendMessage({ customType: "resource-sync", content: text, display: true }) });
		let working = false;
		async function run(args, ctx, signal) {
			if (working) throw new Error("Another resource sync is running in this Client.");
			working = true;
			try { return await sync(args, ctx, signal); }
			finally { working = false; }
		}

		async function ensureProjectBound(client, projects, projectArg, root, projectDir, projectState, ctx, signal, explicitBind = false) {
			const nonGlobal = projects.filter((p) => !isGlobalProject(p));
			let p = projectArg ? nonGlobal.find((x) => x.id === projectArg || x.name === projectArg) : null;
			if (projectArg && nonGlobal.filter((x) => x.name === projectArg).length > 1) throw new Error("Project name is ambiguous. Use its ID.");
			if (!p) {
				if (!ctx.hasUI) return { needsBinding: true, projects: nonGlobal, instruction: "Use /sync bind in the interactive Client." };
				const options = nonGlobal.map((x) => `${x.name} [${x.id}]`);
				const choice = await ctx.ui.select("关联当前本地项目到 Server 项目空间", [...options, "创建新项目"]);
				if (!choice) return { cancelled: true };
				p = nonGlobal[options.indexOf(choice)];
				if (!p) {
					const name = await ctx.ui.input("Server 项目名称", basename(root));
					if (!name || isGlobalProject({ name: name.trim() })) return { cancelled: true };
					p = await client.api("projects", { name }, signal);
				}
			}
			if (explicitBind || projectState.project?.id !== p.id) {
				if (!await confirmed(ctx, `将本地项目 ${root} 关联到 ${p.name} [${p.id}]？`, "关联")) return { cancelled: true };
				projectState.project = p;
				projectState.bases ??= {};
				atomicJson(join(projectDir, "state.json"), projectState);
			}
			return { project: p };
		}

		async function sync({ action = "status", selectors = [], scope, target, project, revision, all = false, askScope = false }, ctx, signal) {
			if (action === "push") action = "upload";
			const isInstall = action === "install" || action === "pull";
			const cwd = resolve(ctx.cwd ?? process.cwd());
			const root = projectRoot(cwd);
			mkdirSync(FERRY_HOME, { recursive: true, mode: 0o700 });
			const projectDir = stateDir(root, cfg);
			const globalDir = globalStateDir(cfg);
			const lockDirs = [...new Set([globalDir, projectDir])].sort();
			for (const d of lockDirs) mkdirSync(d, { recursive: true, mode: 0o700 });
			const locks = [];
			try {
				for (const d of lockDirs) locks.push(acquireLock(d));
				recoverPull(FERRY_HOME, globalDir);
				recoverPull(root, projectDir);
				const globalState = readState(globalDir);
				const projectState = readState(projectDir);
				const localList = discoverResources(root, cwd);
				const builtins = builtinSkillNames();

				if (action === "list") {
					const projects = (await client.api("projects", undefined, signal)).projects;
					return {
						builtin: builtins,
						local: localList.map(({ label, path, scope: s, origin }) => ({ selector: label, path, scope: s, origin })),
						projects,
						globalLibrary: projects.find(isGlobalProject) ?? null,
						bound: projectState.project ?? null,
					};
				}

				const projects = (await client.api("projects", undefined, signal)).projects;
				if (action === "bind") {
					const bound = await ensureProjectBound(client, projects, project, root, projectDir, projectState, ctx, signal, true);
					return bound.cancelled || bound.needsBinding ? bound : { bound: bound.project };
				}

				if (action === "status") {
					const globalProj = projects.find(isGlobalProject) ?? null;
					const globalHead = globalProj ? await client.api(`projects/${globalProj.id}`, undefined, signal) : { revision: 0, resources: [] };
					const serverSkills = globalHead.resources.filter((r) => r.kind === "skill");
					const serverByName = new Map(serverSkills.map((r) => [basename(r.path), r]));

					const inspectLocal = (item) => {
						const { resource: res } = collectResource(root, item.path, item.source);
						const remote = serverByName.get(item.name);
						const statusLabel = !remote ? "未上传到全局库" : remote.hash === res.hash ? "与全局库一致" : "与全局库有差异";
						return {
							name: item.name, selector: item.label, scope: item.scope, origin: item.origin,
							local: res.hash, server: remote?.hash ?? null,
							summary: summarizeSkillFiles(res.files, item.path), status: statusLabel,
						};
					};
					const localGlobal = localList.filter((r) => r.scope === "global").map(inspectLocal);
					const localProject = localList.filter((r) => r.scope === "project").map(inspectLocal);
					const localNames = new Set(localList.map((r) => r.name));
					const serverEntries = serverSkills.map((r) => {
						const name = basename(r.path);
						const ver = r.ver ?? 1;
						const g = localGlobal.find((x) => x.name === name);
						const p = localProject.find((x) => x.name === name);
						const stateNote = g ? (g.local === r.hash ? "本机全局已是最新" : "本机全局可更新")
							: p ? (p.local === r.hash ? "当前项目已是最新" : "当前项目有差异") : "本机未安装";
						return { name, ver, path: r.path, hash: r.hash, summary: summarizeSkillFiles(r.files, r.path), status: stateNote, installed: localNames.has(name) };
					});

					let boundSummary = null;
					if (projectState.project && !scope) {
						const pHead = await client.api(`projects/${projectState.project.id}`, undefined, signal).catch(() => null);
						if (pHead) {
							boundSummary = {
								project: projectState.project, revision: pHead.revision,
								resources: pHead.resources.filter((r) => r.kind === "skill").map((r) => {
									const loc = localResource(root, r.path);
									return { path: r.path, ver: r.ver ?? 1, local: loc?.hash ?? null, server: r.hash, baseline: projectState.bases[r.path] ?? null, changes: changes(loc, r) };
								}),
							};
						}
					}

					const lines = [
						"Skill 同步概览",
						`内置 Skill（随客户端自带，无需同步）：${builtins.join(", ") || "无"}`,
						`本机全局 (${join(FERRY_HOME, "skills")})：${localGlobal.length ? `${localGlobal.length} 个` : "暂无"}`,
						...localGlobal.map((x) => `  - ${x.name}：${x.status} · ${x.summary}`),
						`当前项目 (${join(root, ".ferry", "skills")})：${localProject.length ? `${localProject.length} 个` : "暂无"}`,
						...localProject.map((x) => `  - ${x.name}：${x.status} · ${x.summary}`),
						`服务端全局 Skill 库：${serverEntries.length ? `${serverEntries.length} 个（单个 Skill 独立版本）` : "暂无"}`,
						...serverEntries.map((x) => `  - ${x.name} (v${x.ver})：${x.status} · ${x.summary}`),
						...(boundSummary ? [`关联项目空间 ${boundSummary.project.name}：${boundSummary.resources.length} 个 Skill`] : []),
						"用法：/sync upload [名字] 上传整包（自动跳过 local.md 等本机私有配置）；/sync install [名字] 安装到本机全局或当前项目",
					];
					return {
						builtin: builtins,
						project: globalProj ?? { id: null, name: GLOBAL_PROJECT_NAME },
						revision: globalHead.revision,
						localGlobal,
						localProject,
						resources: serverEntries,
						boundProject: boundSummary,
						summaryText: lines.join("\n"),
					};
				}

				let chosenScope = scope;
				if (!chosenScope) {
					if (project) chosenScope = "project";
					else if (action === "upload" && askScope && ctx.hasUI) {
						const opts = [
							`上传到全局 Skill 库（默认，跨电脑通用）`,
							`上传到当前项目专属空间（${projectState.project ? projectState.project.name : `关联目录 ${basename(root)}`}）`,
							"取消",
						];
						const pick = await ctx.ui.select("选择上传目标空间（整包上传 SKILL.md 及 scripts/、references/ 等全部子文件）", opts);
						if (!pick || pick === "取消") return { cancelled: true };
						chosenScope = pick === opts[1] ? "project" : "global";
					} else if (isInstall && askScope && ctx.hasUI && projectState.project) {
						const opts = [
							`从全局 Skill 库安装（默认）`,
							`从当前关联项目空间 [${projectState.project.name}] 安装`,
							"取消",
						];
						const pick = await ctx.ui.select("选择服务端 Skill 来源", opts);
						if (!pick || pick === "取消") return { cancelled: true };
						chosenScope = pick === opts[1] ? "project" : "global";
					} else {
						chosenScope = "global";
					}
				}

				let serverBucket;
				if (chosenScope === "global") {
					serverBucket = projects.find(isGlobalProject) ?? null;
					if (!serverBucket && action === "upload") {
						serverBucket = await client.api("projects", { name: GLOBAL_PROJECT_NAME }, signal);
					}
				} else {
					const bound = await ensureProjectBound(client, projects, project, root, projectDir, projectState, ctx, signal, false);
					if (bound.cancelled || bound.needsBinding) return bound;
					serverBucket = bound.project;
				}

				if (action === "history") {
					if (!serverBucket) return { history: [], message: "全局 Skill 库还没有历史提交记录。" };
					return client.api(`projects/${serverBucket.id}/history`, undefined, signal);
				}

				if (!["upload", "pull", "install", "delete"].includes(action)) {
					throw new Error("Use install, upload, pull, status, list, delete, history or bind.");
				}

				const head = serverBucket ? await client.api(`projects/${serverBucket.id}`, undefined, signal) : { revision: 0, resources: [] };
				const selected = isInstall && revision !== undefined && serverBucket
					? await client.api(`projects/${serverBucket.id}?revision=${revision}`, undefined, signal) : head;
				const remoteSkills = selected.resources.filter((r) => r.kind === "skill");

				if ((isInstall || action === "delete") && !remoteSkills.length) {
					return {
						message: chosenScope === "global"
							? "服务端全局 Skill 库还没有任何 Skill。请先在已有 Skill 的电脑上运行 /sync upload 上传。"
							: `服务端项目 ${serverBucket?.name ?? ""} 中还没有任何 Skill。`,
						resources: [],
					};
				}

				let installTarget = target;
				if (isInstall && !installTarget) {
					if (ctx.hasUI) {
						const globalDest = join(FERRY_HOME, "skills");
						const projectDest = join(root, ".ferry", "skills");
						const opts = [
							`安装到本机全局 (${globalDest})（默认，所有项目通用）`,
							`仅安装到当前项目 (${projectDest})`,
							"取消",
						];
						const pick = await ctx.ui.select("选择 Skill 安装位置（包含 SKILL.md 及 scripts/、references/ 等全部子文件）", opts);
						if (!pick || pick === "取消") return { cancelled: true };
						installTarget = pick === opts[1] ? "project" : "global";
					} else {
						installTarget = chosenScope === "project" ? "project" : "global";
					}
				}

				let choices = [];
				if (action === "upload") {
					const collected = localList.map((item) => {
						const serverPath = chosenScope === "global" ? `.ferry/skills/${item.name}` : item.path;
						const { resource: res, skipped: sk } = collectResource(root, serverPath, item.source ?? checkedFile(root, item.path));
						const remote = head.resources.find((r) => r.path === serverPath) ?? null;
						const badge = !remote ? "未上传" : remote.hash === res.hash ? "已是最新" : "本地有更新";
						return { ...item, path: serverPath, collected: res, skipped: sk, remote, badge, summary: summarizeSkillFiles(res.files, serverPath) };
					});

					if (all) {
						choices = collected.filter((c) => !c.remote || c.remote.hash !== c.collected.hash);
						if (!choices.length) return { message: "本机所有已读取的 Skill 均与服务端一致，无需上传。", resources: [] };
					} else if (selectors.length) {
						for (const s of selectors) {
							const exact = collected.find((r) => r.label === s);
							if (exact) { choices.push(exact); continue; }
							const matched = collected.filter((r) => r.name === s);
							if (matched.length === 1) { choices.push(matched[0]); continue; }
							if (matched.length > 1 && ctx.hasUI) {
								const opts = matched.map((m) => `${m.name} [${m.origin}] · ${m.badge} · ${m.summary}`);
								const pick = await ctx.ui.select(`本机全局与当前项目都有同名 Skill "${s}"，选择要上传哪一份：`, [...opts, "取消"]);
								if (!pick || pick === "取消") return { cancelled: true };
								choices.push(matched[opts.indexOf(pick)]);
								continue;
							}
							const sel = selectResource(root, s, cwd);
							const serverPath = chosenScope === "global" ? `.ferry/skills/${sel.name ?? basename(sel.path)}` : sel.path;
							const { resource: res, skipped: sk } = collectResource(root, serverPath, sel.source ?? checkedFile(root, sel.path));
							choices.push({ ...sel, path: serverPath, collected: res, skipped: sk });
						}
					} else {
						if (!collected.length) {
							return {
								message: `当前未发现任何自定义 Skill（已加载内置 Skill：${builtins.join(", ") || "无"}）。请先放到 ${join(FERRY_HOME, "skills")} 或 .ferry/skills/ 下。`,
								resources: [],
							};
						}
						if (!ctx.hasUI) return { choose: collected.map((r) => r.label) };
						const changedIndices = collected.flatMap((c, i) => (!c.remote || c.remote.hash !== c.collected.hash) ? [i] : []);
						const allLabel = changedIndices.length >= 2 ? `全部上传有变化的 Skill（共 ${changedIndices.length} 个）` : null;
						const itemLabels = collected.map((c) => `${c.name} [${c.origin}] · ${c.badge} · ${c.summary}`);
						const header = `本机已读取 ${collected.length} 个自定义 Skill${builtins.length ? `（内置 ${builtins.join(", ")} 无需同步）` : ""} — 空格勾选指定多个，回车确认：`;
						const pickedIdx = await multiSelectDialog(ctx.ui, header, itemLabels, { allIndices: changedIndices, allLabel, signal });
						if (!pickedIdx?.length) return { cancelled: true };
						choices = pickedIdx.map((i) => collected[i]);
					}
				} else {
					const inspectRemote = (r) => {
						const name = basename(r.path);
						const destPath = installTarget === "global" ? `skills/${name}` : (chosenScope === "global" ? `.ferry/skills/${name}` : r.path);
						const destRoot = installTarget === "global" ? FERRY_HOME : root;
						const loc = action === "delete" ? null : collectExistingSkill(destRoot, destPath, r.path);
						const badge = action === "delete" ? "服务端现有" : !loc ? "未安装" : loc.hash === r.hash ? "已是最新" : "有更新可同步";
						return { name, path: r.path, label: r.path, destPath, destRoot, localBefore: loc, remoteMeta: r, badge, summary: summarizeSkillFiles(r.files, r.path) };
					};
					const inspected = remoteSkills.map(inspectRemote);
					if (all && isInstall) {
						choices = inspected.filter((c) => !c.localBefore || c.localBefore.hash !== c.remoteMeta.hash);
						if (!choices.length) choices = inspected;
					} else if (selectors.length) {
						choices = selectors.map((s) => {
							const matches = inspected.filter((r) => r.path === s || r.name === s);
							if (matches.length !== 1) throw new Error(`Choose an unambiguous Server resource path for ${s}.`);
							return matches[0];
						});
					} else {
						if (!ctx.hasUI) return { choose: inspected.map((r) => r.label) };
						const outdatedIndices = isInstall ? inspected.flatMap((c, i) => (!c.localBefore || c.localBefore.hash !== c.remoteMeta.hash) ? [i] : []) : [];
						const allLabel = outdatedIndices.length >= 2 ? `全部安装/更新有变化的 Skill（共 ${outdatedIndices.length} 个）` : null;
						const itemLabels = inspected.map((c) => `${c.name} (v${c.remoteMeta.ver ?? 1}) · ${c.badge} · ${c.summary}`);
						const title = isInstall
							? `服务端 [${serverBucket.name}] 共有 ${inspected.length} 个 Skill — 空格勾选指定多个，回车安装到${installTarget === "global" ? "本机全局 (~/.ferry/skills)" : "当前项目 (.ferry/skills)"}：`
							: `选择要从服务端 [${serverBucket.name}] 删除的 Skill（可空格勾选多个，历史版本仍会保留）：`;
						const pickedIdx = await multiSelectDialog(ctx.ui, title, itemLabels, { allIndices: outdatedIndices, allLabel, signal });
						if (!pickedIdx?.length) return { cancelled: true };
						choices = pickedIdx.map((i) => inspected[i]);
					}
				}

				if (new Set(choices.map((r) => r.path.toLowerCase())).size !== choices.length) throw new Error("Choose each destination only once.");

				const activeState = (isInstall ? installTarget : chosenScope) === "global" ? globalState : projectState;
				const activeDir = (isInstall ? installTarget : chosenScope) === "global" ? globalDir : projectDir;
				const before = [], after = [], skipped = [], conflicts = [], preview = [], diffs = [], summaries = [];

				for (const choice of choices) {
					const local = action === "upload"
						? (choice.collected ? { resource: choice.collected, skipped: choice.skipped ?? [] }
							: collectResource(root, choice.path, choice.source ?? checkedFile(root, choice.path)))
						: { resource: choice.localBefore ?? null, skipped: [] };
					const server = head.resources.find((r) => r.path === choice.path) ?? null;
					let targetRes = local.resource;

					if (isInstall) {
						targetRes = await client.hydrateResource(serverBucket.id, choice.remoteMeta, local.resource, revision, signal);
						if (!targetRes) throw new Error(`Resource does not exist in revision ${revision ?? head.revision}: ${choice.path}`);
						const kind = resourceKind(targetRes.path);
						if (targetRes.path !== choice.path || targetRes.kind !== kind || !Array.isArray(targetRes.files)
							|| !targetRes.files.length || targetRes.files.length > MAX_FILES) {
							throw new Error("Invalid downloaded resource.");
						}
						const names = new Set();
						for (const f of targetRes.files) {
							resourcePath(f.path);
							if (names.has(f.path.toLowerCase())) throw new Error("Duplicate downloaded file.");
							names.add(f.path.toLowerCase());
							if (kind === "skill" ? !f.path.startsWith(targetRes.path + "/") : f.path !== targetRes.path) throw new Error("Downloaded file is outside the resource.");
							const bytes = Buffer.from(f.data, "base64");
							if (bytes.length > MAX_FILE || bytes.length !== f.bytes || hash(bytes) !== f.sha256) throw new Error("Downloaded checksum or size mismatch.");
						}
						if (kind === "skill" && !targetRes.files.some((f) => f.path === targetRes.path + "/SKILL.md")) throw new Error("Downloaded skill needs SKILL.md.");
						if (jsonHash(targetRes.files.map(({ path, sha256, executable }) => ({ path, sha256, executable }))) !== targetRes.hash
							|| Buffer.byteLength(JSON.stringify(targetRes)) > MAX_BUNDLE) throw new Error("Downloaded resource hash or size mismatch.");
					}

					if (action === "upload") {
						let previous = null;
						if (server && serverBucket) {
							previous = await client.hydrateResource(serverBucket.id, server, targetRes, head.revision, signal, { onlyTextUnderBytes: 262144 });
						}
						diffs.push(textDiff(previous, targetRes));
						summaries.push(`${basename(choice.path)}：${summarizeSkillFiles(targetRes.files, choice.path)}`);
					} else if (isInstall) {
						diffs.push(textDiff(local.resource, targetRes));
						summaries.push(`${basename(choice.path)}：${summarizeSkillFiles(targetRes.files, choice.path)}`);
					}

					const baseKey = isInstall && installTarget === "project" ? (chosenScope === "global" ? `.ferry/skills/${basename(choice.path)}` : choice.path) : choice.path;
					const base = activeState.bases[baseKey] ?? null;
					if (action === "upload" && server && server.hash !== targetRes?.hash && server.hash !== base) conflicts.push(choice.path);
					if (isInstall && local.resource && local.resource.hash !== targetRes?.hash && local.resource.hash !== base) conflicts.push(choice.path);
					if (action === "delete") conflicts.push(choice.path);
					before.push(local.resource);
					after.push(targetRes);
					skipped.push(...local.skipped);
					preview.push(...(action === "upload" ? changes(server, targetRes) : action === "delete" ? changes(server, null) : changes(local.resource, targetRes)));
				}

				const bytes = after.reduce((sum, r) => sum + (r?.files ?? []).reduce((n, f) => n + f.bytes, 0), 0);
				const revNote = chosenScope === "global" && revision === undefined ? "" : ` (r${revision ?? head.revision})`;
				const destDesc = action === "upload"
					? `上传到服务端 [${serverBucket.name}]${revNote}`
					: action === "delete"
						? `从服务端 [${serverBucket.name}] 删除${revNote}`
						: `从服务端 [${serverBucket.name}]${revNote} 安装到${installTarget === "global" ? `本机全局 (${join(FERRY_HOME, "skills")})` : `当前项目 (${join(root, ".ferry", "skills")})`}`;
				const text = `${destDesc}\n` +
					(summaries.length ? `包含整包内容\n  ${summaries.join("\n  ")}\n` : "") +
					`${preview.slice(0, 200).join("\n") || "文件内容相同"}${preview.length > 200 ? `\n... 其余 ${preview.length - 200} 个文件变更` : ""}\n` +
					`共 ${fmtBytes(bytes)}；单个上传分片最多 ${fmtBytes(chunkSize(cfg.chunkBytes))}\n` +
					(skipped.length ? `已自动跳过本机私有配置/临时文件（${skipped.length} 个，如 local.md 不会上传）：${skipped.slice(0, 6).join(", ")}${skipped.length > 6 ? " ..." : ""}\n` : "") +
					(conflicts.length ? `需确认覆盖或删除\n${conflicts.join("\n")}\n` : "");

				if (!await review(ctx, text, conflicts.length ? "确认覆盖或删除" : "确认同步", diffs.filter(Boolean).join("\n\n"))) return { cancelled: true };

				// Verify no local file changed while the confirmation dialog was open.
				for (let i = 0; i < choices.length; i++) {
					const c = choices[i];
					const now = action === "upload"
						? collectResource(root, c.path, c.source ?? checkedFile(root, c.path)).resource
						: action === "delete" ? null : collectExistingSkill(c.destRoot, c.destPath, c.path);
					if ((now?.hash ?? null) !== (before[i]?.hash ?? null)) throw new Error("Local files changed after the preview. Review the sync again.");
				}

				let result;
				if (isInstall) {
					const installRoot = installTarget === "global" ? FERRY_HOME : root;
					const diskBefore = choices.map((c, i) => relocateResource(before[i], c.path, c.destPath));
					const diskAfter = choices.map((c, i) => relocateResource(after[i], c.path, c.destPath));
					for (let i = 0; i < choices.length; i++) {
						const c = choices[i];
						const baseKey = installTarget === "project" ? c.destPath : c.path;
						activeState.bases[baseKey] = head.resources.find((s) => s.path === c.path)?.hash ?? null;
					}
					applyPull(installRoot, activeDir, diskBefore, diskAfter, activeState);
					const installedDirs = choices.map((c) => join(installRoot, c.destPath));
					const onboardingHints = choices.flatMap((c, idx) => {
						const hint = extractSkillOnboarding(installedDirs[idx]);
						return hint ? [{ name: c.name, hint }] : [];
					});
					result = {
						pulled: choices.map((c) => installTarget === "global" ? `user:${c.name}` : c.destPath),
						target: installTarget,
						installedPaths: installedDirs,
						onboardingHints,
						revision: revision ?? head.revision,
						backups: join(activeDir, "backups"),
						instruction: "Use /reload when the current response has finished. Newly started subagents use the updated files.",
					};
				} else {
					result = await client.upload(serverBucket.id, head.revision, action === "delete" ? [] : after, signal,
						action === "delete" ? choices.map((r) => r.path) : []);
					for (let i = 0; i < choices.length; i++) {
						const c = choices[i];
						activeState.bases[c.path] = action === "delete" ? null : after[i]?.hash ?? null;
					}
					atomicJson(join(activeDir, "state.json"), activeState);
				}
				return {
					...result,
					scope: chosenScope,
					bucket: serverBucket.name,
					resources: choices.map((r) => r.path),
					skillNames: choices.map((r) => basename(r.path)),
					changedFiles: preview,
				};
			} finally {
				for (const lock of locks.reverse()) rmSync(lock, { recursive: true, force: true });
			}
		}

		pi.registerTool({
			name: "project_resources", label: "Skill sync",
			description: "List, status, upload or install/pull complete skill folders (SKILL.md plus scripts/, references/, examples/, templates/, etc.) via Ferry. " +
				"Use only when the user asks to sync or install skills. Default scope is 'global' (the user's cross-computer global skill library on the Server); " +
				"set scope='project' only for a folder-bound project workspace. For install/pull, target='global' writes to ~/.ferry/skills and target='project' writes to .ferry/skills. " +
				"Uploads use bounded parts and show the user a confirmation. Tool results contain file metadata, never script or reference file bodies.",
			parameters: Type.Object({
				action: Type.Union(["list", "bind", "status", "upload", "pull", "install", "delete", "history"].map((s) => Type.Literal(s))),
				selectors: Type.Optional(Type.Array(Type.String())),
				scope: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")])),
				target: Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")])),
				all: Type.Optional(Type.Boolean()),
				project: Type.Optional(Type.String()),
				revision: Type.Optional(Type.Integer({ minimum: 0 })),
			}),
			execute: async (_call, args, signal, _update, ctx) => {
				try {
					const result = await run(args, ctx, signal);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
				} catch (e) { return { content: [{ type: "text", text: e.message }], isError: true }; }
			},
		});

		async function handleSyncCommand(args, ctx) {
			try {
				const parsed = parseSyncArgs(args);
				let action = parsed.action;
				if (!action) {
					const menu = [
						"install — 从服务端安装/更新 Skill（可选装到全局或当前项目）",
						"upload  — 上传本机 Skill 整包（默认全局，含 scripts/ 等全部子文件）",
						"status  — 查看本机已加载 Skill 与服务端同步状态",
						"history — 查看服务端历史版本记录",
						"delete  — 从服务端删除指定 Skill",
						"bind    — 关联当前目录到服务端独立项目空间",
					];
					const pick = await ctx.ui.select("Skill 同步与安装", menu);
					if (!pick) return;
					action = pick.split(/\s+/)[0];
				}
				const result = await run({
					action,
					selectors: action === "bind" ? [] : (parsed.selectors ?? (parsed.selector ? [parsed.selector] : [])),
					scope: parsed.scope,
					target: parsed.target,
					all: parsed.all,
					askScope: !parsed.scope,
					project: action === "bind" ? parsed.selector || undefined : undefined,
					revision: parsed.revision,
				}, ctx);

				if (result.cancelled) {
					ctx.ui.notify("已取消 Skill 同步。", "info");
					return;
				}
				if (result.summaryText) {
					ctx.ui.notify(result.summaryText, "info");
					return;
				}
				if (result.message) {
					ctx.ui.notify(result.message, "info");
					return;
				}
				if (result.pulled) {
					const where = result.target === "global" ? `本机全局 (${join(FERRY_HOME, "skills")})` : `当前项目 (.ferry/skills)`;
					const hints = (result.onboardingHints ?? []).map((h) => `• [${h.name}] ${h.hint}`).join("\n");
					const msg = `已安装/更新 ${result.skillNames.join(", ")} 到${where}。` +
						(hints ? `\n\n首次使用提示（可选，不配置也可直接使用）：\n${hints}` : "");
					ctx.ui.notify(msg, "info");
					if (await confirmed(ctx, "Skill 文件已更新。现在重载使其在当前会话立即生效？", "立即重载")) {
						await ctx.reload();
					}
					return;
				}
				if (action === "upload") {
					ctx.ui.notify(`已整包上传 ${result.skillNames.join(", ")} 到服务端 [${result.bucket}]。`, "info");
					return;
				}
				if (action === "delete") {
					ctx.ui.notify(`已从服务端 [${result.bucket}] 删除 ${result.skillNames.join(", ")}（历史可恢复）。`, "info");
					return;
				}
				ctx.ui.notify(JSON.stringify(result, null, 2), "info");
			} catch (e) { ctx.ui.notify(e.message, "error"); }
		}

		cfg.runSyncCommand = handleSyncCommand;

		pi.registerCommand("sync", {
			description: "Install or upload full skill folders (incl. scripts/) to global ~/.ferry/skills or current project: /sync install [name] | /sync upload [name] | /sync status",
			getArgumentCompletions: (prefix) => {
				const trimmed = String(prefix ?? "").trimStart();
				const actions = ["install", "upload", "pull", "status", "history", "delete", "list", "bind"];
				if (!trimmed.includes(" ")) {
					return actions.filter((a) => a.startsWith(trimmed)).map((a) => ({ value: a, label: a }));
				}
				const [first, ...rest] = trimmed.split(/\s+/);
				const partial = trimmed.endsWith(" ") ? "" : rest.at(-1) ?? "";
				if (partial.startsWith("-")) {
					return ["--global", "--project", "--all"].filter((f) => f.startsWith(partial))
						.map((f) => ({ value: `${trimmed.slice(0, trimmed.length - partial.length)}${f}`, label: f }));
				}
				if (first === "upload" || first === "push") {
					try {
						const cwd = process.cwd();
						const found = discoverResources(projectRoot(cwd), cwd);
						return found.filter((r) => r.name.startsWith(partial)).map((r) => {
							const token = /\s/.test(r.name) ? `"${r.name}"` : r.name;
							return { value: `${first} ${token}`, label: `${r.name} [${r.origin}]` };
						});
					} catch { return []; }
				}
				return [];
			},
			handler: handleSyncCommand,
		});
	};
}
