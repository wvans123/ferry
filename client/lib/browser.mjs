// Browser: the agent drives a real browser on this computer with agent-browser (Vercel, Apache-2.0), a command-line
// program it calls with bash, the way Claude Code and Codex users run it. No tool definitions are added: the program
// sits next to fd and rg in pi's bin folder (on the PATH of every command) and the browser skill teaches its use.
//
// Ferry points it at the browser that is already installed (Edge on Windows, Chrome elsewhere; browserPath to choose),
// gives it a profile of its own under FERRY_HOME (so a site you log in to once stays logged in), shows the window
// unless browserHeadless, and lets it use the company proxy (HTTPS_PROXY, set by Ferry) and this computer's
// certificates. Settings already present in the environment win. The browser is closed when ferry exits.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, chmodSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FERRY_HOME } from "./config.mjs";
import { BIN_DIR } from "./toolbins.mjs";

const WIN = process.platform === "win32";
const EXE = WIN ? ".exe" : "";
export const BROWSER_BIN = join(BIN_DIR, `agent-browser${EXE}`);
export const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "browser-skill");

/** The agent-browser program shipped in node_modules for this computer, or "". */
export function packagedBinary() {
	try {
		const dir = join(dirname(createRequire(import.meta.url).resolve("agent-browser/package.json")), "bin");
		const arch = WIN && process.arch === "arm64" ? "x64" : process.arch; // x64 runs under emulation there
		const f = join(dir, `agent-browser-${process.platform}-${arch}${EXE}`);
		return existsSync(f) ? f : "";
	} catch {
		return "";
	}
}

/** The installed browser to drive: browserPath, else Edge (Windows), else Chrome / Chromium. "" when none. */
export function findBrowser(cfg) {
	if (cfg.browserPath) return existsSync(cfg.browserPath) ? cfg.browserPath : "";
	const env = process.env;
	const cands = WIN ? [
		env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
		env.ProgramFiles && join(env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
		env.ProgramFiles && join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
		env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
	] : process.platform === "darwin" ? [
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	] : ["/usr/bin/google-chrome", "/usr/bin/microsoft-edge", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
	return cands.find((p) => p && existsSync(p)) ?? "";
}

/**
 * Before pi starts: put agent-browser into pi's bin folder and set its environment. Returns
 * { on, browser, why } for /status and ferry doctor.
 */
export function prepareBrowser(cfg) {
	if (cfg.browser === false) {
		rmSync(BROWSER_BIN, { force: true }); // switched off: the agent should not find it on the PATH either
		return { on: false, why: "off (ferry config set browser true)" };
	}
	const src = packagedBinary();
	if (!src) {
		return { on: false, why: "agent-browser is missing from this Ferry's files. Run from a source folder: npm ci there; " +
			"installed: ferry update, or install the full ferry-windows zip again" };
	}
	const browser = process.env.AGENT_BROWSER_EXECUTABLE_PATH || findBrowser(cfg);
	if (!browser) return { on: false, why: "no Edge or Chrome found (ferry config set browserPath <path to the browser>)" };
	try {
		mkdirSync(BIN_DIR, { recursive: true });
		if (!existsSync(BROWSER_BIN) || statSync(BROWSER_BIN).size !== statSync(src).size) {
			rmSync(BROWSER_BIN, { force: true });
			try {
				linkSync(src, BROWSER_BIN); // the same file, no copy (18 MB), when both are on one drive
			} catch {
				copyFileSync(src, BROWSER_BIN);
			}
			if (!WIN) chmodSync(BROWSER_BIN, 0o755);
		}
	} catch (e) {
		// on Windows a running program cannot be replaced (the browser of another ferry window): keep the one there
		if (!existsSync(BROWSER_BIN)) return { on: false, why: `cannot put agent-browser into ${BIN_DIR}: ${e.message}` };
	}
	const set = (k, v) => {
		if (v && !process.env[k]) process.env[k] = v;
	};
	set("AGENT_BROWSER_EXECUTABLE_PATH", browser);
	set("AGENT_BROWSER_PROFILE", join(FERRY_HOME, "browser-profile"));
	if (!cfg.browserHeadless) set("AGENT_BROWSER_HEADED", "1");
	set("AGENT_BROWSER_USE_SYSTEM_CA", "1");
	if (Array.isArray(cfg.browserArgs) && cfg.browserArgs.length) set("AGENT_BROWSER_ARGS", cfg.browserArgs.join("\n"));
	return { on: true, browser };
}

// ---------- signing in ----------
// Google, Microsoft and others refuse to sign in to a browser a program launched ("This browser or app may not be
// secure"). For a login Ferry opens the same browser and profile the ordinary way, with a debugging port the agent
// connects to only after the user has signed in, so the agent carries on in that very window. `ferry browser hide`
// (or ferry exiting) closes it; the next command runs in the background again, still signed in (same profile).

const WINDOW_FILE = join(FERRY_HOME, "browser-window.json");
const LOGIN_URL = /(log-?in|sign-?in|logon|\/auth|sso|oauth|saml|\/cas\/|servicelogin|challenge|accounts\.google\.|login\.microsoftonline\.|login\.live\.)/i;

function freePort() {
	return new Promise((done, fail) => {
		const s = createServer();
		s.on("error", fail);
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => done(port));
		});
	});
}

