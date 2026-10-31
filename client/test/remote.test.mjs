import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-remote-"));
delete process.env.PAPERCLIP_RUN_ID;
const { createRemote, describeCall } = await import("../lib/remote.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeServer(reply) {
	const seen = [];
	const srv = http.createServer((req, res) => {
		let body = "";
		req.on("data", (d) => { body += d; });
		req.on("end", () => {
			const b = JSON.parse(body || "{}");
			seen.push({ auth: req.headers.authorization, ...b });
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(reply(b, seen.length)));
		});
	});
	return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}

function fakePi() {
	const h = {};
	return { h, on: (ev, fn) => { h[ev] = fn; } };
}

test("a short line per tool call", () => {
	assert.equal(describeCall("bash", { command: "npm   test" }), "npm test");
	assert.equal(describeCall("read", { path: "src/a.js" }), "src/a.js");
	assert.ok(describeCall("bash", { command: "x".repeat(500) }).length <= 161);
});

test("reports status, and carries out the phone's answers", async () => {
	let cmds = [];
	const { srv, seen, url } = await fakeServer(() => {
		const c = cmds;
		cmds = [];
		return { console: true, every: 30, commands: c };
	});
	const perm = { mode: "default" };
	let aborted = 0;
	const ctx = { abort: () => { aborted++; }, ui: { notify() {} },
		sessionManager: { getSessionName: () => "", getBranch: () => [{ type: "message", message: { role: "user", content: "fix the login bug" } },
			{ type: "custom", customType: "ferry-goal", data: { status: "pursuing", objective: "make tests pass" } }] } };
	const cfg = { server: url, token: "t0k", remoteApprove: true };
	const pi = fakePi();
	createRemote(cfg, perm, { version: "9.9.9" })(pi);
	pi.h.session_start({}, ctx);
	await sleep(100);
	assert.equal(seen[0].auth, "Bearer t0k");
	assert.equal(seen[0].title, "fix the login bug");
	assert.equal(seen[0].goal, "make tests pass");
	assert.equal(seen[0].state, "idle");

	pi.h.agent_start({}, ctx);
	pi.h.tool_execution_start({ toolName: "bash", args: { command: "npm test" } }, ctx);
	await sleep(400);
	const last = seen.at(-1);
	assert.equal(last.state, "working");
	assert.equal(last.tool, "bash");
	assert.equal(last.detail, "npm test");

	// an approval waits; the phone approves it
	let answered = null;
	perm.pendingAsk = { id: "ap1", tool: "bash", detail: "rm -rf build", danger: "", answer: (a) => { answered = a; } };
	cmds = [{ id: "c1", action: "approve", approval: "ap1" }];
	perm.onPending();
	await sleep(500);
	assert.equal(answered, "approve");
	assert.ok(seen.some((r) => r.pending?.id === "ap1" && r.state === "asking"));
	assert.ok(seen.some((r) => (r.done ?? []).includes("c1")), "the server is told the command was carried out");

	// a dangerous one is never approved from the phone, but stop always works
	answered = null;
	perm.pendingAsk = { id: "ap2", tool: "bash", detail: "x", danger: "deletes files", answer: (a) => { answered = a; } };
	cmds = [{ id: "c2", action: "approve", approval: "ap2" }];
	perm.onPending();
	await sleep(400);
	assert.equal(answered, null);
	cmds = [{ id: "c3", action: "stop" }];
	perm.onPending();
	await sleep(400);
	assert.equal(answered, "deny");
	assert.equal(aborted, 1);
	srv.close();
});

test("without remoteApprove the phone can only deny", async () => {
	let cmds = [{ id: "c1", action: "approve", approval: "a" }];
	const { srv, url } = await fakeServer(() => { const c = cmds; cmds = []; return { console: true, every: 30, commands: c }; });
	let answered = null;
	const perm = { mode: "default", pendingAsk: { id: "a", tool: "bash", detail: "x", danger: "", answer: (x) => { answered = x; } } };
	const pi = fakePi();
	createRemote({ server: url, token: "t" }, perm)(pi);
	pi.h.session_start({}, { sessionManager: { getBranch: () => [] } });
	await sleep(300);
	assert.equal(answered, null);
	srv.close();
});

test("off: no reports at all", async () => {
	const { srv, seen, url } = await fakeServer(() => ({ console: true, every: 30, commands: [] }));
	const pi = fakePi();
	createRemote({ server: url, token: "t", phoneConsole: false }, { mode: "default" })(pi);
	assert.equal(pi.h.session_start, undefined);
	await sleep(100);
	assert.equal(seen.length, 0);
	srv.close();
});

test("the approval question can be answered from the phone", async () => {
	const { createGuard, _state } = await import("../lib/guard.mjs");
	const h = {};
	const pi = { on: (ev, fn) => { h[ev] = fn; }, getAllTools: () => [] };
	createGuard({ blockedPaths: [] })(pi);
	_state.mode = "default";
	const notes = [];
	const ui = {
		notify: (t) => notes.push(t),
		select: (_title, _opts, o) => new Promise((resolve) => o.signal.addEventListener("abort", () => resolve(undefined))),
	};
	const cwd = process.cwd();
	const ask = (cmd) => h.tool_call({ toolName: "bash", input: { command: cmd } }, { cwd, hasUI: true, ui });

	let r = ask("npm install left-pad");
	await sleep(20);
	assert.equal(_state.pendingAsk.tool, "bash");
	assert.equal(_state.pendingAsk.danger, "");
	_state.pendingAsk.answer("approve");
	assert.equal(await r, undefined); // allowed
	assert.equal(_state.pendingAsk, null);

	r = ask("npm install left-pad");
	await sleep(20);
	_state.pendingAsk.answer("deny");
	assert.deepEqual(await r, { block: true, reason: "The user denied this action from their phone" });

	r = ask("rm -rf /tmp/x");
	await sleep(20);
	assert.ok(_state.pendingAsk.danger, "dangerous commands are marked, so the phone cannot approve them");
	_state.pendingAsk.answer("deny");
	await r;
});
