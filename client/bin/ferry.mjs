#!/usr/bin/env node
// Ferry CLI
//   ferry                              start the agent in this folder (all pi options work, e.g. -p "question")
//   ferry doctor                       check the setup step by step
//   ferry login <server-url> <token> [--header "Name: value"]...   use a Ferry server on another machine
//   ferry logout                       go back to the Ferry server on this computer
//   ferry config [set <key> <value>]   show or change the client settings (memory, subagents, approvals...)
//   ferry install-electron             put Electron into <FERRY_HOME>/electron, for web_render
//
//   ferry update [file.zip]            install the latest release from GitHub
//   ferry install                      install from an unpacked Ferry folder (release zip or git checkout)
//
// Without `ferry login`, every ferry window starts its own Ferry server on this computer and stops it on exit
// (installed by `ferry install`; the server reads DEEPSEEK_API_KEY from the environment).
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AGENT_DIR,
	applyProxy,
	ensureAgentDir,
	FERRY_HOME,
	findBash,
	loadConfig,
	PROTOCOL,
	readModelsCache,
	serverHeaders,
	SETTINGS,
	ADVANCED_SETTINGS,
	saveConfig,
	writeModelsCache,
} from "../lib/config.mjs";
import { APP_ROOT, findPython, install, startLocalServer, update } from "../lib/setup.mjs";
import { BIN_DIR, installBundled, toolStatus } from "../lib/toolbins.mjs";
import { gatewayOf, waitThroughGateway, whoAnswered } from "../lib/gateway.mjs";

