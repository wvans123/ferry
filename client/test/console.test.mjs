// The phone console: commands from the page reach the session the way typed ones do; the status upload is small and throttled.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { STATUS_BYTES, createConsole, deliver, fit, stepLine } from "../lib/console.mjs";

function fakePi() {
	const on = {};
	const pi = {
		sent: [], commands: {},
		on: (n, f) => (on[n] ??= []).push(f),
		registerCommand: (n, c) => { pi.commands[n] = c.handler; },
		sendUserMessage: (text, opts) => pi.sent.push([text, opts]),
		fire: async (n, e = {}, c) => { for (const f of on[n] ?? []) await f(e, c); },
	};
	return pi;
}

/** A Ferry server's console API. queue: batches of commands, one batch per poll. */
async function server(queue = []) {
	const seen = { puts: [], putUrls: [], deleted: [], links: [], polls: 0 };
	let gone = 0;
	const srv = createServer(async (req, res) => {
		let body = "";
		for await (const c of req) body += c;
		const send = (o, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
		if (req.method === "PUT") return seen.puts.push(JSON.parse(body)), seen.putUrls.push(req.url), send({ ok: true });
		if (req.method === "DELETE") return seen.deleted.push(req.url), send({ ok: true });
		if (req.method === "POST") return seen.links.push(JSON.parse(body)), send({ link: "https://f.example.com/m/c_x", pushed: true });
		seen.polls++;
		if (gone > 0) return gone--, send({ state: "gone" }, 404);
		const batch = queue.shift();
		setTimeout(() => send({ commands: batch ?? [] }), batch ? 0 : 30);
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const cfg = { server: `http://127.0.0.1:${srv.address().port}`, token: "t", features: ["remote"] };
	return { cfg, seen, drop: () => { gone = 1; }, close: () => (srv.closeAllConnections(), srv.close()) };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => {
	const end = Date.now() + ms;
	while (!fn() && Date.now() < end) await wait(10);
	return fn();
};
function terminal() {
	const notes = [];
	return { notes, ctx: { hasUI: true, cwd: "/work/specs", model: { provider: "kiro", id: "claude-opus-5.5" }, ui: { notify: (t) => notes.push(t) } } };
}

test("a steer goes in at the next step like a typed message, marked as from the phone", () => {
	const pi = fakePi();
	assert.equal(deliver(pi, {}, { cmd: "steer", text: " use the 2026-09 version " }, false), "delivered");
	assert.deepEqual(pi.sent, [["(from your phone) use the 2026-09 version", { deliverAs: "steer" }]]);
});

test("pause and resume run /goal pause | resume, only for a goal in that state", () => {
	const pi = fakePi();
	let goal = { objective: "x", status: "pursuing", turns: 2 };
	const cfg = { goalNow: () => goal };
	assert.equal(deliver(pi, cfg, { cmd: "pause" }, false), "done");
	assert.deepEqual(pi.sent.at(-1), ["/goal pause", { expandPromptTemplates: true }]);
	assert.equal(deliver(pi, cfg, { cmd: "resume" }, false), "nogoal");
	goal = { ...goal, status: "paused" };
	assert.equal(deliver(pi, cfg, { cmd: "resume" }, true), "done");
	assert.deepEqual(pi.sent.at(-1), ["/goal resume", { expandPromptTemplates: true }]);
	goal = null;
	assert.equal(deliver(pi, cfg, { cmd: "pause" }, false), "nogoal");
	assert.equal(pi.sent.length, 2);
});

test("from the phone, /goal, /loop and /compact run as commands; other slash text stays a message", () => {
	const pi = fakePi();
	const off = { remoteTasks: false };
	// a task that is /goal, /loop or /compact runs as that command; any other slash text stays an ordinary message
	assert.equal(deliver(pi, {}, { cmd: "task", text: " /goal finish the SA2 deck " }, true), "command");
	assert.deepEqual(pi.sent.at(-1), ["/goal finish the SA2 deck", { expandPromptTemplates: true }]);
	assert.equal(deliver(pi, {}, { cmd: "steer", text: "/compact" }, true), "command");
	assert.equal(deliver(pi, {}, { cmd: "task", text: "/goal next one" }, false), "command");
	assert.deepEqual(pi.sent.at(-1), ["/goal next one", { expandPromptTemplates: true, deliverAs: "followUp" }]);
	assert.equal(deliver(pi, {}, { cmd: "task", text: "/config set mode bypass" }, true), "started");
	assert.match(pi.sent.at(-1)[0], /^\(from your phone\) \/config set mode bypass$/);
	assert.equal(deliver(pi, off, { cmd: "task", text: "/goal x" }, true), "refused");
	assert.equal(deliver(pi, {}, { cmd: "steer", text: "/goal x" }, false), "delivered", "while it works a steer stays a steer");
});

test("a task starts an idle session, waits behind a busy one, and is refused when remoteTasks is off", () => {
	const pi = fakePi();
	assert.equal(deliver(pi, {}, { cmd: "task", text: "make the slides" }, true), "started");
	assert.deepEqual(pi.sent.at(-1), ["(from your phone) make the slides", undefined]);
	assert.equal(deliver(pi, {}, { cmd: "task", text: "then the summary" }, false), "queued");
	assert.deepEqual(pi.sent.at(-1), ["(from your phone) then the summary", { deliverAs: "followUp" }]);
	assert.equal(deliver(pi, {}, { cmd: "steer", text: "it just finished" }, true), "started", "a steer that finds it idle is a new request");
	const off = { remoteTasks: false };
	assert.equal(deliver(pi, off, { cmd: "task", text: "x" }, true), "refused");
	assert.equal(deliver(pi, off, { cmd: "steer", text: "x" }, true), "refused");
	assert.equal(deliver(pi, off, { cmd: "steer", text: "still fine" }, false), "delivered");
	assert.equal(deliver(pi, {}, { cmd: "rm -rf" }, true), "refused");
	assert.equal(pi.sent.length, 4);
});

test("the status fits in a few KB, newest steps kept; a step is one short line", () => {
	const big = { state: "working", goal: { objective: "o".repeat(400), status: "pursuing", turns: 1 }, reply: "r".repeat(300),
		todo: Array.from({ length: 20 }, (_, i) => ({ status: "pending", text: `${i} ${"t".repeat(190)}` })),
		steps: Array.from({ length: 30 }, (_, i) => `step ${i} ${"s".repeat(110)}`) };
	const s = fit(big);
	assert.ok(Buffer.byteLength(JSON.stringify(s)) <= STATUS_BYTES);
	assert.ok(s.steps.length < 30 && s.steps.at(-1).startsWith("step 29"));
	assert.equal(big.steps.length, 30, "the original is left alone");
	// a long reply keeps its line breaks and gives way first, down to 600 characters, before steps and to-dos go
	const long = fit({ state: "idle", reply: `第一段\n\n${"字".repeat(5000)}`, steps: ["a", "b", "c", "d", "e"], todo: [] });
	assert.ok(Buffer.byteLength(JSON.stringify(long)) <= STATUS_BYTES);
	assert.ok(long.reply.startsWith("第一段\n\n字") && long.reply.length >= 600 && long.steps.length === 5);
	assert.equal(stepLine("bash", { command: "python   build.py\n--all" }), "bash (python build.py --all)");
	assert.equal(stepLine("todo", { todos: [] }), "todo");
	assert.ok(stepLine("read", { path: "x".repeat(300) }).length <= 121);
});

test("with a terminal: uploads the status, takes commands, reports the result, throttles, and ends on quit", async () => {
	const s = await server([[{ id: "1", cmd: "steer", text: "use v2", via: "phone" }]]);
	try {
		const cfg = { ...s.cfg };
		const pi = fakePi();
		const factory = createConsole(cfg, { todoText: () => "[x] read the spec\n[>] draft the change\n[ ] check", statusMs: 150, retryMs: 20 });
		factory(pi);
		const t = terminal();
		await pi.fire("session_start", {}, t.ctx);
		await pi.fire("agent_start", {}, t.ctx);
		assert.match(cfg.consoleId, /^[0-9a-f]{16}$/);
		assert.ok(await until(() => pi.sent.length === 1));
		assert.deepEqual(pi.sent[0], ["(from your phone) use v2", { deliverAs: "steer" }]);
		assert.match(t.notes[0], /From your phone: steer/);
		const before = s.seen.puts.length;
		for (let i = 0; i < 20; i++) await pi.fire("tool_execution_start", { toolName: "bash", args: { command: `echo ${i}` } });
		await pi.fire("tool_execution_start", { toolName: "read", args: { path: "a" }, parentToolCallId: "sub" });
		await pi.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Drafting   5.3.1" }] } });
		await wait(400);
		assert.ok(s.seen.puts.length - before <= 3, `throttled: ${s.seen.puts.length - before} uploads`);
		const last = s.seen.puts.at(-1);
		assert.equal(last.state, "working");
		assert.equal(last.project, "specs");
		assert.equal(last.model, "kiro/claude-opus-5.5");
		assert.deepEqual(last.todo, [{ status: "completed", text: "read the spec" }, { status: "in_progress", text: "draft the change" },
			{ status: "pending", text: "check" }]);
		assert.equal(last.steps.length, 8);
		assert.equal(last.steps.at(-1), "bash (echo 19)");
		assert.equal(last.reply, "Drafting 5.3.1");
		assert.deepEqual(last.last, { cmd: "steer", result: "delivered" });
		await pi.fire("agent_settled", {});
		assert.ok(await until(() => s.seen.puts.at(-1).state === "idle"));
		s.drop(); // the server forgot the session: it is opened again
		const n = s.seen.puts.length;
		assert.ok(await until(() => s.seen.puts.length > n));
		await pi.fire("session_shutdown", { reason: "new" });
		assert.deepEqual(s.seen.deleted, [], "/new keeps the session and its links");
		const pi2 = fakePi(); // pi loads the extensions again for the new conversation
		factory(pi2);
		await pi2.fire("session_start", {}, t.ctx);
		const url = `/v1/ferry/console/${cfg.consoleId}`;
		assert.ok(await until(() => s.seen.putUrls.filter((u) => u === url).length === s.seen.putUrls.length && s.seen.putUrls.length > n + 1),
			"the same session id");
		await pi2.fire("session_shutdown", { reason: "quit" });
		assert.deepEqual(s.seen.deleted, [url]);
	} finally {
		s.close();
	}
});

test("/phone pushes a fresh link and prints it; /phone off revokes; without a terminal or the server's support there is no console", async () => {
	const s = await server();
	try {
		const pi = fakePi();
		createConsole({ ...s.cfg }, { retryMs: 20 })(pi);
		const t = terminal();
		await pi.fire("session_start", {}, t.ctx);
		await pi.commands.phone("", t.ctx);
		assert.deepEqual(s.seen.links, [{ push: true }]);
		assert.match(t.notes.at(-1), /Sent to your phone .*https:\/\/f\.example\.com\/m\/c_x/);
		await pi.commands.phone("off", t.ctx);
		assert.match(s.seen.deleted.at(-1), /\/link$/);
		assert.match(t.notes.at(-1), /links are off/);
		await pi.fire("session_shutdown", { reason: "quit" });

		for (const [cfg, ctx] of [[{ ...s.cfg, features: [] }, t.ctx], [{ ...s.cfg, phoneRemote: false }, t.ctx], [{ ...s.cfg }, { ...t.ctx, hasUI: false }]]) {
			const p = fakePi();
			createConsole(cfg)(p);
			const polls = s.seen.polls;
			await p.fire("session_start", {}, ctx);
			await p.commands.phone("", ctx);
			await wait(60);
			assert.equal(s.seen.polls, polls);
			assert.equal(cfg.consoleId, undefined);
			assert.match(t.notes.at(-1), /needs/);
		}
	} finally {
		s.close();
	}
});
