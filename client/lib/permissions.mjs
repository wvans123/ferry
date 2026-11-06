// Permissions, like Claude Code's permission modes and Codex's approval policies. Everything is decided on this
// computer; the server cannot change it.
//
// Modes (Shift+Tab cycles, the footer shows the current one):
//   default     ask before changing files and before commands that are not read-only
//   acceptEdits file changes inside the project folder go ahead; commands still ask
//   plan        read-only: reading, searching and read-only commands only; the agent presents a plan
//   bypass      nothing asks but uploads and deletes of what this session did not make (blocked paths, deny rules apply)
//
// Rules: "allow", "ask" and "deny" lists of entries like  bash(git log*)  edit(src/**)  powershell  web_fetch
//   user level      <FERRY_HOME>/permissions.json                      (every project)
//   project, yours  <FERRY_HOME>/projects/<folder>-<hash>/permissions.json   ("always allow" answers go here)
//   project, team   <project>/.ferry/permissions.json                  (read only; can be committed to the repo)
// deny beats ask beats allow. Read-only commands (git status, dir, ls, rg...) are allowed without a rule;
// dangerous ones (rm -rf, git push --force, ...) always ask unless the mode is bypass. Uploads ask in every mode; in
// bypass a delete goes ahead only when everything it deletes was made in this ferry session.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { FERRY_HOME } from "./config.mjs";

export const MODES = ["default", "acceptEdits", "plan", "bypass"];
export const MODE_LABEL = {
	default: "ask before edits and commands",
	acceptEdits: "auto-edit: file changes go ahead",
	plan: "plan: read-only",
	bypass: "full access: nothing asks",
};
const SHELL = new Set(["bash", "powershell"]);
const EDIT = new Set(["edit", "write", "office_edit", "office_create", "image_create"]);
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls", "office_read", "office_edit", "office_create", "image_create"]);
// tools that only look, or that are fenced in by themselves (memory: its own folder; task: the subagent's
// tools are checked one by one; web_*: the server's own allow list)
const READ_ONLY = new Set(["read", "grep", "find", "ls", "todo", "history_search", "memory", "task", "task_batch",
	"past_conversations", "office_read", "web_search",
	"job_output", "job_stop", "goal_update", "team", "ask_user"]); // team: only the team's own board
// reads, but from a site the user may not want contacted: asked per site (like Claude Code's WebFetch), also in plan mode
const NET = new Set(["web_fetch"]);

export function hostOf(url) {
	try {
		return new URL(/^https?:\/\//i.test(String(url)) ? String(url) : `https://${url}`).hostname.toLowerCase();
	} catch {
		return "";
	}
}
const WIN = process.platform === "win32";

// ---------- shell commands ----------

/** Split a command line into simple commands at && || ; | and newlines, outside quotes. */
export function splitCommand(cmd) {
	const parts = [];
	let cur = "";
	let q = "";
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		if (q) {
			cur += c;
			if (c === q) q = "";
			continue;
		}
		if (c === "'" || c === '"') {
			q = c;
			cur += c;
			continue;
		}
		const two = cmd.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			parts.push(cur);
			cur = "";
			i++;
			continue;
		}
		if (c === ";" || c === "|" || c === "\n" || (c === "&" && cmd[i + 1] !== ">" && cmd[i - 1] !== ">")) {
			parts.push(cur);
			cur = "";
			continue;
		}
		cur += c;
	}
	parts.push(cur);
	return parts.map((p) => p.trim()).filter(Boolean);
}

const words = (seg) => (seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ""));

const SAFE_ANY_ARGS = new Set([
	"ls", "dir", "pwd", "cat", "head", "tail", "wc", "echo", "printf", "grep", "egrep", "rg", "fd", "tree", "which",
	"where", "type", "file", "stat", "du", "df", "date", "whoami", "hostname", "sort", "uniq", "cut", "basename",
	"dirname", "realpath", "readlink", "diff", "cmp", "md5sum", "sha256sum", "true", "false", "test", "[", "findstr",
	"ver", "cd", "jq", "column", "nl", "tac", "rev", "less", "more",
	// PowerShell
	"get-childitem", "gci", "get-content", "gc", "select-string", "sls", "get-location", "gl", "test-path",
	"get-item", "gi", "measure-object", "select-object", "sort-object", "where-object", "format-table", "ft",
	"format-list", "fl", "out-string", "write-output", "write-host", "get-command", "gcm", "resolve-path",
	"split-path", "join-path", "get-date", "get-filehash", "set-location", "sl", "get-help", "convertto-json",
]);
const VERSION_ONLY = new Set(["node", "npm", "python", "python3", "py", "pip", "java", "go", "cargo", "rustc", "dotnet", "git"]);
const GIT_READ = new Set(["status", "diff", "log", "show", "blame", "ls-files", "grep", "rev-parse", "describe",
	"shortlog", "reflog", "cat-file", "ls-tree", "whatchanged", "--version", "help"]);

