// Explicit, account-scoped project resource sync. File bytes never enter model tool results.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Type } from "typebox";
import { FERRY_HOME, chunkSize, serverHeaders } from "./config.mjs";
import { createUploader } from "./upload.mjs";
import { gatewayPage } from "./gateway.mjs";

const MAX_FILE = 4 * 1024 * 1024;
const MAX_BUNDLE = 32 * 1024 * 1024;
const EXCLUDED = new Set([".git", "node_modules", "__pycache__", ".ds_store", ".env", "credentials.json", "secrets.json",
	".ssh", ".aws", ".npmrc", ".netrc", "id_rsa", "id_ed25519"]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
	? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const jsonHash = (value) => hash(JSON.stringify(canonical(value)));
const id = () => randomUUID().replaceAll("-", "");
const excluded = (name) => EXCLUDED.has(name.toLowerCase()) || /^\.env\./i.test(name) || /\.(pem|key)$/i.test(name);

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
	if (lstatSync(at).isSymbolicLink()) throw new Error("Use a real project directory, not a symlink.");
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
			if (!s.isFile() || s.size > MAX_FILE) throw new Error(`Only regular files up to 4 MiB can be synced: ${name}`);
			const bytes = readFileSync(file);
			files.push({ path: name, data: bytes.toString("base64"), sha256: hash(bytes), executable: !!(s.mode & 0o111), bytes: bytes.length });
			if (files.length > 512) throw new Error("A resource can contain at most 512 files.");
		}
	}
	visit(start, path, 0);
	if (kind === "skill" && !files.some((f) => f.path === path + "/SKILL.md")) throw new Error("A skill needs SKILL.md.");
	if (kind !== "skill" && (files.length !== 1 || files[0].path !== path)) throw new Error("This resource must be a single file.");
	// UTF-8 ordering agrees with the Server's Unicode ordering, including astral characters.
	files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
	const meta = files.map(({ path, sha256, executable }) => ({ path, sha256, executable }));
	const result = { path, kind, files, hash: jsonHash(meta) };
	if (Buffer.byteLength(JSON.stringify(result)) > MAX_BUNDLE) throw new Error("Resource bundle exceeds 32 MiB.");
	return { resource: result, skipped };
}

export function discoverResources(root) {
	const result = [];
	for (const prefix of [".ferry", ".claude"]) {
		const dir = join(root, prefix, "skills");
		if (!existsSync(dir)) continue;
		checkedFile(root, `${prefix}/skills`);
		for (const name of readdirSync(dir).sort()) {
			const path = `${prefix}/skills/${name}`;
			if (existsSync(join(root, path, "SKILL.md"))) result.push({ path, source: null, label: path });
		}
	}
	const user = join(FERRY_HOME, "skills");
	if (existsSync(user)) for (const name of readdirSync(user).sort()) {
		if (existsSync(join(user, name, "SKILL.md"))) result.push({ path: `.ferry/skills/${name}`, source: join(user, name), label: `user:${name}` });
	}
	return result;
}

export function selectResource(root, selector) {
	const all = discoverResources(root);
	const exact = all.find((r) => r.label === selector);
	if (exact) return exact;
	const matched = all.filter((r) => basename(r.path) === selector || basename(r.path, ".md") === selector);
	if (matched.length === 1) return matched[0];
	if (matched.length > 1) throw new Error(`Ambiguous name. Choose one of: ${matched.map((r) => r.label).join(", ")}`);
	const source = resolve(root, selector);
	if (existsSync(join(source, "SKILL.md"))) {
		const path = `.ferry/skills/${basename(source)}`;
		resourceKind(path);
		return { path, source, label: selector };
	}
	const path = selector.replaceAll("\\", "/").replace(/^\.\//, "");
	if (resourceKind(path) === "skill") {
		checkedFile(root, path);
		if (existsSync(join(root, path, "SKILL.md"))) return { path, source: null, label: path };
	}
	throw new Error("Only skills can be synced. Choose a skill directory containing SKILL.md.");
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
	try { mkdirSync(lock); } catch { throw new Error("Another Client is syncing this local project. Wait for it to finish."); }
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
		const b = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(b.error?.message ?? b.detail ?? `Ferry resource sync HTTP ${res.status}`);
		return b;
	}
	async function api(path, body, signal) {
		if (!cfg.server || !cfg.token) throw new Error("Log in to Ferry first.");
		const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
		if (bytes?.length > state.chunk) throw new Error("Resource metadata exceeds the configured upload part size.");
		return response(await send(url(`/v1/ferry/resources/${path}`), {
			method: body === undefined ? "GET" : "POST", headers: serverHeaders(cfg, { "Content-Type": "application/json" }),
			body: bytes, signal: signal ?? AbortSignal.timeout(60000), redirect: "manual",
		}));
	}
	const uploader = createUploader(state, {
		sleep, say,
		gatewayConfirm: (res, text) => gatewayPage(res.headers.get("location"), text),
		post: (path, body, signal) => send(url(path), { method: "POST", headers: serverHeaders(cfg, { "Content-Type": "application/octet-stream" }),
			body, redirect: "manual", signal: signal ?? AbortSignal.timeout(60000) }),
	}, { upload: "/v1/ferry/resources/upload", commit: "/v1/ferry/resources/commit" });
	return {
		api,
		async upload(project, revision, resources, signal, deletes = []) {
			const bytes = Buffer.from(JSON.stringify({ put: resources, delete: deletes }));
			if (bytes.length > MAX_BUNDLE) throw new Error("Resource bundle exceeds 32 MiB.");
			const q = new URLSearchParams({ project, base: String(revision), operation: id() });
			return response(await uploader.commit(bytes, q, signal));
		},
	};
}

