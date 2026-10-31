// Ferry client configuration: <FERRY_HOME>/config.json (default ~/.ferry, or %USERPROFILE%\.ferry on Windows)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Wire protocol between client and server; the server refuses a different major version with HTTP 426
export const PROTOCOL = "1";
export const FERRY_HOME = process.env.FERRY_HOME ?? join(homedir(), ".ferry");
export const AGENT_DIR = join(FERRY_HOME, "agent");
const CONFIG = join(FERRY_HOME, "config.json");
const MODELS_CACHE = join(FERRY_HOME, "models-cache.json");

export const DEFAULTS = {
	server: "",
	token: "",
	chunkBytes: 512 * 1024,
	// Paths the agent may never read, change or run commands on (substring match, case-insensitive)
	blockedPaths: [".env", ".ssh", "id_rsa", "secrets", "credentials"],
	// Permission mode at start: default (ask before edits and commands), acceptEdits, plan (read-only), bypass.
	// Shift+Tab switches while ferry runs; "always allow" answers are kept as rules (/status shows the files).
	permissionMode: "default",
	// Company proxy, e.g. "http://proxy.corp:8080". Empty = use HTTPS_PROXY / HTTP_PROXY if set.
	proxy: "",
	// Extra headers for every request to the Ferry server, e.g. a Cloudflare Access service token:
	// { "CF-Access-Client-Id": "...", "CF-Access-Client-Secret": "..." }
	headers: {},
	// Agent features (see `ferry config`)
	memory: true, // remember things across conversations, stored in <FERRY_HOME>/memory
	subagents: true, // the task tool: hand searches and side tasks to a subagent with a fresh context
	bigOutputBytes: 8192, // longer command/search output is saved to a file; the model sees start, end and path. 0 = off
	web: "client", // web_fetch / web_search: "client" (this computer's network), "server" (the Ferry server fetches), "off"
	goalBudget: "0", // token budget for /goal, e.g. "2m"; "0" = none (the turn limit still applies)
	goalMaxTurns: 100, // /goal stops after this many turns and reports progress
	updateCheck: true, // once a day, tell you when a newer Ferry is on GitHub
	notify: true, // a beep / Windows notification when a request took longer than notifyAfterSeconds
	notifyAfterSeconds: 30,
	render: true, // web_render: read JavaScript-built pages in a hidden browser (needs Electron: ferry install-electron)
	electronPath: "", // Electron to use for web_render; empty = look in the usual places
	renderWaitMs: 12000, // longest wait for a page in web_render to finish loading
	blockedSites: [], // sites never opened by web_fetch / web_render (and their subdomains), e.g. ["mail.corp.com"]
	browser: false, // let the agent drive a browser on this computer (Edge on Windows) through Playwright MCP
	browserPath: "", // a browser program to use instead of Edge / Chrome
	browserHeadless: false, // run the browser without a window
	thinking: "medium", // how long Claude / GPT think: low, medium, high, xhigh
	trimOldOutputs: "80k", // past this many tokens of context, old long tool outputs are left out ("0" = never)
	maxParallel: 3, // subagents running at the same time (task, task_batch); the rest wait
	phoneNotify: true, // ask the Ferry server to notify your phone (it needs a Bark address on its admin page)
	phoneAfterSeconds: 300, // a request that took this long ends with a phone notification; an approval waits this long
	phoneConsole: true, // report this window's status to the server's phone console (only when the server has it on)
	remoteApprove: false, // let the phone console approve waiting actions (never dangerous ones); stop and deny always work
	contextWindow: {}, // per model, set with /context: { "<model id>": tokens }; missing = the server's size
};

/** The settings worth changing, shown by /config and `ferry config`: key -> [type, explanation, choices?]. */
export const SETTINGS = {
	permissionMode: ["string", "how much the agent may do without asking, when ferry starts (Shift+Tab switches while it runs)",
		["default  ask before changing files and running commands", "acceptEdits  file changes in the project go ahead; commands still ask",
			"auto  like acceptEdits; commands the rules cannot decide are judged by a model on the server, and asked only when unsure",
			"plan  read and search only", "bypass  nothing asks (protected paths stay blocked)"]],
	thinking: ["string", "how long Claude and GPT think before answering: more is better on hard work, but slower and costs more",
		["low", "medium  (default)", "high", "xhigh"]],
	memory: ["boolean", "remember things across conversations (Markdown files on this computer; /memory shows them)"],
	web: ["string", "where web_fetch and web_search run",
		["client  this computer (the company proxy and gateway rules apply)", "server  the Ferry server, if its admin page allows it", "off"]],
	render: ["boolean", "web_render: read pages built by JavaScript in a hidden browser (needs Electron: ferry install-electron)"],
	blockedSites: ["list", "sites the agent may never open with web_fetch / web_render, subdomains included (e.g. your mail, chat and cloud drive)"],
	browser: ["boolean", "let the agent drive a browser on this computer (Edge on Windows): open pages, click, type, read"],
	goalMaxTurns: ["number", "most turns a /goal may take before it stops and reports progress"],
	goalBudget: ["string", "token budget for /goal, e.g. 500k or 2m; 0 = none"],
	notify: ["boolean", "beep and show a Windows notification when a long request is finished"],
	phoneNotify: ["boolean", "phone notifications through the Ferry server (set Bark on its admin page): goal done, long work done, approval waiting"],
	remoteApprove: ["boolean", "let the phone console (the server's /m page) approve actions waiting here; dangerous ones still need this computer"],
	blockedPaths: ["list", "paths the agent may never read, change or use in commands (part of the path is enough)"],
	proxy: ["string", "company proxy for reaching the server, e.g. http://proxy.corp:8080 (empty = HTTPS_PROXY)"],
};