/** True when a simple command only reads (no writes, no redirection to a file, no command substitution). */
export function isReadOnlySegment(seg) {
	if (/\$\(|`/.test(seg)) return false;
	const noBenign = seg.replace(/\d?>&\d/g, "").replace(/\d?>>?\s*(\/dev\/null|nul|\$null)\b/gi, "");
	if (/>/.test(noBenign)) return false;
	const w = words(seg);
	let i = 0;
	while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i++; // FOO=bar cmd
	const cmd = (w[i] ?? "").toLowerCase().replace(/\.exe$/, "");
	const args = w.slice(i + 1);
	if (!cmd) return true;
	// options that make a reading program write a file (sort -o, tree -o, uniq in out) or run another one (rg --pre)
	if ((cmd === "sort" && args.some((a) => /^-[a-z]*o|^--output/i.test(a))) || (cmd === "tree" && args.includes("-o"))
		|| (cmd === "uniq" && args.filter((a) => !a.startsWith("-")).length > 1) || (cmd === "rg" && args.some((a) => /^--pre(=|$)/.test(a)))) return false;
	if (SAFE_ANY_ARGS.has(cmd)) return true;
	if (cmd === "find") return !args.some((a) => /^-(exec|execdir|delete|ok|fprint|fls)/.test(a));
	if (cmd === "sed") return !args.some((a) => /^-[a-z]*i/.test(a) || a.startsWith("--in-place"));
	if (VERSION_ONLY.has(cmd) && args.length === 1 && /^(-v|--version|-V|version)$/.test(args[0])) return true;
	if (cmd === "git") {
		const sub = args.find((a) => !a.startsWith("-")) ?? "";
		if (args.some((a) => /^--output(=|$)/.test(a))) return false; // git diff/log --output=file
		if (GIT_READ.has(sub)) return true;
		if (sub === "branch") return !args.some((a) => /^-(d|D|m|M|c|C)$|^--(delete|move|copy|set-upstream)/.test(a));
		if (sub === "remote") return args.length <= 2 && args.includes("-v");
		if (sub === "config") return args.includes("--get") || args.includes("--list") || args.includes("-l");
		if (sub === "stash") return args.includes("list") || args.includes("show");
		if (sub === "tag") return args.length === 1 || args.includes("-l") || args.includes("--list");
		return false;
	}
	if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn") return ["ls", "list", "outdated", "view", "why"].includes(args[0]);
	if (cmd === "pip" || cmd === "pip3") return ["list", "show", "freeze"].includes(args[0]);
	if (cmd === "agent-browser") { // looking at the open page; opening, clicking and typing still ask
		if (args[0] === "tab") return args.length === 1 || args[1] === "list";
		return ["snapshot", "get", "is", "screenshot", "skills", "session", "console", "errors", "diff", "--version", "--help"].includes(args[0]);
	}
	return false;
}

export const isReadOnlyCommand = (cmd) => splitCommand(cmd).every(isReadOnlySegment);

const DANGERS = [
	[/\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, "deletes files (rm -r / -f)"],
	[/\b(rmdir|rd)\s+.*\/s\b|\bdel\s+.*\/[sq]\b|\berase\s+.*\/s\b/i, "deletes a folder tree"],
	[/\b(remove-item|ri|rm|del)\b.*-recurse/i, "deletes a folder tree"],
	[/\bgit\s+push\b.*(--force\b|\s-f\b|--force-with-lease|\s\+\S)/i, "force-pushes, which can overwrite others' work"],
	[/\bgit\s+reset\s+--hard\b/i, "throws away uncommitted changes (git reset --hard)"],
	[/\bgit\s+clean\s+-[a-z]*f/i, "deletes untracked files (git clean)"],
	[/\bgit\s+checkout\s+(--\s+)?\.(\s|$)|\bgit\s+restore\s+(--\S+\s+)*\.(\s|$)/i, "throws away uncommitted changes"],
	[/\bgit\s+branch\s+.*-D\b/, "force-deletes a branch"],
	[/\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|]*\|\s*(sh|bash|zsh|iex|invoke-expression|python3?|node)\b/i, "runs a script straight from the internet"],
	[/\bformat(\.com)?\s+[a-z]:/i, "formats a drive"],
	[/\b(mkfs|diskpart|fdisk)\b|\bdd\s+if=/i, "writes to a disk directly"],
	[/\b(shutdown|reboot|stop-computer|restart-computer)\b/i, "shuts down or restarts the computer"],
	[/\breg(\.exe)?\s+(delete|add)\b|\bset-itemproperty\s+.*hk(lm|cu):/i, "changes the Windows registry"],
	[/\bchmod\s+(-R\s+)?777\b|\bchown\s+-R\b|\btakeown\b|\bicacls\b.*\/grant/i, "changes file permissions"],
	[/\bsudo\b|\brunas\b|start-process\b.*-verb\s+runas/i, "runs as administrator"],
	[/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb"],
];

const DELETES = DANGERS.filter(([, why]) => why.startsWith("deletes")).map(([re]) => re);

/** Why a command is dangerous, or "" when it is not. */
export function dangerOf(cmd) {
	for (const [re, why] of DANGERS) if (re.test(cmd)) return why;
	return "";
}

/** The rule an "always allow" answer adds for one simple command: its program (and subcommand) plus *. */
export function prefixRule(tool, seg) {
	const w = words(seg).filter((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x));
	const multi = /^(git|npm|pnpm|yarn|npx|python3?|py|pip3?|node|cargo|go|dotnet|mvn|gradlew?|make|docker|kubectl|uv|poetry)$/i;
	const take = w.length > 1 && multi.test(w[0]) && !w[1].startsWith("-") ? 2 : 1;
	return `${tool}(${w.slice(0, take).join(" ")}*)`;
}

// ---------- uploads and deletes ----------

const URL_RE = /\b(?:https?|ftps?|sftp|scp|rsync):\/\/[^\s"'<>]+/i;
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i; // data sent there stays on this computer
const CURL_ARG = new Set("AbcCdDeEFHKmoPQrtTuUwxXyYz"); // curl short options that take a value
const prog = (w) => w.replace(/^.*[\\/(]/, "").toLowerCase().replace(/\.exe$/, "");
const urlHost = (a) => hostOf(URL_RE.exec(a)?.[0] ?? "");
// user@host:path (scp, rsync), not C:\path
const remoteHost = (a) => urlHost(a) || (/^(?:[^@\s/\\]+@)?([\w.-]{2,}|\[[^\]]+\]):/.exec(a)?.[1] ?? "");

/** Where a command sends local data, as "sends data from this computer to <host>", or "". Downloads are not uploads. */
export function uploadOf(cmd) {
	for (const seg of splitCommand(String(cmd ?? ""))) {
		const w = words(seg);
		const at = w.findIndex((x) => /^(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|scp|rsync|sftp|ftp)$/.test(prog(x)));
		if (at < 0) continue;
		const c = prog(w[at]);
		const args = w.slice(at + 1);
		const plain = args.filter((a) => !a.startsWith("-"));
		let host = "";
		if (c === "scp" || c === "rsync") host = plain.length > 1 ? remoteHost(plain.at(-1)) : ""; // the destination is remote
		else if (c === "sftp" || c === "ftp") host = plain.map(remoteHost).find(Boolean) || hostOf(plain[0] ?? "");
		else {
			const sends = args.some((a, i) => /^--(data|form|upload-file|json|post-data|post-file|body-data|body-file)/i.test(a)
				|| (c === "curl" && /^-[a-zA-Z]+$/.test(a) && "dFT".includes([...a.slice(1)].find((ch) => CURL_ARG.has(ch)) ?? "x"))
				|| /^-(infile|body|form)(:|$)/i.test(a) // PowerShell
				|| (/^-method(:|$)/i.test(a) && /\b(post|put|patch)$/i.test(a.includes(":") ? a : (args[i + 1] ?? ""))));
			const hosts = args.map(urlHost).filter(Boolean);
			const proxied = args.some((a) => /^(-x|--proxy|-proxy)$/i.test(a));
			if (sends) host = hosts.find((h) => !LOCAL.test(h)) || (proxied || !hosts.length ? "a network address" : "");
		}
		if (host && !LOCAL.test(host)) return `sends data from this computer to ${host}`;
	}
	return "";
}

const DELETERS = new Set(["rm", "rmdir", "rd", "del", "erase", "unlink", "remove-item", "ri"]);
// deletes inside a one-liner: python -c, node -e, PowerShell .NET calls
const SCRIPT_DELETE = /shutil\.rmtree|\bos\.(remove|unlink|rmdir|removedirs)\b|\.(unlink|rmdir)\(|\b(rmSync|unlinkSync|rmdirSync)\b|\bfs(\.promises)?\.(rm|unlink|rmdir)\b/;
const NET_DELETE = /\[(system\.)?io\.(file|directory)\]::delete/i;

const CD = /^(cd|chdir|pushd|set-location|sl|push-location)$/;
const WHY_CMD = "a delete Ferry cannot read (find/xargs, rimraf, a script, git clean, a pipe)";

/**
 * The paths a command deletes, as written: { targets } ([] when it deletes nothing), or { why } when it deletes
 * something that cannot be listed. Wildcards and variables stay as written (expandTarget resolves them). A chain
 * `cd dir && rm x` (or `;`) gives the targets relative to dir; any other use of cd cannot be followed.
 */
export function deleteTargetsEx(cmd) {
	const out = [];
	const text = String(cmd ?? "");
	let base = ""; // the folder a simple cd chain moved to, as written
	let moved = false; // a cd we cannot follow
	const only = !/[|&\n]/.test(text.replace(/"[^"]*"|'[^']*'/g, "").replace(/&&/g, " ")); // && and ; only
	for (const seg of splitCommand(text)) {
		let w = words(seg).filter((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x));
		while (/^(sudo|doas|nohup|nice|time|command|exec|env)$/.test(prog(w[0] ?? ""))) w = w.slice(1).filter((x, i, a) => !a.slice(0, i + 1).every((y) => y.startsWith("-")));
		const c = prog(w[0] ?? "");
		const args = w.slice(1);
		if (CD.test(c) || c === "popd" || c === "pop-location") {
			const dirs = args.filter((x) => !/^-(path|literalpath|p|l|d)$/i.test(x) && !/^\/d$/i.test(x));
			if (CD.test(c) && only && dirs.length === 1 && !/[`$(]|^-$/.test(dirs[0].replace(/^\$env:\w+|^\$\{?\w+\}?|^%\w+%/, "")) && !moved) {
				const d = dirs[0];
				const abs = /^([a-z]:|[\\/~$%])/i.test(d) || /^\$/.test(d);
				base = abs || !base ? d : `${base}/${d}`;
			} else moved = true;
		}
		if (c === "git" && args.includes("clean") && args.some((a) => /^-[a-z]*f|^--force/i.test(a))) return { why: "git clean -f" };
		if (c === "find" && args.some((a, i) => a === "-delete" || (/^-(exec|execdir|ok|okdir)$/.test(a) && DELETERS.has(prog(args[i + 1] ?? ""))))) return { why: WHY_CMD };
		if (c === "xargs" && args.some((a) => DELETERS.has(prog(a)))) return { why: WHY_CMD };
		if (w.some((x) => prog(x) === "rimraf") || NET_DELETE.test(seg)) return { why: WHY_CMD };
		if (/^(python[\d.]*|py|node|deno|bun)$/.test(c) && args.some((a) => /^(-c|-e|-p|--eval|--print|eval)$/.test(a)) && SCRIPT_DELETE.test(seg)) return { why: WHY_CMD };
		if (!DELETERS.has(c)) continue;
		if (moved) return { why: "a delete after a cd that Ferry cannot follow (more than one folder, a pipe, a variable it does not know)" };
		// -rf, -Recurse, -Path; /s /q only for cmd's own del/rd (elsewhere /c/Users/... is a Git Bash path)
		const isSwitch = (a) => a.startsWith("-") || (/^(del|erase|rd|rmdir)$/.test(c) && /^\/[a-z](:\S*)?$/i.test(a));
		const before = out.length;
		let opts = true;
		const named = [];
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			if (opts && a === "--") opts = false;
			else if (opts && /^-(include|exclude|filter)$/i.test(a)) return { why: "Remove-Item with -Include/-Exclude/-Filter" };
			else if (opts && /^-(erroraction|ea|warningaction|wa|stream)$/i.test(a)) i++;
			else if (opts && isSwitch(a)) continue;
			else named.push(...(c === "rm" || c === "unlink" ? [a] : a.split(","))); // PowerShell: a,b
		}
		for (const t of named) out.push(base && !/^([a-z]:|[\\/~$%])/i.test(t) && !/^\$/.test(t) ? `${base}/${t}` : t);
		if (out.length === before) return { why: "a delete whose target comes from a pipe (ls | Remove-Item)" }; // no target named
	}
	if (out.some((t) => !t || /[`]|\$\(|^\(|[{}]/.test(t) && !/^\$\{\w+\}/.test(t))) return { why: "a delete whose target is built by a command or a brace list" };
	if (!out.length && DELETES.some((re) => re.test(text))) return { why: "a delete inside cmd /c, sh -c ..." };
	return { targets: out };
}

/** The paths a command deletes, as written: [] when it deletes nothing, null when it deletes something it cannot list. */
export function deleteTargets(cmd) {
	const r = deleteTargetsEx(cmd);
	return r.why ? null : r.targets;
}

const ENV_OK = ["TEMP", "TMP", "TMPDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOME"];
/** A known variable's value, or undefined. */
function envValue(name, env) {
	const n = name.toUpperCase();
	if (!ENV_OK.includes(n)) return undefined;
	const got = Object.entries(env).find(([k]) => k.toUpperCase() === n)?.[1];
	if (got) return got;
	if (["TEMP", "TMP", "TMPDIR"].includes(n)) return tmpdir();
	if (["HOME", "USERPROFILE"].includes(n)) return homedir();
	return undefined;
}

/** %TEMP%, $env:TEMP, $TEMP, ${TEMP}, a leading ~: replaced by the real folder. null for any other variable. */
export function expandVars(t, env = process.env) {
	let bad = false;
	let r = t.replace(/%(\w+)%|\$env:(\w+)|\$\{(\w+)\}|\$(\w+)/gi, (_m, a, b, c, d) => {
		const v = envValue(a ?? b ?? c ?? d, env);
		if (v === undefined) bad = true;
		return v ?? "";
	});
	if (bad || /[%$]/.test(r)) return null;
	if (/^~(?=$|[\\/])/.test(r)) r = r.replace(/^~/, homedir());
	return r;
}

const GLOB_CAP = 2000;
const hasGlob = (t) => /[*?[]/.test(t);
const globRe = (seg) => new RegExp(`^${seg.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, WIN ? "i" : "");

/** Everything an absolute path with wildcards matches ([] for none), or null when there are too many to list. */
function globMatches(abs) {
	const parts = abs.split(/[\\/]+/);
	const root = /^[a-z]:$/i.test(parts[0]) ? `${parts.shift()}${sep}` : parts[0] === "" ? (parts.shift(), sep) : "";
	let found = [root || "."];
	let n = 0;
	for (let i = 0; i < parts.length; i++) {
		const seg = parts[i];
		const next = [];
		for (const dir of found) {
			if (seg === "**") { // this folder and everything below it
				const walk = (d) => {
					next.push(d);
					let list = [];
					try {
						list = readdirSync(d, { withFileTypes: true });
					} catch {
						return;
					}
					for (const e of list) {
						if (++n > GLOB_CAP) return;
						if (e.isDirectory() && !e.isSymbolicLink()) walk(join(d, e.name));
					}
				};
				walk(dir);
			} else if (!hasGlob(seg)) next.push(join(dir, seg));
			else {
				let list = [];
				try {
					list = readdirSync(dir);
				} catch {
					continue;
				}
				const re = globRe(seg);
				for (const name of list) if (re.test(name)) next.push(join(dir, name));
			}
			if (n > GLOB_CAP || next.length > GLOB_CAP) return null;
		}
		found = next;
	}
	return found.filter((p) => existsOrLink(p));
}
const existsOrLink = (p) => {
	try {
		lstatSync(p);
		return true;
	} catch {
		return false;
	}
};

/** One delete target as written -> { paths: [absolute...] } or { why }. A pattern becomes the files it matches now. */
export function expandTarget(t, cwd, env = process.env) {
	const v = expandVars(t, env);
	if (v === null) return { why: `${t} uses a variable Ferry does not know` };
	const abs = resolve(cwd, gitBashPath(v));
	if (!hasGlob(v)) return { paths: [abs] };
	const found = globMatches(abs);
	if (found === null) return { why: `${t} matches more than ${GLOB_CAP} files` };
	return { paths: found };
}

/** A new ferry session: in bypass, what it makes may be deleted without asking. */
export const newSession = () => ({ start: Date.now() - 50, made: new Set() }); // file clocks lag Date.now() by a few ms
/**
 * What a conversation made, rebuilt from the records saved with it: { start } first, then { add: [paths] } as files
 * were made. null when there is no record (an older conversation): then only what is made from now on counts.
 */
export function restoreSession(records) {
	let start = Infinity;
	const made = new Set();
	let any = false;
	for (const d of records) {
		if (!d || typeof d !== "object") continue;
		if (Number.isFinite(d.start)) {
			start = Math.min(start, d.start);
			any = true;
		}
		for (const k of Array.isArray(d.add) ? d.add : []) if (typeof k === "string") made.add(k);
	}
	return any ? { start, made } : null;
}
const keyOf = (p) => (WIN ? resolve(p).toLowerCase() : resolve(p));
/** Git Bash writes C:\x as /c/x; on Windows that is what it means */
export const gitBashPath = (t, win = WIN) => (win ? t.replace(/^\/([a-z])(\/|$)/i, "$1:/") : t);

/** Remember a path a file tool is about to create, with the folders it creates for it. */
export function noteCreated(session, abs) {
	const added = [];
	for (let p = resolve(abs); !existsSync(p); p = resolve(p, "..")) {
		session.made.add(keyOf(p));
		added.push(keyOf(p));
		if (p === resolve(p, "..")) break;
	}
	return added;
}

/** True when ferry made this path in this session (born after it started, or created by a file tool) and, for a
 *  folder, everything in it. A path that does not exist yet can only be made by this command. Symlinks: never. */
export function madeThisSession(p, session, budget = { n: 5000 }) {
	if (--budget.n < 0) return false;
	let st;
	try {
		st = lstatSync(p);
	} catch (e) {
		return e.code === "ENOENT";
	}
	if (st.isSymbolicLink()) return false;
	// no birth time (some Linux file systems): only what the file tools noted counts, since ctime changes on every edit
	if (!session.made.has(keyOf(p)) && !(st.birthtimeMs > 0 && st.birthtimeMs >= session.start)) return false;
	return !st.isDirectory() || readdirSync(p).every((e) => madeThisSession(join(p, e), session, budget));
}

/** Why a delete still needs the user (which target, or what could not be listed), or "" when it only deletes what this session made. */
export function unsafeDeleteOf(cmd, cwd, _dirs, session = { start: Infinity, made: new Set() }, env = process.env) {
	const r = deleteTargetsEx(cmd);
	if (r.why) return `deletes something Ferry cannot list: ${r.why}`;
	for (const t of r.targets) {
		const e = expandTarget(t, cwd, env);
		if (e.why) return `deletes something Ferry cannot list: ${e.why}`;
		for (const abs of e.paths) {
			if (!madeThisSession(abs, session)) return `deletes ${abs === resolve(cwd, t) || t === abs ? t : `${abs} (from ${t})`}, which Ferry did not create in this session`;
		}
	}
	return "";
}

// ---------- rules ----------

function globToRegex(glob, pathMode) {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (pathMode && glob[i + 1] === "*") {
				re += ".*";
				i++;
				if (glob[i + 1] === "/") i++;
			} else re += pathMode ? "[^/]*" : ".*";
		} else if (c === "?") re += ".";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`, "i");
}

export function parseRule(rule) {
	const m = /^\s*([\w*-]+)\s*(?:\((.*)\))?\s*$/.exec(rule);
	return m ? { tool: m[1].toLowerCase(), pattern: m[2] } : null;
}

/** Does `rule` cover this call? subject: the command (shell tools) or the project-relative path. */
function ruleMatches(rule, tool, subject) {
	const r = parseRule(rule);
	if (!r) return false;
	const toolOk = r.tool === tool || (NET.has(r.tool) && NET.has(tool)) || (r.tool === "shell" && SHELL.has(tool)) || ((r.tool === "edits" || r.tool === "edit") && EDIT.has(tool))
		|| (r.tool.includes("*") && globToRegex(r.tool, false).test(tool)); // mcp__browser__*
	if (!toolOk) return false;
	if (r.pattern === undefined || r.pattern === "*" || r.pattern === "") return true;
	if (subject === undefined) return false;
	if (NET.has(tool)) { // web_fetch(github.com) covers github.com and its subdomains
		const p = r.pattern.trim().toLowerCase().replace(/^\*\./, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
		return subject === p || subject.endsWith(`.${p}`) || globToRegex(p, false).test(subject);
	}
	return globToRegex(r.pattern.trim(), !SHELL.has(tool)).test(subject.trim());
}

function readRules(file) {
	try {
		const j = JSON.parse(readFileSync(file, "utf8"));
		return { allow: j.allow ?? [], ask: j.ask ?? [], deny: j.deny ?? [] };
	} catch {
		return { allow: [], ask: [], deny: [] };
	}
}

export function projectKeyDir(cwd) {
	const name = basename(cwd).replace(/[^\w.-]+/g, "_").slice(0, 40) || "root";
	const hash = createHash("sha256").update(cwd.toLowerCase()).digest("hex").slice(0, 8);
	return join(FERRY_HOME, "projects", `${name}-${hash}`);
}

export function ruleFiles(cwd) {
	return {
		user: join(FERRY_HOME, "permissions.json"),
		project: join(projectKeyDir(cwd), "permissions.json"),
		team: join(cwd, ".ferry", "permissions.json"),
	};
}

export function loadRules(cwd) {
	const f = ruleFiles(cwd);
	const all = { allow: [], ask: [], deny: [] };
	for (const file of [f.user, f.project, f.team]) {
		const r = readRules(file);
		for (const k of Object.keys(all)) all[k].push(...r[k]);
	}
	return all;
}

export function addRule(cwd, list, rule, scope = "project") {
	const file = ruleFiles(cwd)[scope];
	const r = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	r[list] = [...new Set([...(r[list] ?? []), rule])];
	mkdirSync(join(file, ".."), { recursive: true });
	if (scope === "project") writeFileSync(join(projectKeyDir(cwd), ".folder"), cwd, "utf8");
	writeFileSync(file, JSON.stringify(r, null, 2), "utf8");
	return file;
}

export function removeRule(cwd, list, rule) {
	for (const file of Object.values(ruleFiles(cwd)).slice(0, 2)) {
		if (!existsSync(file)) continue;
		const r = JSON.parse(readFileSync(file, "utf8"));
		if (!(r[list] ?? []).includes(rule)) continue;
		r[list] = r[list].filter((x) => x !== rule);
		writeFileSync(file, JSON.stringify(r, null, 2), "utf8");
		return true;
	}
	return false;
}

// ---------- the decision ----------

function insideProject(cwd, p) {
	if (typeof p !== "string" || !p) return true;
	const abs = resolve(cwd, p);
	const a = WIN ? abs.toLowerCase() : abs;
	const c = WIN ? resolve(cwd).toLowerCase() : resolve(cwd);
	return a === c || a.startsWith(c.endsWith(sep) ? c : c + sep);
}

function relPath(cwd, p) {
	if (typeof p !== "string") return undefined;
	const abs = resolve(cwd, p);
	const rel = relative(cwd, abs);
	return (rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : abs).replace(/\\/g, "/");
}

/**
 * The verdict for one tool call: { action: "allow" | "ask" | "deny", reason, danger, segments }.
 * readOnlyTool(name): extra tools known to only read (from their annotations).
 */
// agent-browser commands that touch the user's private data or accounts: asked every time, in every mode (full access
// and "always allow" rules included), like Claude Code asks before acting with the user's credentials (#8, #10)
const BROWSER_PRIVATE = {
	upload: "uploads files from this computer to a website",
	cookies: "reads or changes the browser's cookies (logins)",
	storage: "reads or changes a site's stored data",
	clipboard: "reads or writes the clipboard",
	state: "saves or loads the browser's logins (cookies and storage) to or from a file",
	auth: "uses saved passwords",
	connect: "connects to another browser (it may be your own, with your logins)",
};
const BROWSER_PRIVATE_FLAGS = /^--(profile|cdp|auto-connect|state|session-name)\b/;

/** Why an agent-browser command needs the user every time, or "". */
export function browserPrivacyOf(cmd) {
	for (const seg of splitCommand(String(cmd ?? ""))) {
		const w = words(seg).filter((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x));
		if (!/^agent-browser(\.exe)?$/i.test(w[0] ?? "")) continue;
		const args = w.slice(1);
		if (args.some((a) => BROWSER_PRIVATE_FLAGS.test(a))) return "uses another browser profile or saved logins";
		const at = args.findIndex((a) => !a.startsWith("-"));
		const sub = (args[at] ?? "").toLowerCase();
		const next = (args[at + 1] ?? "").toLowerCase();
		if (BROWSER_PRIVATE[sub]) return BROWSER_PRIVATE[sub];
		if (sub === "set" && next === "credentials") return "sends a user name and password to a site";
		if (sub === "network" && next === "har") return "records all network traffic, logins included";
	}
	return "";
}

/**
 * The blocked name this text refers to, or "". A blocked name matches a path-like token when it is a whole path segment
 * ("config/.env", "C:\\x\\.ssh\\id_rsa", "secrets/key.pem") or a file name with an extension ("secrets.json",
 * ".env.local"). Plain words do not match: not the "credentials" in {credentials:'include'}, not a sentence in quotes, not
 * a heredoc's body. An unquoted word that is exactly a blocked name still does (cat secrets). That is for command text;
 * the path a file tool is given (read, write, edit, office_read) is blocked when it contains the word anywhere.
 */
export function blockedHit(text, names, isCommand = true) {
	const list = names.map((n) => String(n).toLowerCase()).filter(Boolean);
	if (!list.length) return "";
	const segHit = (tok) => {
		for (const seg of tok.toLowerCase().split(/[\\/]+/)) {
			const n = list.find((b) => seg === b || seg.startsWith(`${b}.`));
			if (n) return n;
		}
		return "";
	};
	if (!isCommand) return list.find((b) => text.toLowerCase().includes(b)) ?? ""; // a tool's path: any path containing the word
	const body = text.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, " ");
	const pathLike = (t) => /[\\/]/.test(t) || /^[.~]/.test(t) || /^[a-z]:/i.test(t) || /\.[a-z0-9]{1,8}$/i.test(t);
	const tokens = []; // [text, quoted]
	let cur = "";
	let quote = "";
	const flush = (q) => {
		if (cur) tokens.push([cur, q]);
		cur = "";
	};
	for (const ch of body) {
		if (quote) {
			if (ch === quote) {
				flush(true);
				quote = "";
			} else if (/[\s,=(){}[\];|&<>]/.test(ch)) flush(true);
			else cur += ch;
		} else if (ch === '"' || ch === "'" || ch === "`") {
			flush(false);
			quote = ch;
		} else if (/[\s,=(){}[\];|&<>]/.test(ch)) flush(false);
		else cur += ch;
	}
	flush(!!quote);
	for (const [raw, quoted] of tokens) {
		const t = raw.replace(/:+$/, "") || raw;
		const hit = (pathLike(raw) || !quoted) && (segHit(raw) || segHit(t));
		if (hit) return hit;
	}
	return "";
}