/** The pages open in the window (HTTP only: nothing attaches to them while the user signs in), or null when it is gone. */
async function windowPages(port) {
	try {
		const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
		return (await r.json()).filter((t) => t.type === "page").map((t) => String(t.url ?? ""));
	} catch {
		return null;
	}
}

/**
 * `ferry browser login [url]`: open the agent's browser and profile as an ordinary window at url and wait until the
 * user has signed in (a page away from the login pages), then connect the agent's browser commands to that window.
 * Returns { state: "signed-in" | "already" | "closed" | "timeout", port }. opts: spawn, run, waitMs, every (tests).
 */
export async function browserLogin(cfg, url = "https://accounts.google.com", opts = {}) {
	const exe = process.env.AGENT_BROWSER_EXECUTABLE_PATH || findBrowser(cfg);
	if (!exe) throw new Error("no Edge or Chrome found (ferry config set browserPath <path to the browser>)");
	const profile = process.env.AGENT_BROWSER_PROFILE || join(FERRY_HOME, "browser-profile");
	const run = opts.run ?? ((args) => existsSync(BROWSER_BIN) && spawnSync(BROWSER_BIN, args, { timeout: 15000, stdio: "ignore", windowsHide: true }));
	browserHide({ run }); // one browser per profile: the agent's own (and an earlier login window) must go first
	mkdirSync(profile, { recursive: true });
	const port = await freePort();
	const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check", url];
	const child = (opts.spawn ?? spawn)(exe, args, { detached: true, stdio: "ignore" });
	child.unref?.();
	writeFileSync(WINDOW_FILE, JSON.stringify({ pid: child.pid, port }), "utf8");
	const until = Date.now() + (opts.waitMs ?? 10 * 60_000);
	const every = opts.every ?? 2000;
	let seenLogin = false;
	let seenUp = false;
	let state = "timeout";
	for (let calm = 0; Date.now() < until; await new Promise((r) => setTimeout(r, every))) {
		const pages = await windowPages(port);
		if (!pages) {
			if (seenUp) { state = "closed"; break; } // the user closed the window: the login is kept in the profile
			continue;
		}
		seenUp = true;
		const real = pages.filter((u) => /^https?:/i.test(u));
		if (real.some((u) => LOGIN_URL.test(u))) { seenLogin = true; calm = 0; continue; }
		// away from every login page twice in a row (redirects settle), or never on one: signed in
		if (real.length && ++calm >= 2) { state = seenLogin ? "signed-in" : "already"; break; }
	}
	if (state === "signed-in" || state === "already") run(["connect", String(port)]);
	if (state === "closed" || state === "timeout") browserHide({ run });
	return { state, port, args };
}

