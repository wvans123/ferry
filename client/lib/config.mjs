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
	// Tools that need a yes in the terminal before they run
	approve: ["write", "edit", "bash", "powershell"],
	// Company proxy, e.g. "http://proxy.corp:8080". Empty = use HTTPS_PROXY / HTTP_PROXY if set.
	proxy: "",
	// Extra headers for every request to the Ferry server, e.g. a Cloudflare Access service token:
	// { "CF-Access-Client-Id": "...", "CF-Access-Client-Secret": "..." }
	headers: {},
};

/** Headers every request to the Ferry server carries. */
export function serverHeaders(cfg, extra = {}) {
	return { ...(cfg.headers ?? {}), "x-ferry-protocol": PROTOCOL,
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
export function ensureAgentDir(defaultModel, modelIds = [defaultModel]) {
	mkdirSync(join(AGENT_DIR, "extensions"), { recursive: true });
	const file = join(AGENT_DIR, "settings.json");
	const cur = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	const defaults = { defaultProvider: "ferry", defaultModel, enableInstallTelemetry: false };
	// Windows without Git Bash: let the model run commands through PowerShell instead of a missing bash
	if (!findBash()) defaults.defaultTools = ["read", "powershell", "edit", "write"];
	const next = { ...defaults, ...cur };
	// the server's model list changed (e.g. a new API key): fall back to its first model
	if (next.defaultProvider === "ferry" && !modelIds.includes(next.defaultModel)) next.defaultModel = defaultModel;
	writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
}