/** Rarely needed; /config lists them under "More settings", `ferry config` accepts them too. */
export const ADVANCED_SETTINGS = {
	subagents: ["boolean", "let the agent hand searches and side tasks to subagents with their own context"],
	bigOutputBytes: ["number", "command/search output longer than this is saved to a file; the model sees start, end and path (0 = off)"],
	notifyAfterSeconds: ["number", "how long a request must take before the notification"],
	updateCheck: ["boolean", "once a day, look on GitHub for a newer Ferry and tell you (nothing is installed by itself)"],
	electronPath: ["string", "Electron for web_render (full path to electron.exe); empty = look in the usual places"],
	renderWaitMs: ["number", "longest wait, in milliseconds, for a page in web_render to finish loading"],
	browserPath: ["string", "a browser program to use instead of Edge / Chrome (full path), empty = Edge / Chrome"],
	browserHeadless: ["boolean", "run that browser without a window"],
	chunkBytes: ["number", "largest single upload to the server, in bytes (the 1 MB rule)"],
	trimOldOutputs: ["string", "once the context is this big (e.g. 80k), old long tool outputs are left out to save tokens; 0 = never"],
	maxParallel: ["number", "how many subagents may run at the same time (task, task_batch); the rest wait"],
	phoneAfterSeconds: ["number", "a request that took at least this long, or an approval waiting this long, notifies the phone"],
	phoneConsole: ["boolean", "show this computer's ferry on the phone console when the server has it on (status only, never files or the conversation)"],
};

/** "400k", "1m", "1.5M", "200000" -> tokens; 0 when it is not a size. */
export function parseTokens(text) {
	const m = /^\s*(\d+(?:\.\d+)?)\s*([km])?\s*$/i.exec(String(text ?? ""));
	if (!m) return 0;
	return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6 }[(m[2] ?? "").toLowerCase()] ?? 1));
}

/** Headers every request to the Ferry server carries. */
export function serverHeaders(cfg, extra = {}) {
	return { "User-Agent": `Ferry/${PROTOCOL}`, ...(cfg.headers ?? {}), "x-ferry-protocol": PROTOCOL,
		...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}), ...extra };
}

/** Route every request (ours and pi's) through the proxy, if one is configured. Call before any fetch. */
export async function applyProxy(cfg) {
	if (cfg.proxy) {
		// An explicit setting wins over whatever the machine has, in both spellings (pi reads them too)
		for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) process.env[k] = cfg.proxy;
	}
	const env = process.env;
	const httpsProxy = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || "";
	const httpProxy = env.http_proxy || env.HTTP_PROXY || httpsProxy;
	if (!httpsProxy) return "";
	// This computer is never reached through a proxy (a local Ferry server lives at 127.0.0.1)
	const noProxy = [env.no_proxy ?? env.NO_PROXY ?? "", "localhost,127.0.0.1,::1"].filter(Boolean).join(",");
	env.NO_PROXY = env.no_proxy = noProxy;
	// Node's built-in fetch ignores proxy variables; undici's EnvHttpProxyAgent honours them and NO_PROXY.
	const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
	setGlobalDispatcher(new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy }));
	return httpsProxy;
}

export const LOCAL_URL = `http://127.0.0.1:${process.env.FERRY_PORT ?? 8787}`;

/** Written by a zero-config ferry-server on this computer: { url, token }. */
export function readLocalServer() {
	try {
		return JSON.parse(readFileSync(join(FERRY_HOME, "local-server.json"), "utf8"));
	} catch {
		return null;
	}
}

/**
 * mode "remote": a server was set with `ferry login` (or FERRY_SERVER).
 * mode "local":  no server set; use the Ferry server on this computer, starting it if needed.
 */
