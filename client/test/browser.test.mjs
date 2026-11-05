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

test("ferry browser login opens the agent's browser and profile without automation, after closing the agent's one", async () => {
	const { browserLogin } = await import("../lib/browser.mjs");
	const { EventEmitter } = await import("node:events");
	let closed = false;
	let ran = null;
	const r = await browserLogin({ browserPath: process.execPath }, "https://accounts.google.com", {
		close: () => { closed = true; },
		spawn: (exe, args) => { ran = { exe, args }; const c = new EventEmitter(); setTimeout(() => c.emit("exit", 0), 10); return c; },
	});
	assert.ok(closed, "the agent's browser is closed first (one browser per profile)");
	assert.equal(ran.exe, process.env.AGENT_BROWSER_EXECUTABLE_PATH || process.execPath);
	assert.ok(ran.args[0].startsWith("--user-data-dir=") && ran.args[0].endsWith(r.profile));
	assert.ok(!ran.args.some((a) => /remote-debugging|enable-automation/.test(a)), "not driven by a program");
	assert.equal(ran.args.at(-1), "https://accounts.google.com");
});
