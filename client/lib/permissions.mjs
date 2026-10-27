// Permissions, like Claude Code's permission modes and Codex's approval policies. Everything is decided on this
// computer; the server cannot change it.
//
// Modes (Shift+Tab cycles, the footer shows the current one):
//   default     ask before changing files and before commands that are not read-only
//   acceptEdits file changes inside the project folder go ahead; commands still ask
//   plan        read-only: reading, searching and read-only commands only; the agent presents a plan
//   bypass      nothing asks (blocked paths and deny rules still apply)
//
// Rules: "allow", "ask" and "deny" lists of entries like  bash(git log*)  edit(src/**)  powershell  web_fetch
//   user level      <FERRY_HOME>/permissions.json                      (every project)
//   project, yours  <FERRY_HOME>/projects/<folder>-<hash>/permissions.json   ("always allow" answers go here)
//   project, team   <project>/.ferry/permissions.json                  (read only; can be committed to the repo)
// deny beats ask beats allow. Read-only commands (git status, dir, ls, rg...) are allowed without a rule;
// dangerous ones (rm -rf, git push --force, ...) always ask unless the mode is bypass.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const EDIT = new Set(["edit", "write"]);
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
// tools that only look, or that are fenced in by themselves (memory: its own folder; task: the subagent's
// tools are checked one by one; web_*: the server's own allow list)
const READ_ONLY = new Set(["read", "grep", "find", "ls", "todo", "history_search", "memory", "task", "web_search"]);
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
	if (SAFE_ANY_ARGS.has(cmd)) return true;
	if (cmd === "find") return !args.some((a) => /^-(exec|execdir|delete|ok|fprint)/.test(a));
	if (cmd === "sed") return !args.some((a) => /^-[a-z]*i/.test(a) || a.startsWith("--in-place"));
	if (VERSION_ONLY.has(cmd) && args.length === 1 && /^(-v|--version|-V|version)$/.test(args[0])) return true;
	if (cmd === "git") {
		const sub = args.find((a) => !a.startsWith("-")) ?? "";
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
	const toolOk = r.tool === tool || (r.tool === "shell" && SHELL.has(tool)) || (r.tool === "edits" && EDIT.has(tool))
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
export function decide({ tool, input = {}, mode, cwd, rules, blockedPaths = [], readOnlyTool = () => false }) {
	const shell = SHELL.has(tool);
	const target = PATH_TOOLS.has(tool) ? input.path : shell ? input.command : undefined;
	const low = typeof target === "string" ? target.toLowerCase() : "";
	const hit = low && blockedPaths.map((p) => p.toLowerCase()).find((p) => low.includes(p));
	if (hit) return { action: "deny", reason: "Access to this path is not allowed by local policy", blocked: hit };

	const cmd = shell ? String(input.command ?? "") : "";
	const segments = shell ? splitCommand(cmd) : [];
	const subject = shell ? cmd : NET.has(tool) ? hostOf(input.url) : relPath(cwd, input.path);
	const any = (list) => list.find((r) => (shell ? segments.some((s) => ruleMatches(r, tool, s)) || ruleMatches(r, tool, cmd)
		: ruleMatches(r, tool, subject)));
	const denied = any(rules.deny);
	if (denied) return { action: "deny", reason: `Not allowed by the rule ${denied}` };

	const readOnly = shell ? segments.every(isReadOnlySegment) : READ_ONLY.has(tool) || readOnlyTool(tool);
	if (mode === "plan" && !readOnly && !NET.has(tool)) {
		return { action: "deny", reason: "Plan mode is on, so only reading and searching are allowed. Finish looking " +
			"around, then present your plan; the user switches modes (Shift+Tab) when it should be carried out." };
	}
	if (mode === "bypass") return { action: "allow" };

	const danger = shell ? dangerOf(cmd) : "";
	if (danger) return { action: "ask", danger, segments };
	if (any(rules.ask)) return { action: "ask", segments };
	if (readOnly) return { action: "allow" };

	if (EDIT.has(tool)) {
		if (!insideProject(cwd, input.path)) return { action: "ask", outside: true };
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