export function loadConfig() {
	const cfg = existsSync(CONFIG) ? { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG, "utf8")) } : { ...DEFAULTS };
	if (process.env.FERRY_SERVER) cfg.server = process.env.FERRY_SERVER;
	if (process.env.FERRY_TOKEN) cfg.token = process.env.FERRY_TOKEN;
	cfg.server = cfg.server.replace(/\/+$/, "");
	if (cfg.server) {
		cfg.mode = "remote";
	} else {
		const local = readLocalServer();
		cfg.mode = "local";
		cfg.server = local?.url ?? LOCAL_URL;
		cfg.token = local?.token ?? "";
	}
	return cfg;
}

export function saveConfig(patch) {
	mkdirSync(FERRY_HOME, { recursive: true });
	const cur = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf8")) : {};
	const next = { ...cur, ...patch };
	for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
	writeFileSync(CONFIG, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
	return CONFIG;
}

export function readModelsCache() {
	try {
		return JSON.parse(readFileSync(MODELS_CACHE, "utf8"));
	} catch {
		return null;
	}
}

export function writeModelsCache(models) {
	mkdirSync(FERRY_HOME, { recursive: true });
	writeFileSync(MODELS_CACHE, JSON.stringify(models), "utf8");
}

/** Where pi would find Bash on Windows (Git for Windows, or bash.exe on PATH). Always true elsewhere. */
export function findBash() {
	if (process.platform !== "win32") return "bash";
	const env = process.env;
	const candidates = [
		env.ProgramFiles && join(env.ProgramFiles, "Git", "bin", "bash.exe"),
		env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
		env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
		...(env.PATH ?? env.Path ?? "").split(";").filter(Boolean).map((d) => join(d, "bash.exe")),
	].filter(Boolean);
	return candidates.find((p) => existsSync(p)) ?? "";
}

/** Make sure pi's agent directory exists with Ferry defaults (the user's own changes are kept). */
export function ensureAgentDir(defaultModel, modelIds = [defaultModel], thinking = "medium") {
	scaffoldHome();
	mkdirSync(join(AGENT_DIR, "extensions"), { recursive: true });
	const file = join(AGENT_DIR, "settings.json");
	const cur = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	// Searching (grep, find, ls) is on by default; Windows without Git Bash runs commands through PowerShell
	const shell = findBash() ? "bash" : "powershell";
	const tools = ["read", shell, "edit", "write", "grep", "find", "ls"];
	const defaults = { defaultProvider: "ferry", defaultModel, enableInstallTelemetry: false, defaultTools: tools };
	const next = { ...defaults, ...cur };
	// lists written by older Ferry versions, which nobody chose by hand: upgrade them
	const old = JSON.stringify(next.defaultTools);
	if (old === JSON.stringify(["read", "powershell", "edit", "write"]) || old === JSON.stringify(["read", "bash", "edit", "write"])) {
		next.defaultTools = tools;
	}
	// the server's model list changed (e.g. a new API key): fall back to its first model
	if (next.defaultProvider === "ferry" && !modelIds.includes(next.defaultModel)) next.defaultModel = defaultModel;
	next.defaultThinkingLevel = ["low", "medium", "high", "xhigh"].includes(thinking) ? thinking : "medium";
	// pressing Esc twice on an empty input opened pi's session tree, which looked like being thrown out; /rewind does that job
	if (!("doubleEscapeAction" in cur)) next.doubleEscapeAction = "none";
	writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
	// Shift+Tab switches the permission mode (like Claude Code); pi uses it for thinking levels, which the
	// server-chosen model does not expose
	const kb = join(AGENT_DIR, "keybindings.json");
	const keys = existsSync(kb) ? JSON.parse(readFileSync(kb, "utf8")) : {};
	if (!("app.thinking.cycle" in keys)) writeFileSync(kb, JSON.stringify({ ...keys, "app.thinking.cycle": [] }, null, 2), "utf8");
}

const HOME_README = `# Ferry: your settings for every project

Put your own things here; they apply in every project. A project's own go in its .ferry folder.

| What | Where |
|---|---|
| Rules the agent always follows (how you like to work, your team's conventions) | AGENTS.md |
| Skills: how to do one kind of task, with notes and scripts | skills/<name>/SKILL.md |
| Your own slash commands | commands/<name>.md |
| Your own subagents | agents/<name>.md |
| Commands that run after edits or when a request is done | hooks.json |
| What may run without asking, what is never allowed | permissions.json |
| MCP servers (or: ferry mcp import) | agent/mcp.json |
| Memory (Ferry writes it; you may edit it) | memory/ |
| Client settings (or: ferry config, /config) | config.json |

Examples of each: https://github.com/wvans123/ferry/tree/main/examples
`;

/** Make the folders for your own skills, commands and subagents, and a README that says what goes where. */
export function scaffoldHome() {
	try {
		for (const d of ["skills", "commands", "agents"]) mkdirSync(join(FERRY_HOME, d), { recursive: true });
		const readme = join(FERRY_HOME, "README.md");
		if (!existsSync(readme)) writeFileSync(readme, HOME_README, "utf8");
	} catch {
		// read-only home: not important
	}
}
