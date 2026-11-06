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

test("ferry browser login: an ordinary window, the agent connects once the user has signed in", async () => {
	const { browserLogin, browserHide } = await import("../lib/browser.mjs");
	const { EventEmitter } = await import("node:events");
	const http = await import("node:http");
	// a stand-in browser: its debugging port lists the pages the user goes through
	const fakeBrowser = (pagesSeen) => (exe, args) => {
		const port = Number(args.find((a) => a.startsWith("--remote-debugging-port=")).split("=")[1]);
		let n = 0;
		const s = http.createServer((req, res) => {
			const url = pagesSeen[Math.min(n++, pagesSeen.length - 1)];
			if (url === "closed") { s.close(); s.closeAllConnections(); return res.destroy(); }
			res.end(JSON.stringify([{ type: "page", url }, { type: "service_worker", url: "https://x/sw.js" }]));
		});
		s.listen(port, "127.0.0.1");
		const child = new EventEmitter();
		child.pid = 0;
		child.ran = { exe, args, server: s };
		fakeBrowser.last = child;
		return child;
	};
	const runs = [];
	const run = (a) => runs.push(a.join(" "));
	let r = await browserLogin({ browserPath: process.execPath }, "https://accounts.google.com", { run, every: 20,
		spawn: fakeBrowser(["https://accounts.google.com/signin", "https://accounts.google.com/challenge/pwd",
			"https://myaccount.google.com/", "https://myaccount.google.com/"]) });
	fakeBrowser.last.ran.server.close();
	assert.equal(r.state, "signed-in");
	assert.deepEqual(runs, ["close --all", `connect ${r.port}`], "the agent's browser closed first, connected only after the sign-in");
	assert.ok(r.args[0].startsWith("--user-data-dir=") && r.args.includes(`--remote-debugging-port=${r.port}`));
	assert.ok(!r.args.some((a) => /enable-automation|headless/.test(a)), "an ordinary window");
	// a site that was signed in already
	runs.length = 0;
	r = await browserLogin({ browserPath: process.execPath }, "https://app.example.com", { run, every: 20,
		spawn: fakeBrowser(["https://app.example.com/home"]) });
	fakeBrowser.last.ran.server.close();
	assert.equal(r.state, "already");
	// the user closes the window: nothing to connect to, the sign-in stays in the profile
	runs.length = 0;
	r = await browserLogin({ browserPath: process.execPath }, "https://accounts.google.com", { run, every: 20,
		spawn: fakeBrowser(["https://accounts.google.com/signin", "closed"]) });
	assert.equal(r.state, "closed");
	assert.ok(!runs.some((x) => x.startsWith("connect")));
	assert.equal(browserHide({ run }), false, "nothing left open");
});

test("a headed agent-browser on a sign-in page is blocked and pointed to ferry browser login (#30)", async () => {
	const { headedSignInGuard } = await import("../lib/browser.mjs");
	const bash = (command, toolName = "bash") => ({ toolName, input: { command } });
	for (const c of [
		'agent-browser --headed open "https://accounts.google.com/ServiceLogin?continue=https://youtube.com"',
		"agent-browser --headed open https://login.microsoftonline.com/",
		"AGENT_BROWSER_HEADED=1 agent-browser open https://github.com/login",
		"agent-browser open https://appleid.apple.com --headed",
		"agent-browser --headed open https://example.com/user/sign-in",
		"agent-browser close && agent-browser --headed open https://www.youtube.com/signin",
	]) {
		const r = headedSignInGuard(bash(c));
		assert.ok(r?.block, c);
		assert.match(r.reason, /ferry browser login <url>/);
		assert.match(r.reason, /refuse a browser under automation/);
	}
	assert.ok(headedSignInGuard(bash("agent-browser --headed open https://accounts.google.com", "powershell"))?.block);
	// everything else passes
	for (const c of [
		"agent-browser open https://accounts.google.com",                 // not headed: left to the user's choice
		"agent-browser --headed open https://www.3gpp.org/ftp",          // headed but not a sign-in page
		"curl --headed https://accounts.google.com",                      // not agent-browser
		"ferry browser login https://accounts.google.com",
	]) assert.equal(headedSignInGuard(bash(c)), undefined, c);
	assert.equal(headedSignInGuard({ toolName: "read", input: { path: "agent-browser --headed https://accounts.google.com" } }), undefined);
});

test("a sign-in refusal in agent-browser output gets a note to use ferry browser login (#30)", async () => {
	const { refusalNote } = await import("../lib/browser.mjs");
	const ev = (command, text, toolName = "bash") => ({ toolName, input: { command }, isError: false, content: [{ type: "text", text }] });
	let r = refusalNote(ev("agent-browser --headed open https://accounts.google.com/ServiceLogin", "Couldn't sign in\nThis browser or app may not be secure. Try using a different browser."));
	assert.equal(r.content.length, 2);
	assert.match(r.content[1].text, /ferry browser login https:\/\/accounts\.google\.com\/ServiceLogin/);
	assert.match(r.content[0].text, /may not be secure/, "the output stays");
	r = refusalNote(ev("agent-browser snapshot -i", "此浏览器或应用可能不安全。请尝试使用其他浏览器。"));
	assert.match(r.content[1].text, /ferry browser login <that page>/);
	r = refusalNote(ev("agent-browser get text body", "You can't get there from here"));
	assert.ok(r, "Microsoft's wording");
	// other output, other commands, other tools: nothing added
	assert.equal(refusalNote(ev("agent-browser snapshot -i", "Welcome back")), undefined);
	assert.equal(refusalNote(ev("cat notes.txt", "This browser or app may not be secure")), undefined);
	assert.equal(refusalNote(ev("x", "This browser or app may not be secure", "read")), undefined);
});

test("the browser extension wires both guards", async () => {
	const h = {};
	createBrowser({ on: true })({ on: (n, f) => { (h[n] ??= []).push(f); } });
	assert.ok(h.tool_call.some((f) => f({ toolName: "bash", input: { command: "agent-browser --headed open https://accounts.google.com" } })?.block));
	assert.ok(h.tool_result.some((f) => f({ toolName: "bash", input: { command: "agent-browser open x" }, content: [{ type: "text", text: "This browser or app may not be secure" }] })));
});