export function decide({ tool, input = {}, mode, cwd, rules, blockedPaths = [], readOnlyTool = () => false, extraDirs = [], session }) {
	const shell = SHELL.has(tool);
	const target = PATH_TOOLS.has(tool) ? input.path : shell ? input.command : undefined;
	const hit = typeof target === "string" ? blockedHit(target, blockedPaths, shell) : "";
	if (hit) return { action: "deny", reason: "Access to this path is not allowed by local policy", blocked: hit };

	const cmd = shell ? String(input.command ?? "") : "";
	const segments = shell ? splitCommand(cmd) : [];
	const subject = shell ? cmd : NET.has(tool) ? hostOf(input.url) : relPath(cwd, input.path);
	const any = (list) => list.find((r) => (shell ? segments.some((s) => ruleMatches(r, tool, s)) || ruleMatches(r, tool, cmd)
		: ruleMatches(r, tool, subject)));
	const denied = any(rules.deny);
	if (denied) return { action: "deny", reason: `Not allowed by the rule ${denied}` };

	// a site tool is "read only" by its annotation, but which sites it contacts is still the user's choice
	const writes = tool === "office_read" && input.out ? String(input.out) : ""; // batch mode writes .txt files into out
	if (writes && blockedHit(writes, blockedPaths, false)) return { action: "deny", reason: "Access to this path is not allowed by local policy" };
	const readOnly = shell ? segments.every(isReadOnlySegment) : !NET.has(tool) && !writes && (READ_ONLY.has(tool) || readOnlyTool(tool));
	if (mode === "plan" && !readOnly && !NET.has(tool)) {
		return { action: "deny", reason: "Plan mode is on, so only reading and searching are allowed. Finish looking " +
			"around and present your plan. To carry it out, ask the user to leave plan mode with switch_mode (target back), " +
			"or they switch modes with Shift+Tab." };
	}
	// asked every time, even in full access and over allow rules; a "danger" prompt has no "always allow"
	const always = shell ? browserPrivacyOf(cmd) || uploadOf(cmd) : "";
	if (always) return { action: "ask", danger: always, segments, always: true };
	// Deletes, in every mode: what Ferry made in this session goes ahead without asking, wherever it is (project, temp
	// folder, any drive); anything else, or anything that cannot be listed, asks every time (no "always allow")
	if (shell) {
		const t = deleteTargets(cmd);
		if (t === null || t.length) {
			const del = unsafeDeleteOf(cmd, cwd, [cwd, ...extraDirs], session);
			if (del) return { action: "ask", danger: del, segments, always: true };
			if (segments.every((s) => { const x = deleteTargets(s); return (x && x.length) || isReadOnlySegment(s); })) return { action: "allow" };
		}
	}
	if (mode === "bypass") return { action: "allow" };

	const danger = shell ? dangerOf(cmd) : "";
	if (danger) return { action: "ask", danger, segments };
	if (any(rules.ask)) return { action: "ask", segments };
	if (readOnly) return { action: "allow" };

	if (EDIT.has(tool) || writes) {
		if (![cwd, ...extraDirs].some((d) => insideProject(d, resolve(cwd, writes || String(input.path ?? ""))))) return { action: "ask", outside: true };
		if (mode === "acceptEdits" || any(rules.allow)) return { action: "allow" };
		return { action: "ask" };
	}
	if (shell) {
		const ok = (s) => isReadOnlySegment(s) || rules.allow.some((r) => ruleMatches(r, tool, s));
		if (segments.every(ok)) return { action: "allow" };
		return { action: "ask", segments, pending: segments.filter((s) => !ok(s)) };
	}
	if (any(rules.allow)) return { action: "allow" };
	return { action: "ask" };
}