async function confirmed(ctx, text, action) {
	if (!ctx.hasUI) throw new Error("Run /sync in the interactive Client to review and approve resource changes.");
	return await ctx.ui.select(text, [action, "取消"]) === action;
}

async function review(ctx, text, action, diff) {
	if (!ctx.hasUI) throw new Error("Run /sync in the interactive Client to review resource changes.");
	for (;;) {
		const choice = await ctx.ui.select(text, [action, "查看文本差异", "取消"]);
		if (choice !== "查看文本差异") return choice === action;
		await ctx.ui.editor("文本差异预览（此处编辑不会写入文件）", diff || "没有文本差异。删除文件见文件清单。");
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
		async function sync({ action = "status", selectors = [], project, revision }, ctx, signal) {
			const root = projectRoot(ctx.cwd ?? process.cwd());
			const dir = stateDir(root, cfg);
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			// One local writer across sessions; the OS removes no state on an interrupted write, so the journal is recoverable.
			const lock = acquireLock(dir);
			try {
				recoverPull(root, dir);
				let state = readState(dir);
				if (action === "list") return { local: discoverResources(root).map(({ label, path }) => ({ selector: label, path })),
					projects: (await client.api("projects", undefined, signal)).projects, bound: state.project ?? null };
				if (action === "bind" || !state.project) {
					const projects = (await client.api("projects", undefined, signal)).projects;
					let p = project ? projects.find((p) => p.id === project || p.name === project) : null;
					if (project && projects.filter((p) => p.name === project).length > 1) throw new Error("Project name is ambiguous. Use its ID.");
					if (!p) {
						if (!ctx.hasUI) return { needsBinding: true, projects, instruction: "Use /sync bind in the interactive Client." };
						const options = projects.map((p) => `${p.name} [${p.id}]`);
						const choice = await ctx.ui.select("关联当前本地项目到 Server 项目", [...options, "创建新项目"]);
						if (!choice) return { cancelled: true };
						p = projects[options.indexOf(choice)];
						if (!p) {
							const name = await ctx.ui.input("Server 项目名称", basename(root));
							if (!name) return { cancelled: true };
							p = await client.api("projects", { name }, signal);
						}
					}
					if (!await confirmed(ctx, `将本地项目 ${root} 关联到 ${p.name} [${p.id}]？`, "关联")) return { cancelled: true };
					state = { project: p, bases: {} };
					atomicJson(join(dir, "state.json"), state);
					if (action === "bind") return { bound: p };
				}
				const projectPath = `projects/${state.project.id}`;
				if (action === "history") return client.api(`${projectPath}/history`, undefined, signal);
				const head = await client.api(projectPath, undefined, signal);
				const selected = action === "pull" && revision !== undefined
					? await client.api(`${projectPath}?revision=${revision}`, undefined, signal) : head;
				if (action === "status") return { project: state.project, revision: head.revision, resources: head.resources.filter((r) => r.kind === "skill").map((r) => {
					const local = localResource(root, r.path);
					return { path: r.path, local: local?.hash ?? null, server: r.hash, baseline: state.bases[r.path] ?? null,
						changes: changes(local, r) };
				}) };
				if (!["upload", "pull", "delete"].includes(action)) throw new Error("Use list, bind, status, upload, pull, delete or history.");
				let choices;
				if (action === "upload") choices = selectors.map((s) => selectResource(root, s));
				else choices = selectors.map((s) => {
					const matches = selected.resources.filter((r) => r.kind === "skill" && (r.path === s || basename(r.path) === s));
					if (matches.length !== 1) throw new Error(`Choose an unambiguous Server resource path for ${s}.`);
					return { path: matches[0].path, label: matches[0].path };
				});
				if (!choices.length) {
					const available = action === "upload" ? discoverResources(root) : selected.resources.filter((r) => r.kind === "skill").map((r) => ({ path: r.path, label: r.path }));
					if (!available.length) return { message: "没有可选择的资源。", resources: [] };
					if (!ctx.hasUI) return { choose: available.map((r) => r.label) };
					const pick = await ctx.ui.select("选择资源（可再次执行命令同步其他资源）", available.map((r) => r.label));
					if (!pick) return { cancelled: true };
					choices = [available.find((r) => r.label === pick)];
				}
				if (new Set(choices.map((r) => r.path.toLowerCase())).size !== choices.length) throw new Error("Choose each destination only once.");
				const before = [], after = [], skipped = [], conflicts = [], preview = [], diffs = [];
				for (const choice of choices) {
					const local = action === "upload" ? collectResource(root, choice.path, choice.source) : { resource: localResource(root, choice.path), skipped: [] };
					const server = head.resources.find((r) => r.path === choice.path) ?? null;
					let target = local.resource;
					if (action === "pull") {
						const q = new URLSearchParams({ path: choice.path, revision: String(revision ?? head.revision) });
						target = (await client.api(`${projectPath}?${q}`, undefined, signal)).resource;
						if (!target) throw new Error(`Resource does not exist in revision ${revision ?? head.revision}: ${choice.path}`);
						// Re-hash bytes before writing content returned by the Server.
						const kind = resourceKind(target.path);
						if (target.path !== choice.path || target.kind !== kind || !Array.isArray(target.files) || !target.files.length || target.files.length > 512) throw new Error("Invalid downloaded resource.");
						const names = new Set();
						for (const f of target.files) {
							resourcePath(f.path);
							if (names.has(f.path.toLowerCase())) throw new Error("Duplicate downloaded file.");
							names.add(f.path.toLowerCase());
							if (kind === "skill" ? !f.path.startsWith(target.path + "/") : f.path !== target.path) throw new Error("Downloaded file is outside the resource.");
							const bytes = Buffer.from(f.data, "base64");
							if (bytes.length > MAX_FILE || bytes.length !== f.bytes || hash(bytes) !== f.sha256) throw new Error("Downloaded checksum or size mismatch.");
						}
						if (kind === "skill" && !target.files.some((f) => f.path === target.path + "/SKILL.md")) throw new Error("Downloaded skill needs SKILL.md.");
						if (jsonHash(target.files.map(({ path, sha256, executable }) => ({ path, sha256, executable }))) !== target.hash
							|| Buffer.byteLength(JSON.stringify(target)) > MAX_BUNDLE) throw new Error("Downloaded resource hash or size mismatch.");
					}
					if (action === "upload") {
						const q = new URLSearchParams({ path: choice.path, revision: String(head.revision) });
						const previous = (await client.api(`${projectPath}?${q}`, undefined, signal)).resource;
						diffs.push(textDiff(previous, target));
					} else if (action === "pull") diffs.push(textDiff(local.resource, target));
					const base = state.bases[choice.path] ?? null;
					if (action === "upload" && server?.hash !== target?.hash && (server?.hash ?? null) !== base) conflicts.push(choice.path);
					if (action === "pull" && local.resource?.hash !== target?.hash && (local.resource?.hash ?? null) !== base) conflicts.push(choice.path);
					if (action === "delete") conflicts.push(choice.path);
					before.push(local.resource);
					after.push(target);
					skipped.push(...local.skipped);
					preview.push(...(action === "upload" ? changes(server, target) : action === "delete" ? changes(server, null) : changes(local.resource, target)));
				}
				const bytes = after.reduce((sum, r) => sum + (r?.files ?? []).reduce((n, f) => n + f.bytes, 0), 0);
				const text = `${action} → ${state.project.name}, Server r${head.revision}\n${preview.join("\n") || "文件内容相同"}\n` +
					`${bytes} 文件字节；单个上传请求体最多 ${chunkSize(cfg.chunkBytes)} 字节\n` +
					(skipped.length ? `排除文件\n${skipped.join("\n")}\n` : "") +
					(choices.some((r) => r.source) ? `外部 skill 来源\n${choices.filter((r) => r.source).map((r) => `${r.source} → ${r.path}`).join("\n")}\n` : "") +
					(conflicts.length ? `需确认覆盖或删除\n${conflicts.join("\n")}\n` : "");
				if (!await review(ctx, text, conflicts.length ? "确认覆盖或删除" : "确认同步", diffs.join("\n\n"))) return { cancelled: true };
				// No file may change between the preview and the write, even while the approval is open.
				for (let i = 0; i < choices.length; i++) {
					const c = choices[i];
					const now = action === "upload" ? collectResource(root, c.path, c.source).resource : localResource(root, c.path);
					if ((now?.hash ?? null) !== (before[i]?.hash ?? null)) throw new Error("Local files changed after the preview. Review the sync again.");
				}
				let result;
				if (action === "pull") {
					// Historical pull becomes a local edit relative to current Server head, preserving conflict detection.
					for (const r of after) state.bases[r.path] = head.resources.find((s) => s.path === r.path)?.hash ?? null;
					applyPull(root, dir, before, after, state);
					result = { pulled: choices.map((r) => r.path), revision: revision ?? head.revision, backups: join(dir, "backups"),
						instruction: "Use /reload when the current response has finished. Newly started subagents use the updated files." };
				} else {
					result = await client.upload(state.project.id, head.revision, action === "delete" ? [] : after, signal,
						action === "delete" ? choices.map((r) => r.path) : []);
					for (const r of after) if (r) state.bases[r.path] = action === "delete" ? null : r.hash;
					atomicJson(join(dir, "state.json"), state);
				}
				return { ...result, resources: choices.map((r) => r.path), changedFiles: preview };
			} finally { rmSync(lock, { recursive: true, force: true }); }
		}
		pi.registerTool({
			name: "project_resources", label: "Skill sync",
			description: "List, upload or pull selected project skills (complete folders) via Ferry. Only skills containing SKILL.md are supported. " +
				"Use only when the user asks to sync these resources. First list to identify the requested skill; use its exact selector when names are ambiguous. " +
				"Uploads use bounded parts and show the user a confirmation. Tool results contain file metadata, never script or reference file bodies. " +
				"user:name uploads a user skill into the Server project's .ferry/skills/name. Pull always writes inside the local project. " +
				"history lists revisions; pull with revision restores selected historical resources locally. delete removes a Server resource and keeps its history.",
			parameters: Type.Object({ action: Type.Union(["list", "bind", "status", "upload", "pull", "delete", "history"].map((s) => Type.Literal(s))),
				selectors: Type.Optional(Type.Array(Type.String())), project: Type.Optional(Type.String()), revision: Type.Optional(Type.Integer({ minimum: 0 })) }),
			execute: async (_call, args, signal, _update, ctx) => {
				try {
					const result = await run(args, ctx, signal);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
				} catch (e) { return { content: [{ type: "text", text: e.message }], isError: true }; }
			},
		});
		pi.registerCommand("sync", {
			description: "Sync selected skills with your Ferry account. /sync upload <skill name or path>; /sync pull; /sync status; /sync history; /sync bind",
			handler: async (args, ctx) => {
				try {
					const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(String(args ?? "").trim());
					let action = match?.[1];
					let value = match?.[2]?.trim() ?? "";
					const version = /(?:^|\s)--revision\s+(\d+)(?:\s|$)/.exec(value);
					if (version) value = value.replace(version[0], " ").trim();
					const selector = value.replace(/^(["'])([\s\S]*)\1$/, "$2");
					if (!action) action = await ctx.ui.select("项目资源同步", ["upload", "pull", "status", "history", "bind", "list", "delete"]);
					if (!action) return;
					const result = await run({ action, selectors: action === "bind" || !selector ? [] : [selector],
						project: action === "bind" ? selector || undefined : undefined, revision: version ? Number(version[1]) : undefined }, ctx);
					ctx.ui.notify(JSON.stringify(result, null, 2), "info");
					if (result.pulled && await confirmed(ctx, "同步完成。现在重载 skill 和项目规则？", "重载")) {
						await ctx.reload();
					}
				} catch (e) { ctx.ui.notify(e.message, "error"); }
			},
		});
	};
}
