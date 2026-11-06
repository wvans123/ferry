import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { askAll } from "../lib/ask.mjs";
import { _state, ask } from "../lib/guard.mjs";
import { openRemote, race, remoteOn } from "../lib/remote.mjs";
import { batchClaims, claimGuard } from "../lib/subagent.mjs";

/** A Ferry server's inbox: answers the first long-poll after `after` ms with `answer` (null: keeps waiting). */
async function inbox({ answer = null, after = 50 } = {}) {
	const seen = { items: [], deleted: [], pushed: [], polls: 0 };
	const srv = createServer(async (req, res) => {
		let body = "";
		for await (const c of req) body += c;
		const send = (o, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
		if (req.method === "POST" && req.url === "/v1/ferry/remote") return seen.items.push(JSON.parse(body)), send({ id: "i1" });
		if (req.method === "POST" && req.url.endsWith("/notify")) return seen.pushed.push(req.url), send({ ok: true, link: true });
		if (req.method === "DELETE") return seen.deleted.push(req.url), send({ ok: true });
		seen.polls++;
		setTimeout(() => (answer ? send({ state: "answered", answer }) : send({ state: "waiting" })), answer ? after : 30);
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const cfg = { server: `http://127.0.0.1:${srv.address().port}`, token: "t", features: ["remote"], phoneApprovalSeconds: 60 };
	return { cfg, seen, close: () => (srv.closeAllConnections(), srv.close()) };
}

/** A terminal whose dialogs wait until answered by `reply` (ms, value), or until their signal closes them. */
function terminal(reply = null) {
	const ui = { notes: [], dialogs: [], closed: 0 };
	const dialog = (title, options, opts) => new Promise((done) => {
		ui.dialogs.push({ title, options });
		if (reply) setTimeout(() => done(typeof reply.value === "function" ? reply.value(options) : reply.value), reply.ms);
		opts?.signal?.addEventListener("abort", () => (ui.closed++, done(undefined)), { once: true });
	});
	ui.select = dialog;
	ui.input = (title, placeholder, opts) => dialog(title, [], opts);
	ui.notify = (text) => ui.notes.push(text);
	return ui;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const bash = { toolName: "bash", input: { command: "npm test" } };

test("remote answers only when the server offers them and the phone settings are on", () => {
	const cfg = { server: "http://x", features: ["remote"] };
	assert.ok(remoteOn(cfg));
	assert.ok(!remoteOn({ ...cfg, features: [] }));
	assert.ok(!remoteOn({ ...cfg, phoneRemote: false }));
	assert.ok(!remoteOn({ ...cfg, phoneNotify: false }));
	assert.ok(!remoteOn({ features: ["remote"] }));
	assert.equal(openRemote({ ...cfg, features: [] }, { kind: "ask" }), null);
});

test("the phone answers first: the dialog closes and the answer is the phone's", async () => {
	const s = await inbox({ answer: { action: "once", via: "phone" } });
	try {
		const ui = terminal();
		const r = await race(openRemote(s.cfg, { kind: "approve", tool: "bash" }), (signal) => ui.select("Allow?", ["a"], { signal }));
		assert.deepEqual(r, { phone: { action: "once", via: "phone" } });
		assert.equal(ui.closed, 1, "the terminal dialog was closed");
		assert.deepEqual(s.seen.deleted, []);
	} finally {
		s.close();
	}
});

test("the terminal answers first: the item is taken back from the server", async () => {
	const s = await inbox();
	try {
		const ui = terminal({ ms: 120, value: "Allow once" });
		const r = await race(openRemote(s.cfg, { kind: "approve", tool: "bash" }), (signal) => ui.select("Allow?", ["a"], { signal }));
		assert.deepEqual(r, { value: "Allow once" });
		await wait(80);
		assert.deepEqual(s.seen.deleted, ["/v1/ferry/remote/i1"]);
		assert.equal(ui.closed, 0);
		assert.ok(s.seen.polls >= 1);
	} finally {
		s.close();
	}
});

test("a server that cannot be reached leaves the terminal asking as before", async () => {
	const ui = terminal({ ms: 50, value: "Deny" });
	const cfg = { server: "http://127.0.0.1:9", features: ["remote"] };
	assert.deepEqual(await race(openRemote(cfg, { kind: "ask" }), (signal) => ui.select("Q", ["x"], { signal })), { value: "Deny" });
	assert.deepEqual(await race(null, async () => "plain"), { value: "plain" });
});

test("the push goes after phoneApprovalSeconds, once, and not after an answer", async () => {
	const s = await inbox();
	try {
		const ui = terminal({ ms: 200, value: "x" });
		await race(openRemote(s.cfg, { kind: "ask" }, { notifyAfter: 0.05 }), (signal) => ui.select("Q", ["x"], { signal }));
		assert.deepEqual(s.seen.pushed, ["/v1/ferry/remote/i1/notify"]);
		const ui2 = terminal({ ms: 20, value: "x" });
		await race(openRemote(s.cfg, { kind: "ask" }, { notifyAfter: 0.15 }), (signal) => ui2.select("Q", ["x"], { signal }));
		await wait(250);
		assert.equal(s.seen.pushed.length, 1);
	} finally {
		s.close();
	}
});

test("approval from the phone: the same choices as the terminal; always only where the dialog offers it", async () => {
	const s = await inbox({ answer: { action: "always", via: "phone" } });
	const before = _state.mode;
	try {
		const edit = { toolName: "write", input: { path: "a.txt", content: "x" } };
		const r = await ask(s.cfg, terminal(), { action: "ask" }, edit, process.cwd(), "");
		assert.equal(r, undefined);
		assert.equal(_state.mode, "acceptEdits", "the edit dialog's always choice: file changes go ahead from now on");
		assert.equal(s.seen.items[0].always, "Allow all file changes from now on (auto-edit mode)");
		assert.equal(s.seen.items[0].tool, "write");
		_state.mode = before;
		const ui = terminal();
		const danger = await ask(s.cfg, ui, { action: "ask", danger: "deletes files", always: true }, bash, process.cwd(), "");
		assert.equal(s.seen.items[1].always, "", "a dangerous step offers no always");
		assert.equal(s.seen.items[1].danger, "deletes files");
		assert.equal(danger.block, true, "an always the dialog does not offer is not taken");
		assert.match(ui.notes.at(-1), /^Answered on the phone: Deny/);
	} finally {
		_state.mode = before;
		s.close();
	}
});

test("deny from the phone carries the note; a subagent's question says who asked", async () => {
	const s = await inbox({ answer: { action: "deny", note: "use pytest", via: "phone" } });
	try {
		const ui = terminal();
		const r = await ask(s.cfg, ui, { action: "ask" }, bash, process.cwd(), "#3 general (tests)");
		assert.deepEqual(r, { block: true, reason: "The user denied this. They said: use pytest" });
		assert.equal(s.seen.items[0].who, "#3 general (tests)");
		assert.equal(s.seen.items[0].target, "npm test");
		assert.match(ui.notes.at(-1), /Subagent #3 general \(tests\): bash npm test: denied \(on the phone\)/);
	} finally {
		s.close();
	}
});

test("ask_user from the phone: every answer, and the terminal's question closes", async () => {
	const qs = [{ question: "Which format?", options: [{ label: "Word" }, { label: "PPT" }] },
		{ question: "How long?", options: [{ label: "Short" }, { label: "Long" }] }];
	const s = await inbox({ answer: { answers: ["PPT", "about 10 slides"], via: "phone" } });
	try {
		const ui = terminal();
		const r = await askAll(s.cfg, ui, qs, process.cwd());
		assert.deepEqual(r, { answers: ["Which format? -> PPT", "How long? -> about 10 slides"] });
		assert.equal(ui.closed, 1);
		assert.deepEqual(ui.notes, ["Answered on the phone"]);
		assert.equal(s.seen.items[0].questions.length, 2);
	} finally {
		s.close();
	}
	const local = await askAll({}, terminal({ ms: 5, value: (o) => o[0] }), qs, process.cwd());
	assert.deepEqual(local, { answers: ["Which format? -> Word", "How long? -> Short"] });
});

test("task_batch: the first subagent to change a file owns it; another one is refused, reads are not", () => {
	const claims = batchClaims();
	const load = (who) => {
		let fn;
		claimGuard(claims, who)({ on: (_ev, f) => { fn = f; } });
		return (toolName, input) => fn({ toolName, input }, { cwd: "/w" });
	};
	const one = load("#4.1 general (a)");
	const two = load("#4.2 general (b)");
	assert.equal(one("write", { path: "out.md" }), undefined);
	assert.equal(one("edit", { path: "./out.md" }), undefined, "the owner goes on");
	const refused = two("edit", { path: "out.md" });
	assert.equal(refused.block, true);
	assert.match(refused.reason, /out\.md is being changed by subagent #4\.1 general \(a\) in this batch/);
	assert.equal(two("read", { path: "out.md" }), undefined);
	assert.equal(two("write", { path: "other.md" }), undefined);
	claims.clear();
	assert.equal(two("write", { path: "out.md" }), undefined, "claims end with the batch");
});
