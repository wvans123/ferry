// Browser: the agent drives a real browser on this computer with agent-browser (Vercel, Apache-2.0), a command-line
// program it calls with bash, the way Claude Code and Codex users run it. No tool definitions are added: the program
// sits next to fd and rg in pi's bin folder (on the PATH of every command) and the browser skill teaches its use.
//
// Ferry points it at the browser that is already installed (Edge on Windows, Chrome elsewhere; browserPath to choose),
// gives it a profile of its own under FERRY_HOME (so a site you log in to once stays logged in), shows the window
// unless browserHeadless, and lets it use the company proxy (HTTPS_PROXY, set by Ferry) and this computer's
// certificates. Settings already present in the environment win. The browser is closed when ferry exits.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, statSync, chmodSync, rmSync } from "node:fs";
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
		});
		pi.on("session_shutdown", () => {
			if (used) spawnSync(BROWSER_BIN, ["close", "--all"], { timeout: 5000, stdio: "ignore", windowsHide: true });
		});
	};
}