/** `ferry browser hide`: close the login window (and disconnect); the next browser command runs in the background. */
export function browserHide(opts = {}) {
	const run = opts.run ?? ((args) => existsSync(BROWSER_BIN) && spawnSync(BROWSER_BIN, args, { timeout: 15000, stdio: "ignore", windowsHide: true }));
	run(["close", "--all"]);
	if (!existsSync(WINDOW_FILE)) return false;
	try {
		const { pid } = JSON.parse(readFileSync(WINDOW_FILE, "utf8"));
		if (pid) process.kill(pid);
	} catch {
		// already closed
	}
	rmSync(WINDOW_FILE, { force: true });
	return true;
}

// ---------- guards against a refused sign-in (issue #30) ----------
// `agent-browser --headed` is still a controlled browser (CDP, navigator.webdriver), so sign-in pages refuse it. The
// way in is `ferry browser login`. Two hooks keep the agent from going the other way.

const SIGNIN_URL = /(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|github\.com\/login|servicelogin|sign-?in|login)/i;
const LOGIN_ADVICE = "Run `ferry browser login <url>` (long timeout); the user signs in there and you carry on in that window.";
const REFUSAL = /(This browser or app may not be secure|此浏览器或应用可能不安全|Couldn.t sign you in[\s\S]{0,80}browser|browser[\s\S]{0,40}(is not|isn.t) supported|You can.t get there from here|不支持此浏览器)/i;
const urlsIn = (text) => String(text ?? "").match(/https?:\/\/[^\s"'<>)]+/gi) ?? [];
const isShell = (name) => ["bash", "powershell", "job_start"].includes(name);

/** tool_call: a headed agent-browser aimed at a sign-in page is blocked (exported for tests). */
export function headedSignInGuard(event) {
	const cmd = String(event?.input?.command ?? "");
	if (!isShell(event?.toolName) || !/\bagent-browser\b/.test(cmd)) return undefined;
	if (!/(--headed\b|AGENT_BROWSER_HEADED=(1|true)\b)/i.test(cmd)) return undefined;
	if (!urlsIn(cmd).some((u) => SIGNIN_URL.test(u))) return undefined;
	return { block: true, reason: "Sign-in pages refuse a browser under automation. Run `ferry browser login <url>` (long timeout); " +
		"the user signs in there and you carry on in that window." };
}

/** tool_result: the output of an agent-browser command shows a sign-in refusal: tell the agent what to do (exported for tests). */
export function refusalNote(event) {
	const cmd = String(event?.input?.command ?? "");
	if (!["bash", "powershell", "job_output"].includes(event?.toolName) || event?.parentToolCallId) return undefined;
	if (event.toolName !== "job_output" && !/\bagent-browser\b/.test(cmd)) return undefined;
	const text = (event.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
	if (!REFUSAL.test(text)) return undefined;
	const page = urlsIn(cmd)[0];
	return { content: [...event.content, { type: "text",
		text: `[Ferry: this sign-in page refuses a browser under automation. Run \`ferry browser login ${page ?? "<that page>"}\` (long timeout) and let the user sign in there; then carry on in that window. Do not use --headed.]` }] };
}

/** The pi extension: the browser skill while the browser is on; close the browser when ferry exits. */
export function createBrowser(status) {
	return (pi) => {
		if (!status.on) {
			// asked for anyway (the user said "use the browser"): say why it is not there instead of "command not found"
			pi.on("tool_call", (event) => {
				if (!["bash", "job_start"].includes(event.toolName) || !/\bagent-browser\b/.test(String(event.input?.command ?? ""))) return undefined;
				return { block: true, reason: `The browser (agent-browser) is not available in this Ferry: ${status.why}. ` +
					"Tell the user this reason and what to do; read the page with web_fetch if that is enough." };
			});
			return;
		}
		pi.on("resources_discover", () => ({ skillPaths: [SKILL_DIR] }));
		let used = false;
		pi.on("tool_call", (event) => {
			if (/\bagent-browser\b/.test(String(event.input?.command ?? ""))) used = true;
			return headedSignInGuard(event);
		});
		pi.on("tool_result", (event) => refusalNote(event));
		pi.on("session_shutdown", () => {
			if (existsSync(WINDOW_FILE)) browserHide(); // a login window Ferry opened: closed with ferry
			else if (used) spawnSync(BROWSER_BIN, ["close", "--all"], { timeout: 5000, stdio: "ignore", windowsHide: true });
		});
	};
}
