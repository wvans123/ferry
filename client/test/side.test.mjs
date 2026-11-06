import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-side-"));
const { askSide, createSide, tailOf } = await import("../lib/side.mjs");
const { discoverAgents } = await import("../lib/subagent.mjs");

/** A server that answers /v1/ferry/side; `lose` makes the first request answer 409 (the server lost its copy). */
async function server({ lose = false, fail = false } = {}) {
	const seen = [];
	const srv = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const b = JSON.parse(body);
			seen.push(b);
			const send = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
			if (fail) return send(502, { error: "no model answered" });
			if (lose && seen.length === 1) return send(409, { error: "session not found" });
			send(200, { text: `answer to ${b.kind}`, model: "m" });
		});
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	return { seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.close(); srv.closeAllConnections(); } };
}

function register(cfg) {
	const tools = {}, commands = {};
	createSide(cfg)({ registerTool: (t) => { tools[t.name] = t; }, registerCommand: (n, c) => { commands[n] = c; } });
	return { tools, commands };
}

const ctx = { hasUI: false, model: { id: "main" }, sessionManager: { getBranch: () => [
	{ type: "message", message: { role: "user", content: "hi", timestamp: 1000 } },
	{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "newest words" }], timestamp: 5000 } }] } };

test("the tail is the assistant's newest text, only when the server has not seen it", () => {
	assert.equal(tailOf(ctx, 1000), "newest words");
	assert.equal(tailOf(ctx, 5000), "");
	assert.equal(tailOf({}, 0), "");
});

test("a side question names the server's copy and carries the tail and the model", async () => {
	const s = await server();
	const cfg = { server: s.url, token: "t", side: { ref: () => ({ conv: "c", count: 4, hash: "h", at: 2000 }) } };
	assert.equal(await askSide(cfg, ctx, "btw", "what now?"), "answer to btw");
	assert.deepEqual(s.seen[0], { kind: "btw", question: "what now?", model: "main", ferry: { conv: "c", count: 4, hash: "h" }, tail: "newest words" });
	s.close();
});

test("when the server lost its copy the client sends it again, once, and asks again", async () => {
	const s = await server({ lose: true });
	let resynced = 0;
	const cfg = { server: s.url, token: "t", side: { ref: () => ({ conv: "c", count: 4, hash: "h" }), resync: async () => { resynced++; return { conv: "c", count: 4, hash: "h" }; } } };
	assert.equal(await askSide(cfg, ctx, "advise"), "answer to advise");
	assert.equal(resynced, 1);
	assert.equal(s.seen.length, 2);
	s.close();
});

test("the advisor tool is there only when the server has an advisor model and the setting is on", () => {
	assert.equal(register({ features: [] }).tools.advisor, undefined);
	assert.equal(register({ features: ["advisor"], advisor: false }).tools.advisor, undefined);
	assert.ok(register({ features: ["advisor"] }).tools.advisor);
});

test("the advisor result is the tool result; a failure tells the agent to go on", async () => {
	const s = await server();
	const { tools } = register({ server: s.url, token: "t", features: ["advisor"] });
	const r = await tools.advisor.execute("1", { question: "ok?" }, undefined, undefined, ctx);
	assert.equal(r.content[0].text, "answer to advise");
	assert.equal(s.seen[0].question, "ok?");
	s.close();
	const bad = await server({ fail: true });
	const t2 = register({ server: bad.url, token: "t", features: ["advisor"] }).tools.advisor;
	assert.match((await t2.execute("1", {}, undefined, undefined, ctx)).content[0].text, /could not be reached.*no model answered.*Go on without it/);
	bad.close();
});

test("/btw prints the answer in print mode and does not need a conversation", async () => {
	const s = await server();
	const { commands } = register({ server: s.url, token: "t" });
	const out = [];
	const write = process.stdout.write;
	process.stdout.write = (t) => { if (/^(btw|Usage)/.test(String(t))) out.push(String(t)); return true; };
	try {
		await commands.btw.handler("why?", { hasUI: false });
		await commands.btw.handler("", { hasUI: false });
	} finally {
		process.stdout.write = write;
	}
	assert.match(out[0], /btw: why\?\nanswer to btw/);
	assert.match(out[1], /Usage: \/btw/);
	assert.equal(s.seen.length, 1);
	assert.equal(s.seen[0].ferry, null);
	s.close();
});

test("/btw with a terminal answers later, as a notice, and clears its status", async () => {
	const s = await server();
	const { commands } = register({ server: s.url, token: "t" });
	const notes = [], status = [];
	await commands.btw.handler("why?", { hasUI: true, ui: { notify: (t, l) => notes.push([t, l]), setStatus: (k, v) => status.push([k, v]) } });
	assert.deepEqual(status[0], ["ferry-btw", "btw: asking..."]);
	for (let i = 0; i < 50 && !notes.length; i++) await new Promise((r) => setTimeout(r, 20));
	assert.match(notes[0][0], /answer to btw/);
	assert.deepEqual(status.at(-1), ["ferry-btw", undefined]);
	s.close();
});

test("the recap is empty when it is off or the server fails, so the plain text stays", async () => {
	const s = await server();
	const cfg = { server: s.url, token: "t", recap: false };
	createSide(cfg);
	assert.equal(await cfg.recapText(ctx), "");
	assert.equal(s.seen.length, 0);
	cfg.recap = true;
	assert.equal(await cfg.recapText(ctx), "answer to recap");
	s.close();
	const dead = { server: "http://127.0.0.1:1", token: "t" };
	createSide(dead);
	assert.equal(await dead.recapText(ctx), "");
});

test("the review subagent is built in, read-only, and can read Office files", () => {
	const r = discoverAgents(process.env.FERRY_HOME).find((a) => a.name === "review");
	assert.ok(r);
	assert.ok(r.tools.includes("office_read"));
	assert.ok(!r.tools.some((t) => ["write", "edit", "bash"].includes(t)));
	assert.match(r.prompt, /did not make/);
});
