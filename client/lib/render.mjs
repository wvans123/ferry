// web_render: open a page in a hidden browser (Electron) on this computer, let its scripts run, and read the text it
// ends up showing. For pages that web_fetch reads as empty because they are built by JavaScript.
//
// - Electron is not shipped with Ferry (about 100 MB). Ferry looks for it in this order: the electronPath setting,
//   FERRY_ELECTRON, <FERRY_HOME>/electron (where `ferry install-electron` puts it), an electron package next to
//   Ferry, then the global npm folder. Without it, web_render is simply not offered.
// - Read only: the page is opened, given time to load, and read. Nothing is clicked or typed.
// - Each page gets a fresh session in memory: no cookies, no logins, nothing stored on disk.
// - Sites on the blockedSites list (and their subdomains) are never opened, by web_fetch either.
// - It uses this computer's network like web_fetch: the proxy setting / HTTPS_PROXY, otherwise the system proxy.
// - One hidden Electron process serves all pages of a ferry window; it quits after two idle minutes.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FERRY_HOME } from "./config.mjs";

const HOST = join(dirname(fileURLToPath(import.meta.url)), "render-host.cjs");
const EXE = process.platform === "win32" ? "electron.exe" : process.platform === "darwin"
	? join("Electron.app", "Contents", "MacOS", "Electron") : "electron";
export const ELECTRON_HOME = join(FERRY_HOME, "electron");