const PKG = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8"));
const VERSION = PKG.version;
const PI_VERSION = (() => {
	try {
		return JSON.parse(readFileSync(join(APP_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8")).version;
	} catch {
		return "not installed";
	}
})();
const REPO = /github\.com[/:]([^/]+\/[^/.]+)/.exec(PKG.repository?.url ?? "")?.[1] ?? "wvans123/ferry";
const [cmd, ...rest] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(cfg, path, timeoutMs = 8000) {
	const res = await fetch(`${cfg.server}${path}`, {
		headers: serverHeaders(cfg),
		redirect: "manual", // a login page in front of the server (e.g. Cloudflare Access) shows up as a redirect
		signal: AbortSignal.timeout(timeoutMs),
	});
	const json = res.headers.get("content-type")?.includes("json");
	return { status: res.status, location: res.headers.get("location") ?? "", json, headers: res.headers,
		body: json ? await res.json() : await res.text() };
}

/** Something other than Ferry answered (a login page, a proxy error page): say what, and what to do. */
function notFerry(r) {
	const page = `${r.location} ${typeof r.body === "string" ? r.body.slice(0, 3000) : ""}`;
	if (/cloudflareaccess|cf-access|Cloudflare Access/i.test(page)) {
		return "a Cloudflare Access login page answered instead of the Ferry server. Either remove the Access policy from " +
			"this hostname (the Ferry token already protects it), or create an Access service token and run:\n" +
			"        ferry login <url> <token> --header \"CF-Access-Client-Id: ...\" --header \"CF-Access-Client-Secret: ...\"";
	}
	const gw = gatewayOf(r);
	if (gw) {
		return `the company network gateway wants a confirmation first (${gw}). Run ferry: it opens that page in your ` +
			"browser and continues once you confirm. If the gateway does not allow confirming, ask IT to allow the server address.";
	}
	if (r.status >= 300 && r.status < 400) return `the server address redirects to ${r.location || "another page"}; use the final https address`;
	return whoAnswered(r);
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

async function fetchModels(cfg, waited = false) {
	try {
		const r = await getJson(cfg, "/v1/ferry/models", 5000);
		const gw = !r.json && gatewayOf(r);
		if (gw && !waited) {
			const through = await waitThroughGateway(gw, cfg.server,
				async () => (await getJson(cfg, "/v1/ferry/models", 5000).catch(() => null))?.json === true);
			if (through) return fetchModels(cfg, true);
		}
		if (!r.json) throw new Error(`${notFerry(r)}\n  (run "ferry doctor" for details)`);
		if (r.status === 200 && r.body.models?.length) {
			cfg.sessionStore = r.body.sessionStore;
			cfg.features = r.body.features ?? [];
			cfg.serverWeb = r.body.web === true;
			writeModelsCache(r.body.models);
			return r.body.models;
		}
		if (r.status === 401) throw new Error(cfg.mode === "remote" ? "token rejected: run ferry login again"
			: "the local server rejected the saved token: restart it");
	} catch (e) {
		if (/^(token|the local|a Cloudflare|the server address|the company|HTTP \d)/.test(e.message)) throw e;
		// offline or server down: fall back to the last list we saw
	}
	return readModelsCache() ?? [{ id: "main" }];
}

async function login(args) {
	const headers = {};
	const pos = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--header" && args[i + 1]?.includes(":")) {
			const h = args[++i];
			headers[h.slice(0, h.indexOf(":")).trim()] = h.slice(h.indexOf(":") + 1).trim();
		} else pos.push(args[i]);
	}
	const [server, token] = pos;
	if (!server || !token) {
		console.error('usage: ferry login <server-url> <token> [--header "Name: value"]...');
		process.exit(2);
	}
	const cfg = { ...loadConfig(), server: server.replace(/\/+$/, ""), token, headers, mode: "remote" };
	await applyProxy(cfg);
	try {
		const r = await getJson(cfg, "/v1/ferry/models");
		if (r.status === 401) throw new Error("the server rejected this token");
		if (r.status === 426) throw new Error(r.body?.error?.message ?? "client and server versions do not match");
		if (!r.json) throw new Error(notFerry(r));
		if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
		writeModelsCache(r.body.models);
		console.log(`Connected. Models: ${r.body.models.map((m) => m.id).join(", ")}`);
	} catch (e) {
		console.error(`Could not verify the server (${e.message}). Saved anyway; run "ferry doctor" to investigate.`);
	}
	console.log(`Saved to ${saveConfig({ server: cfg.server, token, headers })}`);
}

function logout() {
	console.log(`Using the Ferry server on this computer again (${saveConfig({ server: undefined, token: undefined })})`);
}

/** `ferry doctor --upload`: send plain filler text of growing sizes, to see what the network in between lets through. */
async function uploadTest(cfg, ok, bad, info) {
	info("upload test: plain filler text, thrown away by the server");
	let biggest = 0;
	for (const kb of [16, 64, 256, 512, 900]) {
		const body = "ferry upload test ".repeat(Math.ceil((kb * 1024) / 18)).slice(0, kb * 1024);
		try {
			const res = await fetch(`${cfg.server}/v1/ferry/probe`, { method: "POST", body, redirect: "manual",
				headers: serverHeaders(cfg, { "Content-Type": "application/octet-stream" }), signal: AbortSignal.timeout(60000) });
			if (res.status === 404) return info("this server is too old for the upload test (update it)");
			const json = res.headers.get("content-type")?.includes("json");
			if (res.ok && json) {
				ok(`${kb} KB gets through`);
				biggest = kb;
				continue;
			}
			bad(`${kb} KB: ${json ? `HTTP ${res.status} from the Ferry server` : whoAnswered({ status: res.status, headers: res.headers, body: await res.text() })}`);
		} catch (e) {
			bad(`${kb} KB: ${e.cause?.code ?? e.message}`);
		}
		break;
	}
	if (biggest && biggest < 900) {
		info(`bigger requests are stopped on the way. Ferry splits uploads into ${cfg.chunkBytes / 1024} KB parts; make them smaller: ` +
			`ferry config set chunkBytes ${Math.max(8, biggest / 2) * 1024}`);
	} else if (biggest === 900) {
		info("sizes are not the problem. If requests are still stopped, something in the way objects to what they contain " +
			"(a company content filter): ask IT. Ferry does not disguise what it sends.");
	}
}

async function doctor() {
	const cfg = loadConfig();
	const ok = (m) => console.log(`  OK    ${m}`);
	const info = (m) => console.log(`  info  ${m}`);
	const bad = (m) => { console.log(`  FAIL  ${m}`); process.exitCode = 1; };
	console.log(`Ferry ${VERSION} (agent engine pi ${PI_VERSION}), Node ${process.version}, ${process.platform}, settings in ${FERRY_HOME}`);
	const bash = findBash();
	info(`commands run with: ${bash ? `bash (${bash})` : "PowerShell (Git Bash not found)"}`);
	installBundled(APP_ROOT);
	const tools = toolStatus();
	const missing = Object.keys(tools).filter((k) => !tools[k]);
	if (missing.length) {
		console.log(`  WARN  ${missing.join(" and ")} not found: the agent's file search tools need them. Install from the release ` +
			`zip (it includes them), or run ferry install from your checkout with internet access, or put ${missing.map((m) => m + (process.platform === "win32" ? ".exe" : "")).join(" and ")} into ${BIN_DIR}`);
	} else ok(`search tools: fd and rg (${[...new Set(Object.values(tools))].map((v) => v === "agent" ? BIN_DIR : "on PATH").join(", ")})`);
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
		const r = await getJson({ server: cfg.server, headers: cfg.headers }, "/health");
		if (!r.json) return bad(notFerry(r));
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
		if (!r.json) return bad(notFerry(r));
		if (r.status !== 200) return bad(`models HTTP ${r.status}`);
		const label = (m) => m.routesTo ? `auto -> ${m.routesTo} (${m.model})${m.summaryTo ? `, summaries -> ${m.summaryTo}` : ""}`
			: `${m.id}${m.model ? ` (${m.model})` : ""}`;
		ok(`token accepted; the server picks the model: ${r.body.models.map(label).join(", ")}`);
		const store = { disk: "cached on disk", memory: "cached in memory only", none: "not kept (full upload every turn)" };
		info(`conversation on the server: ${store[r.body.sessionStore] ?? "cached"}; the full history stays on this computer`);
		const webSetting = cfg.web ?? "client";
		info(webSetting === "server" ? (r.body.web ? "web tools: on the server" : "web tools: set to run on the server, but the server has web access off")
			: webSetting === "off" ? "web tools: off" : "web tools: on this computer, through its normal network (ferry config set web server|off to change)");
		if (webSetting === "client" || webSetting === true || cfg.web === undefined) {
			const { electronFor } = await import("../lib/render.mjs");
			const el = cfg.render === false ? "" : electronFor(cfg);
			info(cfg.render === false ? "web_render: off" : el ? `web_render: on (Electron at ${el})`
				: "web_render: off, Electron not found (ferry install-electron, or ferry config set electronPath <electron.exe>)");
			if (cfg.blockedSites?.length) info(`blocked sites: ${cfg.blockedSites.join(", ")}`);
		}
		for (const m of r.body.models) {
			if (m.ready === false) bad(`model ${m.id} has no API key on the server (for DeepSeek: set DEEPSEEK_API_KEY where ferry-server runs, then restart it)`);
		}
	} catch (e) {
		return bad(`models request failed: ${e.message}`);
	}
	if (rest.includes("--upload")) await uploadTest(cfg, ok, bad, info);
	if (rest.includes("--no-model") || rest.includes("--upload")) return info("skipped asking the models");
	info("asking each model for a two-word answer (a few tokens)...");
	try {
		const res = await fetch(`${cfg.server}/v1/ferry/check`, {
			method: "POST",
			headers: serverHeaders(cfg, { "Content-Type": "application/json" }),
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

/** Arguments as pi should see them: Ferry's own models in --list-models, and under Paperclip, Ferry's tools kept. */
function piArgs(args, env = process.env) {
	const out = [...args];
	const lm = out.indexOf("--list-models");
	if (lm >= 0 && (!out[lm + 1] || out[lm + 1].startsWith("-"))) out.splice(lm + 1, 0, "ferry"); // not pi's whole catalog
	if (env.PAPERCLIP_RUN_ID) { // Paperclip's pi adapter allows only pi's seven tools; Ferry's guard decides instead
		const t = out.findIndex((a) => a === "--tools" || a === "-t");
		if (t >= 0) out.splice(t, 2);
	}
	return out;
}

async function run(args) {
	args = piArgs(args);
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
	ensureAgentDir(models[0].id, models.map((m) => m.id), cfg.thinking);
	installBundled(APP_ROOT); // fd and rg from the release zip, after an update
	process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
	process.env.FERRY_TOKEN = cfg.token;
	// commands the agent runs: Python prints UTF-8 instead of the Windows code page (GBK on Chinese Windows)
	process.env.PYTHONIOENCODING ??= "utf-8";
	process.env.PYTHONUTF8 ??= "1";
	// loaded only here, so install / update / doctor work even before the agent's packages are in place
	const { main } = await import("@earendil-works/pi-coding-agent");
	await (await import("../lib/trim.mjs")).trimPi(); // a shorter "/" list
	const { createSteer, installSteerKeys } = await import("../lib/steer.mjs");
	await installSteerKeys(); // Enter on an empty line while the agent works: interrupt now
	const { createTitle, installTitle } = await import("../lib/title.mjs");
	await installTitle(); // the tab title: conversation · project · Ferry
	const { createSyncProvider } = await import("../lib/sync.mjs");
	const { createGuard, createModes, _state: permState } = await import("../lib/guard.mjs");
	const { createTeam } = await import("../lib/team.mjs");
	const { createBrand } = await import("../lib/brand.mjs");
	const { createMemory } = await import("../lib/memory.mjs");
	const { createPrompt } = await import("../lib/prompt.mjs");
	const { createTodo, createBigOutputs, createHistorySearch, createPastConversations, createTrimOldOutputs, todoText } = await import("../lib/tools.mjs");
	const { createSubagents, discoverAgents } = await import("../lib/subagent.mjs");
	const { createCommands } = await import("../lib/commands.mjs");
	const { createCheckpoints } = await import("../lib/checkpoint.mjs");
	const { createHooks } = await import("../lib/hooks.mjs");
	const { createGoal } = await import("../lib/goal.mjs");
	const { createJobs } = await import("../lib/jobs.mjs");
	const { createProjectMcp } = await import("../lib/mcp.mjs");
	const { webMode } = await import("../lib/web.mjs");
	const { electronFor } = await import("../lib/render.mjs");
	const status = async () => {
		const t = Date.now();
		const h = await getJson({ server: cfg.server, headers: cfg.headers }, "/health", 5000).catch((e) => ({ error: e }));
		const m = models[0];
		return [
			`Ferry ${VERSION} (agent engine pi ${PI_VERSION})`,
			`Server: ${cfg.mode === "local" ? "on this computer" : cfg.server}  ${h.json ? `reachable in ${Date.now() - t} ms, version ${h.body.version}`
				: `NOT reachable (${h.error?.cause?.code ?? h.error?.message ?? `HTTP ${h.status}`})`}`,
			`Model: chosen by the server${m.routesTo ? `: ${m.routesTo} (${m.model})` : ""}`,
			`Web tools: ${webMode(cfg) || "off"}   web_render: ${webMode(cfg) === "client" && electronFor(cfg) ? "on" : "off"}   Browser: ${cfg.browser ? "on" : "off"}   Memory: ${cfg.memory === false ? "off" : "on"}   Subagents: ${cfg.subagents === false ? "off" : "on"}`,
		];
	};
	const { createWeb } = await import("../lib/web.mjs");
	const { createBrowser } = await import("../lib/browser.mjs");
	const sync = createSyncProvider(cfg, models);
	cfg.phone = (await import("../lib/phone.mjs")).phoneNotifier(cfg);
	// auto mode: a model on the server judges actions the rules cannot decide
	cfg.judge = async (action) => {
		const res = await fetch(`${cfg.server}/v1/ferry/judge`, { method: "POST", body: JSON.stringify(action),
			headers: serverHeaders(cfg, { "Content-Type": "application/json" }), signal: AbortSignal.timeout(30000) });
		return res.ok && res.headers.get("content-type")?.includes("json") ? res.json() : null;
	};
	// an approval left waiting: tell the phone after a while
	let waitTimer = null;
	permState.onAsk = (tool) => {
		clearTimeout(waitTimer);
		waitTimer = setTimeout(() => cfg.phone("Waiting for your approval", tool, "approval"), (cfg.phoneAfterSeconds ?? 300) * 1000);
		waitTimer.unref?.();
	};
	permState.onAnswered = () => clearTimeout(waitTimer);
	// on exit pi prints "To resume this session: pi --session <id>"; with Ferry it is ferry --session <id>
	const write = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk, ...rest) => write(typeof chunk === "string" && chunk.includes("To resume this session:")
		? chunk.replace(/\bpi(?= --session)/g, "ferry") : chunk, ...rest);
	await main(["--offline", ...args], {
		extensionFactories: [
			{ name: "ferry-sync", factory: sync, hidden: true },
			{ name: "ferry-prompt", factory: createPrompt(), hidden: true },
			{ name: "ferry-steer", factory: createSteer(), hidden: true }, // before the guard: skipped calls are not asked about
			{ name: "ferry-modes", factory: createModes(cfg), hidden: true },
			{ name: "ferry-guard", factory: createGuard(cfg), hidden: true },
			{ name: "ferry-checkpoints", factory: createCheckpoints(), hidden: true },
			{ name: "ferry-goal", factory: createGoal(cfg), hidden: true },
			{ name: "ferry-jobs", factory: createJobs({ todoText }), hidden: true },
			{ name: "ferry-hooks", factory: createHooks(), hidden: true },
			{ name: "ferry-commands", factory: createCommands(cfg, { status, mode: () => permState.mode, agents: discoverAgents,
				doctor: () => new Promise((done) => {
					execFile(process.execPath, [fileURLToPath(import.meta.url), "doctor", "--no-model"], { timeout: 120000, windowsHide: true },
						(_e, out, err) => done(`${out}${err}`.trim()));
				}),
				reregister: (pi, c) => sync.register(pi, c),
				serverWindow: (id) => models.find((m) => m.id === id)?.contextWindow }), hidden: true },
			{ name: "ferry-memory", factory: createMemory(cfg), hidden: true },
			{ name: "ferry-todo", factory: createTodo(), hidden: true },
			{ name: "ferry-big-outputs", factory: createBigOutputs(cfg), hidden: true },
			{ name: "ferry-history", factory: createHistorySearch(), hidden: true },
			{ name: "ferry-past", factory: createPastConversations(), hidden: true },
			{ name: "ferry-trim", factory: createTrimOldOutputs(cfg), hidden: true },
			{ name: "ferry-office", factory: (await import("../lib/office.mjs")).createOffice(), hidden: true },
			{ name: "ferry-web", factory: createWeb(cfg), hidden: true },
			{ name: "ferry-browser", factory: createBrowser(cfg), hidden: true },
			{ name: "ferry-project-mcp", factory: createProjectMcp(), hidden: true },
			{ name: "ferry-subagents", factory: createSubagents(cfg, {
				makeSync: () => createSyncProvider(cfg, models, { purpose: "subagent" }) }), hidden: true },
			{ name: "ferry-brand", factory: createBrand(cfg, VERSION, newerRelease(cfg)), hidden: true },
			{ name: "ferry-title", factory: createTitle(permState), hidden: true },
			{ name: "ferry-team", factory: createTeam(), hidden: true },
		],
	});
}

/** The newest release on GitHub when it is newer than this one, checked at most once a day, quietly. */
async function newerRelease(cfg) {
	if (cfg.updateCheck === false || process.env.FERRY_NO_UPDATE_CHECK) return "";
	const file = join(FERRY_HOME, "update-check.json");
	let last = {};
	try {
		last = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		// first time
	}
	let latest = last.latest ?? "";
	if (!last.at || Date.now() - last.at > 86400_000) {
		try {
			const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
				headers: { "User-Agent": `ferry/${VERSION}`, Accept: "application/vnd.github+json" }, redirect: "manual",
				signal: AbortSignal.timeout(4000) });
			if (r.ok) latest = String((await r.json()).tag_name ?? "").replace(/^v/, "");
		} catch {
			// offline or blocked: try again tomorrow
		}
		try {
			writeFileSync(file, JSON.stringify({ at: Date.now(), latest }), "utf8");
		} catch {
			// not important
		}
	}
	const n = (v) => v.split(".").map((x) => parseInt(x, 10) || 0);
	const [a, b] = [n(latest || "0"), n(VERSION)];
	for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0) ? latest : "";
	return "";
}

/** `ferry config`: show the client settings; `ferry config set <key> <value>` changes one. */
function config(args) {
	const cfg = loadConfig();
	if (args[0] === "set") {
		const [, key, ...vals] = args;
		const spec = SETTINGS[key] ?? ADVANCED_SETTINGS[key];
		if (!spec) {
			console.error(`unknown setting "${key}". Settings: ${[...Object.keys(SETTINGS), ...Object.keys(ADVANCED_SETTINGS)].join(", ")}`);
			return process.exit(2);
		}
		const raw = vals.join(" ").trim();
		let value;
		if (spec[0] === "boolean") {
			if (!/^(true|false|on|off|yes|no|1|0)$/i.test(raw)) return console.error(`${key} is true or false`), process.exit(2);
			value = /^(true|on|yes|1)$/i.test(raw);
		} else if (spec[0] === "number") {
			value = Number(raw);
			if (!Number.isFinite(value) || value < 0) return console.error(`${key} is a number`), process.exit(2);
		} else if (spec[0] === "list") {
			value = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
		} else value = raw;
		const choices = spec[2]?.map((c) => c.split(" ")[0]);
		if (choices && !choices.includes(value)) {
			console.error(`${key} is one of: ${choices.join(", ")}`);
			return process.exit(2);
		}
		const file = saveConfig({ [key]: value });
		console.log(`${key} = ${JSON.stringify(value)}  (saved to ${file}; applies to the next ferry you start)`);
		return;
	}
	console.log(`Ferry ${VERSION} client settings (${join(FERRY_HOME, "config.json")})\n`);
	console.log(`  server            ${cfg.mode === "remote" ? cfg.server : "a Ferry server on this computer"}  (ferry login / logout)`);
	const all = args[0] === "--all";
	for (const [k, [, why, choices]] of Object.entries(all ? { ...SETTINGS, ...ADVANCED_SETTINGS } : SETTINGS)) {
		const one = choices ? `${why} (${choices.map((c) => c.split(" ")[0]).join(" | ")})` : why;
		console.log(`  ${k.padEnd(17)} ${JSON.stringify(cfg[k])}\n  ${"".padEnd(17)} ${one}`);
	}
	if (Object.keys(cfg.contextWindow ?? {}).length) console.log(`  contextWindow     ${JSON.stringify(cfg.contextWindow)}  (set with /context inside ferry)`);
	console.log(`\nChange one:  ferry config set memory false   |   ferry config set permissionMode acceptEdits`);
	if (!all) console.log("Rarely needed settings: ferry config --all");
	console.log(`Permission rules ("always allow" answers): ${join(FERRY_HOME, "permissions.json")} and .ferry/ in each project`);
	console.log(`Rules for every project: ${join(AGENT_DIR, "AGENTS.md")}   |   rules for one project: AGENTS.md in its folder`);
}

/** `ferry mcp`: list, import from other apps, and (through pi) add, remove, check and sign in. */
async function mcp(args) {
	const m = await import("../lib/mcp.mjs");
	const [sub = "list", ...more] = args;
	if (sub === "list") return console.log(m.listText());
	if (sub === "import") {
		const force = more.includes("--force");
		const names = more.filter((a) => a !== "--force");
		const apps = m.otherApps();
		const sources = names.length
			? names.map((n) => apps.find(([a]) => a === n.toLowerCase()) ?? [n, n])
			: apps.filter(([, f]) => existsSync(f));
		if (!sources.length) {
			console.log(`No MCP settings found from: ${apps.map(([a]) => a).join(", ")}.
Give a file instead: ferry mcp import <path to mcp.json>`);
			return;
		}
		const missing = sources.filter(([, f]) => !existsSync(f));
		for (const [n, f] of missing) console.log(`${n}: no file at ${f}`);
		const r = m.importServers(sources.filter(([, f]) => existsSync(f)), { force });
		for (const [n, from] of r.added) console.log(`added    ${n}  (from ${from})`);
		for (const [n, why] of r.skipped) console.log(`skipped  ${n}: ${why}`);
		console.log(r.added.length ? `\nSaved to ${r.file}. Start ferry and type /mcp to see them connect.` : "\nNothing added.");
		return;
	}
	if (["add", "remove", "check", "login", "logout"].includes(sub)) {
		ensureAgentDir((readModelsCache() ?? [{ id: "auto" }])[0].id);
		process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
		await applyProxy(loadConfig());
		const { main } = await import("@earendil-works/pi-coding-agent");
		return main(["mcp", sub === "check" ? "list" : sub, ...more]);
	}
	console.log(`usage:
  ferry mcp list                      the servers Ferry uses here, and from which file
  ferry mcp import [app|file] [--force]
                                      copy servers from Claude Desktop, Claude Code, Cursor, VS Code or Windsurf
                                      (no name: from every app that has some), or from an mcp.json file
  ferry mcp add <name> -- <command> [args...]    or: ferry mcp add <name> --url <https://...>
  ferry mcp remove <name>
  ferry mcp check                     connect to each server and list its tools
  ferry mcp login <name>              sign in to a server that uses OAuth
Files: ${m.USER_MCP()} (yours), .ferry/mcp.json or .mcp.json in a project (asked once before use)`);
}

const exit = () => process.exit(process.exitCode ?? 0); // also stops a server this window started
if (cmd === "login") await login(rest).then(exit);
else if (cmd === "logout") logout();
else if (cmd === "config") config(rest);
else if (cmd === "pkg") { // pi packages: ferry pkg install npm:<name> | list | remove <source> | update
	if (!["install", "remove", "list", "update"].includes(rest[0])) {
		console.log("usage: ferry pkg install npm:<package>|git:<repo>|<folder>   ferry pkg list   ferry pkg remove <source>   ferry pkg update\n" +
			"Installs pi extensions, skills and prompt packages for Ferry (needs access to npm or git for remote sources).");
	} else {
		ensureAgentDir((readModelsCache() ?? [{ id: "auto" }])[0].id);
		process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
		await applyProxy(loadConfig());
		const { main } = await import("@earendil-works/pi-coding-agent");
		await main(rest);
	}
}
else if (cmd === "mcp") await mcp(rest);
else if (cmd === "team") await (await import("../lib/teamcli.mjs")).teamCli(rest, { ferry: fileURLToPath(import.meta.url) }).then(exit);
else if (cmd === "doctor") await doctor().then(exit);
else if (cmd === "install-electron") {
	await applyProxy(loadConfig());
	const ok = (await import("../lib/render.mjs")).installElectron(rest[0] || "latest");
	process.exit(ok ? 0 : 1);
}
else if (cmd === "install") {
	await applyProxy(loadConfig());
	await install(VERSION, rest.includes("--client-only") || undefined);
	exit();
}
else if (cmd === "update") {
	await applyProxy(loadConfig());
	await update(VERSION, REPO, rest[0]).catch((e) => {
		console.error(`Update failed: ${e.message}\nYou can download ferry-windows-*.zip from https://github.com/${REPO}/releases yourself and run: ferry update <that zip>`);
		process.exitCode = 1;
	});
	exit();
} else if (cmd === "--version" || cmd === "version") console.log(rest.includes("--all") ? `ferry ${VERSION}\npi ${PI_VERSION}` : VERSION);
else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
	console.log(`Ferry ${VERSION}

  ferry                             start the agent in this folder (type your request, Ctrl+C twice to quit)
  ferry -p "question"               one question, answer printed, then exit
  ferry -c / ferry -r               continue the last conversation / pick one to resume
  (inside: /help lists the commands and keys; Shift+Tab switches the permission mode)
  ferry doctor [--no-model]         check the setup step by step, ending with a tiny request to each model
  ferry doctor --upload             which upload sizes get through the network to the server
  ferry login <server-url> <token>  use a Ferry server on another machine
      [--header "Name: value"]      extra header for every request (e.g. a Cloudflare Access service token)
  ferry logout                      go back to a Ferry server on this computer
  ferry config                      show the client settings (memory, subagents, approvals, blocked paths...)
  ferry config set <key> <value>    change one, e.g. ferry config set memory false
  ferry install-electron            Electron for web_render (reading pages built by JavaScript), about 100 MB
  ferry mcp list | import | add     MCP servers: see them, copy them from Claude Desktop / Cursor / Claude Code
  ferry team add <name> ...         add a Ferry agent to a Paperclip team (ferry team for details)
  ferry pkg install npm:<package>   add a pi package (extensions, skills, commands); ferry pkg list | remove
  ferry update [file.zip]           install the latest release from GitHub (or a zip you downloaded)
  ferry install [--client-only]     install from an unpacked Ferry folder (--client-only: no local server)
  ferry --pi-help                   all agent options`);
} else if (cmd === "--pi-help") await run(["--help"]);
else await run(process.argv.slice(2));
