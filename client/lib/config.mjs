// Ferry client configuration: <FERRY_HOME>/config.json (default ~/.ferry, or %USERPROFILE%\.ferry on Windows)
import tls from "node:tls";
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
	web: "client", // web_fetch / web_search on this computer's network; "off" = no web tools
	goalBudget: "0", // token budget for /goal, e.g. "2m"; "0" = none (the turn limit still applies)
	goalMaxTurns: 100, // /goal stops after this many turns and reports progress
	updateCheck: true, // once a day, tell you when a newer Ferry is on GitHub
	notify: true, // a beep / Windows notification when a request took longer than notifyAfterSeconds
	notifyAfterSeconds: 30,
	showModel: true, // the model's name in the footer at the bottom right; false = hidden (/model and /status still show it)
	blockedSites: [], // sites never opened by web_fetch (and their subdomains), e.g. ["mail.corp.com"]
	localSites: [], // sites read only on this computer, never by the Ferry server (the company's intranet), e.g. ["wiki.corp.com"]
	browser: true, // let the agent drive the browser on this computer (Edge on Windows) with agent-browser
	browserPath: "", // a browser program to use instead of Edge / Chrome
	browserHeadless: true, // run the browser without a window; the agent shows one for a login (#8, #10)
	thinking: "medium", // how long Claude / GPT think: low, medium, high, xhigh
	trimOldOutputs: "80k", // past this many tokens of context, old long tool outputs are left out ("0" = never)
	maxParallel: 3, // subagents running at the same time (task, task_batch); the rest wait
	phoneNotify: true, // ask the Ferry server to notify your phone (it needs a Bark address on its admin page)
	phoneAfterSeconds: 300, // a request that took this long ends with a phone notification
	phoneApprovalSeconds: 60, // an approval left unanswered this long notifies the phone (once per question)
	rulesFromParents: false, // also take AGENTS.md / CLAUDE.md from folders above the project (not only the project's own)
	contextWindow: {}, // per model, set with /context: { "<model id>": tokens }; missing = the server's size
	compactAt: "90%", // summarise the conversation once the context is this full (at the end of a request); "off" = only when it must
	compactKeep: "20k", // how much of the latest conversation a summary keeps word for word
	keepImages: 4, // pictures kept in the conversation (the latest ones); older ones become a short note
	systemCerts: true, // also trust the certificates this computer trusts (a company proxy that checks HTTPS has its own)
	caFile: "", // a PEM file with more certificates to trust, e.g. the company proxy's, if the computer's own are not enough
};

/** The settings worth changing, shown by /config and `ferry config`: key -> [type, explanation, choices?]. */
export const SETTINGS = {
	permissionMode: ["string", "how much the agent may do without asking, when ferry starts (Shift+Tab switches while it runs)",
		["default  ask before changing files and running commands", "acceptEdits  file changes in the project go ahead; commands still ask",
			"plan  read and search only", "bypass  nothing asks (protected paths stay blocked)"]],
	compactAt: ["string", "summarise the conversation (compaction) once the context is this full; lower = cheaper requests, earlier summaries",
		["50%", "60%", "70%", "80%", "90%  (default)", "off  only when the model's limit is reached"]],
	thinking: ["string", "how long Claude and GPT think before answering: more is better on hard work, but slower and costs more",
		["low", "medium  (default)", "high", "xhigh"]],
	memory: ["boolean", "remember things across conversations (Markdown files on this computer; /memory shows them)"],
	web: ["string", "web_fetch and web_search, on this computer's network (the company proxy and gateway rules apply)",
		["client  on", "off"]],
	blockedSites: ["list", "sites the agent may never open with web_fetch, subdomains included (e.g. your mail, chat and cloud drive)"],
	localSites: ["list", "sites read only on this computer, never by the Ferry server (the company's intranet; private addresses and names without a dot already are)"],
	browser: ["boolean", "let the agent drive the browser on this computer (Edge on Windows): JavaScript pages, logins, clicking, forms"],
	goalMaxTurns: ["number", "most turns a /goal may take before it stops and reports progress"],
	goalBudget: ["string", "token budget for /goal, e.g. 500k or 2m; 0 = none"],
	notify: ["boolean", "beep and show a Windows notification when a long request is finished"],
	showModel: ["boolean", "show the model's name in the footer at the bottom right (false: hidden; /model and /status still show it)"],
	phoneNotify: ["boolean", "phone notifications through the Ferry server (set Bark on its admin page): goal done, long work done, approval waiting"],
	blockedPaths: ["list", "paths the agent may never read, change or use in commands (part of the path is enough)"],
	proxy: ["string", "company proxy for reaching the server, e.g. http://proxy.corp:8080 (empty = HTTPS_PROXY)"],
};