/** The site from the blocked list that covers this address, or "". */
export function blockedSite(url, list) {
	let host = "";
	try {
		host = new URL(/^[a-z][\w+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/\.$/, "");
	} catch {
		return "";
	}
	for (let d of list ?? []) {
		d = String(d).toLowerCase().trim().replace(/^[a-z]+:\/\//, "").replace(/^\*?\./, "").replace(/[/:].*$/, "");
		if (d && (host === d || host.endsWith(`.${d}`))) return d;
	}
	return "";
}

const distExe = (pkgDir) => join(pkgDir, "dist", EXE);

/** Where Electron is on this computer, or "". */
export function findElectron(cfg = {}, env = process.env) {
	const tries = [cfg.electronPath, env.FERRY_ELECTRON, distExe(join(ELECTRON_HOME, "node_modules", "electron"))];
	try { // an electron package installed next to Ferry
		tries.push(distExe(dirname(createRequire(import.meta.url).resolve("electron/package.json"))));
	} catch {
		// not there
	}
	for (const p of tries) if (p && existsSync(p)) return p;
	if (cfg._skipGlobal) return "";
	try { // installed with npm install -g electron
		const npm = process.platform === "win32" ? "npm.cmd" : "npm";
		const root = spawnSync(npm, ["root", "-g"], { encoding: "utf8", timeout: 8000, windowsHide: true, shell: process.platform === "win32" })
			.stdout?.trim();
		const p = root && distExe(join(root, "electron"));
		if (p && existsSync(p)) return p;
	} catch {
		// npm not on PATH
	}
	return "";
}

let found; // looked up once per ferry window
export function electronFor(cfg) {
	if (cfg.render === false) return "";
	if (found === undefined) found = findElectron(cfg);
	return found;
}

class Host {
	constructor(exe, proxy) {
		this.exe = exe;
		this.proxy = proxy;
		this.proc = null;
		this.next = 1;
		this.waiting = new Map();
	}

	start() {
		if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.ready;
		const env = { ...process.env };
		delete env.ELECTRON_RUN_AS_NODE; // must start as a browser, not as Node
		delete env.NODE_OPTIONS;
		const args = [HOST];
		if (process.platform === "linux" && process.getuid?.() === 0) args.push("--no-sandbox"); // Chromium refuses root otherwise
		this.proc = spawn(this.exe, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		let buf = "";
		let errText = "";
		this.ready = new Promise((resolve, reject) => {
			const fail = (why) => {
				for (const w of this.waiting.values()) w.reject(new Error(why));
				this.waiting.clear();
				reject(new Error(why));
			};
			this.proc.on("error", (e) => fail(`could not start Electron (${this.exe}): ${e.message}`));
			this.proc.on("exit", (code) => {
				this.proc = null;
				fail(`the hidden browser stopped (exit ${code})${errText ? `: ${errText.trim().split("\n").slice(-3).join(" | ")}` : ""}`);
			});
			this.proc.stderr.setEncoding("utf8");
			this.proc.stderr.on("data", (d) => { errText = (errText + d).slice(-4000); });
			this.proc.stdout.setEncoding("utf8");
			this.proc.stdout.on("data", (d) => {
				buf += d;
				let nl;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (!line.startsWith("{")) continue; // Electron and Chromium also print logs
					let msg;
					try {
						msg = JSON.parse(line);
					} catch {
						continue;
					}
					if (msg.ready) resolve(msg);
					const w = this.waiting.get(msg.id);
					if (w) {
						this.waiting.delete(msg.id);
						w.resolve(msg);
					}
				}
			});
		});
		this.ready.catch(() => {}); // stays referenced until the first page is done (render() lets go of it)
		return this.ready;
	}

	/** Keep this process alive only while a page is being read; idle, the hidden browser must not hold ferry open. */
	hold(on) {
		const p = this.proc;
		if (!p) return;
		for (const x of [p, p.stdin, p.stdout, p.stderr]) (on ? x?.ref : x?.unref)?.call(x);
	}

	async render(url, opts = {}) {
		this.hold(true);
		try {
			return await this.renderOnce(url, opts);
		} finally {
			if (!this.waiting.size) this.hold(false);
		}
	}

	async renderOnce(url, { blocked = [], waitMs = 12000, signal } = {}) {
		await this.start();
		this.hold(true);
		const id = this.next++;
		const answer = new Promise((resolve, reject) => {
			this.waiting.set(id, { resolve, reject });
			const t = setTimeout(() => {
				this.waiting.delete(id);
				reject(new Error("the page did not finish loading in time"));
			}, waitMs + 30000);
			t.unref?.();
			signal?.addEventListener("abort", () => {
				this.waiting.delete(id);
				reject(new Error("cancelled"));
			}, { once: true });
		});
		const bypass = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
		this.proc.stdin.write(`${JSON.stringify({ id, url, waitMs, blocked, proxy: this.proxy, bypass })}\n`);
		return answer;
	}

	stop() {
		try {
			this.proc?.stdin.end();
			this.proc?.kill();
		} catch {
			// already gone
		}
	}
}

let host = null;
process.on("exit", () => host?.stop());

/** Electron's own proxy format: "http://host:port" works as a proxy rule as it is. */
function proxyRule(cfg) {
	const env = process.env;
	return cfg.proxy || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || "";
}

/** Open the page hidden, wait for it to settle, return what it shows: { url, title, html, text, ms }. */
export async function renderPage(cfg, url, { signal, waitMs } = {}) {
	if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
	const exe = electronFor(cfg);
	if (!exe) throw new Error("web_render needs Electron on this computer: run `ferry install-electron` " +
		"(or set its path: ferry config set electronPath <path to electron.exe>)");
	const hit = blockedSite(url, cfg.blockedSites);
	if (hit) throw new Error(`${hit} is on the blocked sites list (ferry config blockedSites): it must not be opened`);
	if (!host || host.exe !== exe) host = new Host(exe, proxyRule(cfg));
	const r = await host.render(url, { blocked: cfg.blockedSites ?? [], waitMs: waitMs ?? cfg.renderWaitMs ?? 12000, signal });
	if (!r.ok) {
		if (r.blocked) throw new Error(`the page went to ${r.blocked}, which is on the blocked sites list; it was not opened`);
		throw new Error(`could not open the page: ${r.error}`);
	}
	return r;
}

export function stopRenderer() {
	host?.stop();
	host = null;
}

/** `ferry install-electron`: put Electron into <FERRY_HOME>/electron with npm (honours ELECTRON_MIRROR). */
export function installElectron(version = "latest") {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	console.log(`Installing Electron into ${ELECTRON_HOME} (about 100 MB)...`);
	if (!process.env.ELECTRON_MIRROR) {
		console.log("  It downloads from GitHub. If that is blocked, set a mirror first, e.g. in cmd:\n" +
			"    set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/\n" +
			"  (PowerShell: $env:ELECTRON_MIRROR=\"https://npmmirror.com/mirrors/electron/\")");
	}
	const r = spawnSync(npm, ["install", "--prefix", ELECTRON_HOME, "--no-audit", "--no-fund", "--no-save", `electron@${version}`],
		{ stdio: "inherit", shell: process.platform === "win32", windowsHide: true });
	const exe = distExe(join(ELECTRON_HOME, "node_modules", "electron"));
	if (r.status === 0 && existsSync(exe)) {
		console.log(`Done: ${exe}\nThe agent now has web_render (pages built by JavaScript). Check with: ferry doctor`);
		return true;
	}
	console.log(`Electron is not complete (${exe} is missing). Usual causes:\n` +
		"  - the download from GitHub was blocked: set ELECTRON_MIRROR (above) and run ferry install-electron again\n" +
		"  - npm ignores install scripts here (npm config get ignore-scripts says true): run\n" +
		`      node "${join(ELECTRON_HOME, "node_modules", "electron", "install.js")}"\n` +
		"  - an antivirus program removed part of it\n" +
		"Or, if Electron already works somewhere else on this computer: ferry config set electronPath <path to electron.exe>");
	return false;
}
