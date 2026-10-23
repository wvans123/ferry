#!/usr/bin/env node
// Ferry CLI
//   ferry                              start the agent in this folder (all pi options work, e.g. -p "question")
//   ferry doctor                       check the setup step by step
//   ferry login <server-url> <token>   use a Ferry server on another machine
//   ferry logout                       go back to the Ferry server on this computer
//
//   ferry update [file.zip]            install the latest release from GitHub
//   ferry install                      install from an unpacked Ferry folder (release zip or git checkout)
//
// Without `ferry login`, every ferry window starts its own Ferry server on this computer and stops it on exit
// (installed by `ferry install`; the server reads DEEPSEEK_API_KEY from the environment).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	AGENT_DIR,
	applyProxy,
	ensureAgentDir,
	FERRY_HOME,
	findBash,
	loadConfig,
	PROTOCOL,
	readModelsCache,
	saveConfig,
	writeModelsCache,
} from "../lib/config.mjs";
import { APP_ROOT, findPython, install, startLocalServer, update } from "../lib/setup.mjs";

const PKG = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8"));
const VERSION = PKG.version;
const REPO = /github\.com[/:]([^/]+\/[^/.]+)/.exec(PKG.repository?.url ?? "")?.[1] ?? "wvans123/ferry";
const [cmd, ...rest] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(cfg, path, timeoutMs = 8000) {
	const res = await fetch(`${cfg.server}${path}`, {
		headers: { "x-ferry-protocol": PROTOCOL, ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}) },
		signal: AbortSignal.timeout(timeoutMs),
	});
	return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
}

async function healthy(server) {
	try {
		return (await getJson({ server }, "/health", 2000)).status === 200;
	} catch {
		return false;
	}
}

// ---------- the Ferry server on this computer ----------

/** Use a ferry-server someone started by hand on this computer, else start a private one for this window. */
async function ensureServer(cfg) {
	if (cfg.mode === "remote") return;
	if (cfg.token && (await healthy(cfg.server))) {
		const r = await getJson(cfg, "/v1/ferry/models", 5000).catch(() => null);
		if (r?.status === 200) return;
	}
	process.stderr.write("Starting the Ferry server on this computer...\n");
	const { url, token } = await startLocalServer(cfg, healthy);
	cfg.server = url;
	cfg.token = token;
}

// ---------- commands ----------

async function fetchModels(cfg) {
	try {
		const r = await getJson(cfg, "/v1/ferry/models", 5000);
		if (r.status === 200 && r.body.models?.length) {
			cfg.sessionStore = r.body.sessionStore;
			writeModelsCache(r.body.models);
			return r.body.models;
		}
		if (r.status === 401) throw new Error(cfg.mode === "remote" ? "token rejected: run ferry login again"
			: "the local server rejected the saved token: restart it");
	} catch (e) {
		if (e.message.startsWith("token") || e.message.startsWith("the local")) throw e;
		// offline or server down: fall back to the last list we saw
	}
	return readModelsCache() ?? [{ id: "main" }];
}

async function login(server, token) {
	if (!server || !token) {
		console.error("usage: ferry login <server-url> <token>");
		process.exit(2);
	}
	const cfg = { ...loadConfig(), server: server.replace(/\/+$/, ""), token, mode: "remote" };
	await applyProxy(cfg);
	try {
		const r = await getJson(cfg, "/v1/ferry/models");
		if (r.status === 401) throw new Error("the server rejected this token");
		if (r.status === 426) throw new Error(r.body?.error?.message ?? "client and server versions do not match");
		if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
		writeModelsCache(r.body.models);
		console.log(`Connected. Models: ${r.body.models.map((m) => m.id).join(", ")}`);
	} catch (e) {
		console.error(`Could not verify the server (${e.message}). Saved anyway; run "ferry doctor" to investigate.`);
	}
	console.log(`Saved to ${saveConfig({ server: cfg.server, token })}`);
}

function logout() {
	console.log(`Using the Ferry server on this computer again (${saveConfig({ server: undefined, token: undefined })})`);
}