/** Rarely needed; /config lists them under "More settings", `ferry config` accepts them too. */
export const ADVANCED_SETTINGS = {
	subagents: ["boolean", "let the agent hand searches and side tasks to subagents with their own context"],
	bigOutputBytes: ["number", "command/search output longer than this is saved to a file; the model sees start, end and path (0 = off)"],
	notifyAfterSeconds: ["number", "how long a request must take before the notification"],
	updateCheck: ["boolean", "once a day, look on GitHub for a newer Ferry and tell you (nothing is installed by itself)"],
	browserPath: ["string", "a browser program to use instead of Edge / Chrome (full path), empty = Edge / Chrome"],
	browserHeadless: ["boolean", "run that browser without a window (default); false: always show it, so you see what the agent does"],
	chunkBytes: ["number", "largest single request body sent to the server, in bytes (a bigger commit goes up in parts; gets smaller by itself when the network stops a request)"],
	trimOldOutputs: ["string", "once the context is this big (e.g. 80k), old long tool outputs are left out to save tokens; 0 = never"],
	maxParallel: ["number", "how many subagents may run at the same time (task, task_batch); the rest wait"],
	phoneAfterSeconds: ["number", "a request that took at least this long notifies the phone"],
	phoneApprovalSeconds: ["number", "an approval left unanswered this long notifies the phone, once per question"],
	rulesFromParents: ["boolean", "also put AGENTS.md / CLAUDE.md from folders above the project into the system prompt (off: only Ferry's own and the project's)"],
	compactKeep: ["string", "how much of the latest conversation a summary keeps word for word, e.g. 20k (more = better memory of recent work, bigger requests)"],
	keepImages: ["number", "how many of the latest pictures stay in the conversation; older ones are left out (the agent can read the file again)"],
	systemCerts: ["boolean", "also trust the HTTPS certificates this computer trusts (needed when a company proxy checks HTTPS)"],
	caFile: ["string", "a PEM file with more certificates to trust (full path), e.g. the company proxy's; empty = none"],
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
/**
 * Trust what this computer trusts. Node ships its own list of certificate authorities and ignores the system's,
 * so behind a company proxy that inspects HTTPS (with its own certificate, which the company installs on its
 * computers) every request fails with "self-signed certificate in certificate chain" or "unable to get local issuer
 * certificate", while the browser works. This adds the system's certificates (and caFile, if set) to Node's list;
 * the proxy still sees and checks everything, as it does for the browser.
 */
export function trustCertificates(cfg) {
	try {
		const extra = [];
		if (cfg.systemCerts !== false && typeof tls.getCACertificates === "function") extra.push(...tls.getCACertificates("system"));
		if (cfg.caFile) {
			const pem = readFileSync(cfg.caFile, "utf8");
			extra.push(...(pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []));
		}
		if (!extra.length || typeof tls.setDefaultCACertificates !== "function") return 0;
		const all = new Set([...tls.getCACertificates("default"), ...extra]);
		tls.setDefaultCACertificates([...all]);
		shareCertificates([...all]);
		return extra.length;
	} catch {
		return 0; // an unreadable caFile or an older Node: Node's own list stays
	}
}

/**
 * The same certificates for the agent's commands: curl, git, Python and Node in commands use their own lists too, and
 * fail behind a proxy that inspects HTTPS. Written once to <FERRY_HOME>/ca-bundle.pem and pointed at by the usual
 * variables (only those you have not set yourself); commands inherit them, and the proxy variables, from ferry.
 */
function shareCertificates(pems) {
	try {
		const file = join(FERRY_HOME, "ca-bundle.pem");
		const text = `${pems.map((p) => p.trim()).join("\n")}\n`;
		let old = "";
		try {
			old = readFileSync(file, "utf8");
		} catch {
			// first time
		}
		if (old !== text) {
			mkdirSync(FERRY_HOME, { recursive: true });
			writeFileSync(file, text, "utf8");
		}
		for (const k of ["CURL_CA_BUNDLE", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "GIT_SSL_CAINFO", "NODE_EXTRA_CA_CERTS"]) {
			if (!process.env[k]) process.env[k] = file;
		}
	} catch {
		// cannot write: commands keep their own lists
	}
}

export async function applyProxy(cfg) {
	trustCertificates(cfg);
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

/** Close the connections fetch keeps open (and the proxy agent), so the process can end by itself. */
export async function closeNetwork() {
	try {
		const { getGlobalDispatcher } = await import("undici");
		const d = getGlobalDispatcher();
		await Promise.race([d.close(), new Promise((r) => setTimeout(r, 1000).unref())]);
	} catch {
		// nothing open, or an older undici
	}
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

/** pi providers Ferry registers: "ferry" ("auto" and shared models) and one per provider on the server ("kiro"). */
export const FERRY_PROVIDERS = new Set(["ferry"]);

/** The pi provider a server model (or a cached one) is shown under. */
export const providerOf = (m) => (m && typeof m === "object" && m.provider) || "ferry";

/** A Ferry model by id, whichever provider it is shown under (model ids are unique on the server). */
export function findFerryModel(registry, id) {
	for (const p of FERRY_PROVIDERS) {
		const m = registry?.find?.(p, id);
		if (m) return m;
	}
	return undefined;
}

/** Make sure pi's agent directory exists with Ferry defaults (the user's own changes are kept).
 * models: the server's models (or just ids); the default model is saved with the provider it is shown under. */
export function ensureAgentDir(defaultModel, models = [defaultModel], thinking = "medium", compactKeep = "") {
	const where = new Map(models.map((m) => (typeof m === "string" ? [m, "ferry"] : [m.id, providerOf(m)])));
	scaffoldHome();
	mkdirSync(join(AGENT_DIR, "extensions"), { recursive: true });
	const file = join(AGENT_DIR, "settings.json");
	const cur = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	// Searching (grep, find, ls) is on by default; Windows without Git Bash runs commands through PowerShell
	const shell = findBash() ? "bash" : "powershell";
	const tools = ["read", shell, "edit", "write", "grep", "find", "ls"];
	const defaults = { defaultProvider: where.get(defaultModel) ?? "ferry", defaultModel, enableInstallTelemetry: false, defaultTools: tools };
	const next = { ...defaults, ...cur };
	// lists written by older Ferry versions, which nobody chose by hand: upgrade them
	const old = JSON.stringify(next.defaultTools);
	if (old === JSON.stringify(["read", "powershell", "edit", "write"]) || old === JSON.stringify(["read", "bash", "edit", "write"])) {
		next.defaultTools = tools;
	}
	// one of Ferry's models: keep it under the provider it is shown under now ("ferry/x" saved by 0.31 or older becomes
	// "kiro/x"); gone from the server (e.g. a new API key): fall back to its first model
	if (next.defaultProvider === "ferry" || [...where.values()].includes(next.defaultProvider)) {
		if (!where.has(next.defaultModel)) next.defaultModel = defaultModel;
		next.defaultProvider = where.get(next.defaultModel) ?? "ferry";
	}
	next.defaultThinkingLevel = ["low", "medium", "high", "xhigh"].includes(thinking) ? thinking : "medium";
	// pressing Esc twice on an empty input opened pi's session tree, which looked like being thrown out; /rewind does that job
	if (!("doubleEscapeAction" in cur)) next.doubleEscapeAction = "none";
	// how much of the latest conversation a summary keeps word for word (compactKeep)
	const keep = parseTokens(compactKeep);
	if (keep) next.compaction = { ...(cur.compaction ?? {}), keepRecentTokens: keep };
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
