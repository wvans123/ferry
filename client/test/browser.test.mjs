import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-browser-"));
for (const k of ["AGENT_BROWSER_EXECUTABLE_PATH", "AGENT_BROWSER_PROFILE", "AGENT_BROWSER_HEADED", "AGENT_BROWSER_ARGS"]) delete process.env[k];
const { BROWSER_BIN, SKILL_DIR, createBrowser, packagedBinary, prepareBrowser } = await import("../lib/browser.mjs");
const { commandSites, createWeb } = await import("../lib/web.mjs");
const { isReadOnlyCommand } = await import("../lib/permissions.mjs");

test("agent-browser ships for this computer", () => {
	assert.ok(packagedBinary(), "node_modules/agent-browser has no program for this platform");
	assert.ok(existsSync(join(SKILL_DIR, "browser", "SKILL.md")));
});

test("switched on: the program goes next to fd and rg, pointed at the installed browser", () => {
	const browser = process.execPath; // any existing file stands in for Edge here
	const st = prepareBrowser({ browser: true, browserPath: browser, browserArgs: ["--no-sandbox"] });
	assert.deepEqual(st, { on: true, browser });
	assert.equal(statSync(BROWSER_BIN).size, statSync(packagedBinary()).size);
	assert.equal(process.env.AGENT_BROWSER_EXECUTABLE_PATH, browser);
	assert.equal(process.env.AGENT_BROWSER_PROFILE, join(process.env.FERRY_HOME, "browser-profile"));
	assert.equal(process.env.AGENT_BROWSER_HEADED, "1");
	assert.equal(process.env.AGENT_BROWSER_ARGS, "--no-sandbox");
	// the skill is offered only while the browser is on
	const handlers = {};
	createBrowser(st)({ on: (name, fn) => { handlers[name] = fn; } });
	assert.deepEqual(handlers.resources_discover(), { skillPaths: [SKILL_DIR] });
	const none = {};
	createBrowser({ on: false })({ on: (name, fn) => { none[name] = fn; } });
	assert.deepEqual(Object.keys(none), ["tool_call"]); // no skill; only the "why not" answer
});

test("switched off, or no browser: not on the PATH, and the reason is given", () => {
	delete process.env.AGENT_BROWSER_EXECUTABLE_PATH; // set by the test above; one set by the user would win
	assert.match(prepareBrowser({ browser: true, browserPath: join(process.env.FERRY_HOME, "nope.exe") }).why, /no Edge or Chrome/);
	assert.match(prepareBrowser({ browser: false }).why, /off/);
	assert.equal(existsSync(BROWSER_BIN), false);
	// the agent tries it anyway: it is told why, and what to do
	const hooks = {};
	createBrowser({ on: false, why: "no Edge or Chrome found (ferry config set browserPath <path>)" })({ on: (n, f) => { hooks[n] = f; } });
	const r = hooks.tool_call({ toolName: "bash", input: { command: "agent-browser open https://example.com" } });
	assert.equal(r.block, true);
	assert.match(r.reason, /not available in this Ferry: no Edge or Chrome found \(ferry config set browserPath/);
	assert.equal(hooks.tool_call({ toolName: "bash", input: { command: "ls" } }), undefined);
	assert.equal(hooks.resources_discover, undefined); // and no browser skill
});

test("looking at the page does not ask; opening, clicking and typing do", () => {
	for (const c of ["agent-browser snapshot -i", "agent-browser get text body", "agent-browser is checked @e2",
		"agent-browser tab list", "agent-browser screenshot shot.png", "agent-browser skills get core --full"]) {
		assert.ok(isReadOnlyCommand(c), c);
	}
	for (const c of ["agent-browser open https://example.com", "agent-browser click @e3", "agent-browser fill @e1 x",
		"agent-browser tab new https://example.com", "agent-browser eval 'document.body.innerHTML=1'"]) {
		assert.ok(!isReadOnlyCommand(c), c);
	}
});

test("blocked sites hold for commands too: the browser and curl", () => {
	assert.deepEqual(commandSites('agent-browser open mail.corp.com && agent-browser snapshot -i'), ["mail.corp.com"]);
	assert.deepEqual(commandSites("curl -L -o a.zip https://www.3gpp.org/ftp/a.zip"), ["https://www.3gpp.org/ftp/a.zip"]);
	const handlers = [];
	createWeb({ web: "off", blockedSites: ["corp.com"] })({ on: (name, fn) => handlers.push([name, fn]) });
	const [[name, fn]] = handlers;
	assert.equal(name, "tool_call");
	assert.match(fn({ toolName: "bash", input: { command: "agent-browser open https://mail.corp.com/inbox" } }).reason, /corp.com is on the user's blocked sites/);
	assert.ok(fn({ toolName: "bash", input: { command: "agent-browser tab new pan.corp.com" } }).block);
	assert.equal(fn({ toolName: "bash", input: { command: "agent-browser open https://www.3gpp.org" } }), undefined);
	assert.equal(fn({ toolName: "read", input: { path: "mail.corp.com" } }), undefined);
});

test("ferry browser login: an ordinary window, done when the user has closed it", async () => {
	const { browserLogin, profileInUse } = await import("../lib/browser.mjs");
	const { EventEmitter } = await import("node:events");
	const mk = () => { const c = new EventEmitter(); c.kill = () => { c.killed = true; }; return c; };
	const runs = [];
	const run = (a) => runs.push(a.join(" "));
	// the user closes the window after a while: the process exits and the profile is free
	let child, lock = true;
	let r = await browserLogin({ browserPath: process.execPath }, "https://accounts.google.com", { run, every: 10,
		spawn: () => { child = mk(); setTimeout(() => { child.emit("exit"); }, 50); setTimeout(() => { lock = false; }, 120); return child; },
		inUse: () => lock });
	assert.equal(r.state, "signed-in");
	assert.equal(lock, false, "waited for the profile lock to go, not only for the process");
	assert.deepEqual(runs, ["close --all"], "only the agent's own browser is closed first; nothing connects to the window");
	assert.ok(r.args[0].startsWith("--user-data-dir="));
	assert.ok(r.args.includes("--no-first-run") && r.args.includes("https://accounts.google.com"));
	assert.ok(!r.args.some((a) => /remote-debugging-port|enable-automation|headless/.test(a)), "a completely ordinary window");
	// still open at the limit: the window is closed for the user
	r = await browserLogin({ browserPath: process.execPath }, "https://accounts.google.com", { run, every: 10, waitMs: 80,
		spawn: () => (child = mk()), inUse: () => true });
	assert.equal(r.state, "timeout");
	assert.ok(child.killed);
});

test("profileInUse: the browser's lock file", async () => {
	const { profileInUse } = await import("../lib/browser.mjs");
	const { mkdtempSync, symlinkSync, rmSync: rm, writeFileSync: wf } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const d = mkdtempSync(join(tmpdir(), "ferry-prof-"));
	assert.equal(profileInUse(d), false);
	if (process.platform === "win32") {
		wf(join(d, "lockfile"), "");
		assert.equal(profileInUse(d), false, "a stale lockfile nobody holds is removed");
	} else {
		symlinkSync("host-1234", join(d, "SingletonLock")); // chromium: a dangling symlink while the browser runs
		assert.equal(profileInUse(d), true);
		rm(join(d, "SingletonLock"));
		assert.equal(profileInUse(d), false);
	}
});