async function doctor() {
	const cfg = loadConfig();
	const ok = (m) => console.log(`  OK    ${m}`);
	const info = (m) => console.log(`  info  ${m}`);
	const bad = (m) => { console.log(`  FAIL  ${m}`); process.exitCode = 1; };
	console.log(`Ferry ${VERSION}, Node ${process.version}, ${process.platform}, settings in ${FERRY_HOME}`);
	const bash = findBash();
	info(`commands run with: ${bash ? `bash (${bash})` : "PowerShell (Git Bash not found)"}`);
	const proxy = await applyProxy(cfg);
	info(`proxy: ${proxy || "none"}${proxy ? `; not used for: ${process.env.NO_PROXY}` : ""}`);
	if (cfg.mode === "remote") {
		const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(cfg.server);
		if (cfg.server.startsWith("https://") || local) ok(`server ${cfg.server} (set with ferry login)`);
		else console.log(`  WARN  server ${cfg.server} uses plain http: your token and code travel unencrypted. Use https.`);
	} else {
		info("no remote server set: using a Ferry server on this computer");
		const py = findPython(cfg);
		if (!py) return bad("the Ferry server is not installed for Python here: run ferry install from the unpacked Ferry folder");
		ok(`server installed for ${py.join(" ")}`);
		try {
			await ensureServer(cfg);
			ok(`server running at ${cfg.server}`);
		} catch (e) {
			return bad(e.message);
		}
	}
	try {
		const t = Date.now();
		const r = await getJson({ server: cfg.server }, "/health");
		if (r.status !== 200) return bad(`health check HTTP ${r.status}`);
		if (r.body.protocol && r.body.protocol !== PROTOCOL) return bad(`server protocol ${r.body.protocol}, client ${PROTOCOL}: update the older side`);
		ok(`server reachable in ${Date.now() - t} ms (server ${r.body.version}, protocol ${r.body.protocol})`);
	} catch (e) {
		return bad(`cannot reach the server: ${e.cause?.code ?? e.message}`);
	}
	try {
		const r = await getJson(cfg, "/v1/ferry/models");
		if (r.status === 401) return bad(cfg.mode === "remote" ? "token rejected: run ferry login again with the token from the server" : "the local server rejected the saved token: restart it");
		if (r.status === 426) return bad(r.body?.error?.message ?? "client and server versions do not match");
		if (r.status !== 200) return bad(`models HTTP ${r.status}`);
		const label = (m) => m.routesTo ? `auto -> ${m.routesTo} (${m.model})${m.summaryTo ? `, summaries -> ${m.summaryTo}` : ""}`
			: `${m.id}${m.model ? ` (${m.model})` : ""}`;
		ok(`token accepted; the server picks the model: ${r.body.models.map(label).join(", ")}`);
		const store = { disk: "cached on disk", memory: "cached in memory only", none: "not kept (full upload every turn)" };
		info(`conversation on the server: ${store[r.body.sessionStore] ?? "cached"}; the full history stays on this computer`);
		for (const m of r.body.models) {
			if (m.ready === false) bad(`model ${m.id} has no API key on the server (for DeepSeek: set DEEPSEEK_API_KEY where ferry-server runs, then restart it)`);
		}
	} catch (e) {
		return bad(`models request failed: ${e.message}`);
	}
	if (rest.includes("--no-model")) return info("skipped asking the models (--no-model)");
	info("asking each model for a two-word answer (a few tokens)...");
	try {
		const res = await fetch(`${cfg.server}/v1/ferry/check`, {
			method: "POST",
			headers: { "x-ferry-protocol": PROTOCOL, Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
			body: "{}",
			signal: AbortSignal.timeout(90000),
		});
		if (res.status === 404) return info("this server is too old to test the models; skipped");
		for (const m of (await res.json()).models) {
			if (/is not set/.test(m.error ?? "")) continue; // already reported above
			if (m.ok) ok(`model ${m.id} (${m.model}) answered in ${m.ms} ms`);
			else bad(`model ${m.id} (${m.model} at ${m.base_url}): ${m.error}\n        ${modelHint(m.error ?? "", cfg)}`);
		}
	} catch (e) {
		bad(`model check failed: ${e.message}`);
	}
}

const KEY_HINT = "one of ANTHROPIC_API_KEY, OPENAI_API_KEY or DEEPSEEK_API_KEY";
const where = (cfg) => cfg.mode === "local"
	? "(Windows: setx NAME value, then open a new cmd window)"
	: "on the server, then restart ferry-server";

/** Turn an upstream error into the next thing to try. */
function modelHint(err, cfg) {
	if (/is not set/.test(err)) return `set it ${where(cfg)}`;
	if (/HTTP 401/.test(err)) return "the API key was rejected: check it has no typo and is still active";
	if (/HTTP 403|region|country|territor/i.test(err)) {
		return "refused: usually the provider does not serve the region the request comes from (Anthropic and OpenAI " +
			"do not serve mainland China or Hong Kong), so run the Ferry server where they do; or the key lacks permission";
	}
	if (/HTTP 402|balance|quota|billing|credit/i.test(err)) return "the account has no credit left: top it up on the provider's site";
	if (/HTTP 404|model/i.test(err)) return "the model name may be wrong: set FERRY_<ID>_MODEL (e.g. FERRY_CLAUDE_MODEL) to a valid name";
	if (/Connect|Timeout|ConnectError|getaddrinfo|ENOTFOUND|ECONN/i.test(err)) {
		return cfg.mode === "local"
			? "this computer cannot reach the provider: if you need the company proxy, setx HTTPS_PROXY http://host:port and open a new cmd window"
			: "the server cannot reach the provider: check its network or proxy (HTTPS_PROXY where ferry-server runs)";
	}
	return "see the error above";
}

async function run(args) {
	const cfg = loadConfig();
	await applyProxy(cfg);
	try {
		await ensureServer(cfg);
		if (!cfg.token) throw new Error('no token: run "ferry login <server-url> <token>" or "ferry logout"');
		var models = await fetchModels(cfg);
	} catch (e) {
		console.error(`Ferry: ${e.message}`);
		process.exit(2);
	}
	if (models[0].ready === false) {
		console.error(`Ferry: no API key for model ${models[0].routesTo ?? models[0].id}. Set ${KEY_HINT} ${where(cfg)}. "ferry doctor" checks the setup.`);
	}
	ensureAgentDir(models[0].id, models.map((m) => m.id));
	process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
	process.env.FERRY_TOKEN = cfg.token;
	// loaded only here, so install / update / doctor work even before the agent's packages are in place
	const { main } = await import("@earendil-works/pi-coding-agent");
	const { createSyncProvider } = await import("../lib/sync.mjs");
	const { createGuard } = await import("../lib/guard.mjs");
	const { createBrand } = await import("../lib/brand.mjs");
	await main(["--offline", ...args], {
		extensionFactories: [
			{ name: "ferry-sync", factory: createSyncProvider(cfg, models) },
			{ name: "ferry-guard", factory: createGuard(cfg) },
			{ name: "ferry-brand", factory: createBrand(cfg, VERSION), hidden: true },
		],
	});
}

const exit = () => process.exit(process.exitCode ?? 0); // also stops a server this window started
if (cmd === "login") await login(rest[0], rest[1]).then(exit);
else if (cmd === "logout") logout();
else if (cmd === "doctor") await doctor().then(exit);
else if (cmd === "install") install(VERSION, rest.includes("--client-only") || undefined);
else if (cmd === "update") {
	await applyProxy(loadConfig());
	await update(VERSION, REPO, rest[0]).catch((e) => {
		console.error(`Update failed: ${e.message}\nYou can download ferry-windows-*.zip from https://github.com/${REPO}/releases yourself and run: ferry update <that zip>`);
		process.exitCode = 1;
	});
	exit();
} else if (cmd === "--version" || cmd === "version") console.log(VERSION);
else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
	console.log(`Ferry ${VERSION}

  ferry                             start the agent in this folder (type your request, Ctrl+C twice to quit)
  ferry -p "question"               one question, answer printed, then exit
  ferry doctor [--no-model]         check the setup step by step, ending with a tiny request to each model
  ferry login <server-url> <token>  use a Ferry server on another machine
  ferry logout                      go back to a Ferry server on this computer
  ferry update [file.zip]           install the latest release from GitHub (or a zip you downloaded)
  ferry install [--client-only]     install from an unpacked Ferry folder (--client-only: no local server)
  ferry --pi-help                   all agent options`);
} else if (cmd === "--pi-help") await run(["--help"]);
else await run(process.argv.slice(2));
