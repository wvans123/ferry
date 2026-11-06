import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const HOME = mkdtempSync(join(tmpdir(), "ferry-distill-"));
process.env.FERRY_HOME = HOME;
const d = await import("../lib/distill.mjs");
const { _runMemory, listMemories, scopeDir } = await import("../lib/memory.mjs");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");

const SESSIONS = join(HOME, "agent", "sessions");
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function conversation(cwd, said) {
	const s = SessionManager.create(cwd, join(SESSIONS, `--${cwd.replace(/[^\w]+/g, "-")}--`));
	for (const text of said) {
		s.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
		s.appendMessage({ role: "assistant", content: [{ type: "text", text: `done: ${text}` },
			{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/x/skills/office/SKILL.md" } }], api: "openai-completions",
		provider: "ferry", model: "m", usage, stopReason: "stop", timestamp: Date.now() });
	}
	return s;
}

function fakeServer(answer) {
	const sent = [];
	const real = globalThis.fetch;
	globalThis.fetch = async (_url, init) => {
		const body = JSON.parse(init.body);
		sent.push(body);
		return new Response(JSON.stringify(answer(body)), { headers: { "content-type": "application/json" } });
	};
	return { sent, restore: () => { globalThis.fetch = real; } };
}

const cfg = { server: "http://ferry.test", token: "t", globalMemory: false };
const digestAnswer = (b) => ({ card: { goal: "build", category: "code", outcome: "done",
	corrections: [b.transcript.match(/\[User\]: (.*)/)[1], "a quote nobody wrote"], feedback: [{ after: "x", type: "corrected", quote: "invented" }] } });

test("cards: one per conversation with two user messages, reused while unchanged, made again when it grows", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "ferry-dproj-"));
	const a = conversation(cwd, ["Always give the file path first", "now the tests"]);
	conversation(cwd, ["just one message"]);
	const srv = fakeServer(digestAnswer);
	try {
		const ctx = { cwd, model: { id: "m" }, sessionManager: { getSessionFile: () => "" } };
		const first = await d.gatherCards(cfg, ctx);
		assert.equal(first.calls, 1);
		assert.equal(srv.sent[0].kind, "digest");
		assert.match(srv.sent[0].transcript, /^\[User\]: Always give the file path first/);
		const card = first.cards[0].card;
		assert.deepEqual(card.corrections, ["Always give the file path first"]);   // the invented quote is dropped
		assert.equal(card.feedback[0].quote, "");
		assert.deepEqual(card.read, ["skill:office"]);
		assert.equal(readdirSync(join(HOME, "memory", "digests")).length, 2);      // the short one is remembered too, without a card
		const again = await d.gatherCards(cfg, ctx);
		assert.equal(again.calls, 0);
		assert.equal(again.cards.length, 1);
		a.appendMessage({ role: "user", content: [{ type: "text", text: "and the docs" }], timestamp: Date.now() });
		a.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], api: "openai-completions", provider: "ferry", model: "m",
			usage, stopReason: "stop", timestamp: Date.now() });
		assert.equal((await d.gatherCards(cfg, ctx)).calls, 1);
		const busy = await d.gatherCards(cfg, { ...ctx, sessionManager: { getSessionFile: () => a.getSessionFile() } });
		assert.equal(busy.cards.length, 0);                                      // the conversation in progress is left out
	} finally {
		srv.restore();
	}
});

function sentCards(cwd, other) {
	const card = (q) => ({ goal: "g", corrections: [q], feedback: [] });
	return new Map([
		["aaaa1111", { id: "x-aaaa1111", cwd, date: "2026-11-01", card: card("Always give the file path first") }],
		["bbbb2222", { id: "x-bbbb2222", cwd, date: "2026-11-02", card: card("give the FILE path  first, please") }],
		["cccc3333", { id: "x-cccc3333", cwd: other, date: "2026-11-03", card: card("file path first") }],
	]);
}

test("checks: a quote must be on its card, enough different conversations per kind, project items count this project only", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ferry-dchk-"));
	const sent = sentCards(cwd, "/elsewhere");
	const ev = (s, quote) => ({ session: s, quote });
	const items = [
		{ kind: "memory", op: "add", target: "user", name: "path-first", content: "Give the path first.",
			evidence: [ev("aaaa1111", "give the file path first"), ev("x-bbbb2222", "file path first")] },
		{ kind: "memory", op: "add", target: "user", name: "faked", content: "x",
			evidence: [ev("aaaa1111", "file path first"), ev("bbbb2222", "something never said")] },
		{ kind: "memory", op: "add", target: "user", name: "same-twice", content: "x",
			evidence: [ev("aaaa1111", "path first"), ev("aaaa1111", "file path")] },
		{ kind: "rule", op: "add", target: "user-agents", name: "path-rule", content: "Path first.",
			evidence: [ev("aaaa1111", "path first"), ev("bbbb2222", "path first"), ev("cccc3333", "path first")] },
		{ kind: "rule", op: "add", target: "project-agents", name: "local-rule", content: "Path first.",
			evidence: [ev("aaaa1111", "path first"), ev("bbbb2222", "path first"), ev("cccc3333", "path first")] },
		{ kind: "rule", op: "add", target: "user-agents", name: "no-emoji", content: "x",
			evidence: [ev("aaaa1111", "path first"), ev("bbbb2222", "path first"), ev("cccc3333", "path first")] },
		{ kind: "habit", content: "State the goal first.", evidence: [ev("aaaa1111", "path first"), ev("cccc3333", "path first")] },
		{ kind: "memory", op: "add", target: "user", name: "invented-session", content: "x",
			evidence: [ev("zzzz9999", "path first"), ev("aaaa1111", "path first")] },
	];
	const { ok, dropped } = d.checkItems(items, sent, { cwd, never: [{ key: "rule:user-agents:no-emoji" }] });
	assert.deepEqual(ok.map((i) => i.name ?? i.kind), ["path-first", "path-rule", "habit"]);
	assert.equal(ok[0].sessions, 2);
	assert.deepEqual(ok[0].evidence.map((e) => [e.session, e.date]), [["aaaa1111", "2026-11-01"], ["bbbb2222", "2026-11-02"]]);
	const why = Object.fromEntries(dropped.map((x) => [x.name, x.why]));
	assert.match(why.faked, /evidence from 1 conversation, needs 2/);
	assert.match(why["same-twice"], /evidence from 1 conversation, needs 2/);
	assert.match(why["local-rule"], /evidence from 2 conversations in this project, needs 3/);
	assert.match(why["no-emoji"], /never to suggest/);
	assert.match(why["invented-session"], /needs 2/);
});

test("checks: pinned memories and your own skills are never changed; distill's own skills may be", () => {
	const cwd = mkdtempSync(join(tmpdir(), "ferry-dmark-"));
	const sent = sentCards(cwd, cwd);
	const ev = ["aaaa1111", "bbbb2222", "cccc3333"].map((session) => ({ session, quote: "path first" }));
	_runMemory({ action: "save", scope: "project", name: "signed", content: "The owner signs." }, cwd);
	writeFileSync(join(scopeDir("project", cwd), "signed.md"), "---\npinned: true\n---\nThe owner signs.\n", "utf8");
	mkdirSync(join(HOME, "skills", "mine"), { recursive: true });
	writeFileSync(join(HOME, "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: my own\n---\nsteps\n", "utf8");
	mkdirSync(join(HOME, "skills", "learned"), { recursive: true });
	writeFileSync(join(HOME, "skills", "learned", "SKILL.md"), "---\nname: learned\ndescription: old\nsource: ferry-distill\n---\nold steps\n", "utf8");
	const { ok, dropped } = d.checkItems([
		{ kind: "memory", op: "update", target: "project", name: "signed", content: "Nobody signs.", evidence: ev },
		{ kind: "skill", op: "update", target: "skill:mine", content: "new steps", evidence: ev },
		{ kind: "skill", op: "add", target: "skill:learned", content: "## When\nx\n## Steps\ny\n## Check\nz", description: "when x", evidence: ev },
		{ kind: "skill", op: "add", target: "skill:office", content: "x", evidence: ev },
		{ kind: "skill", op: "add", target: "skill:Bad_Name", content: "x", evidence: ev },
	], sent, { cwd, editable: new Set() });
	assert.deepEqual(ok.map((i) => `${i.op}:${i.name}`), ["update:learned"]);
	assert.deepEqual(dropped.map((x) => x.why.split(" ")[0]), ["changes", "a", "a", "a"]);
	assert.match(dropped[1].why, /you wrote yourself/);
	const r = d.applyItem(ok[0], cwd);
	assert.match(r.old, /old steps/);
	const now = readFileSync(join(HOME, "skills", "learned", "SKILL.md"), "utf8");
	assert.match(now, /^---\nname: learned\ndescription: "when x"\nsource: ferry-distill\n---\n## When/);
	assert.throws(() => d.applyItem({ kind: "skill", name: "mine", content: "x" }, cwd), /not one distill wrote/);
});

test("rules go into a marked block at the end of AGENTS.md; the rest of the file stays", () => {
	const own = "# My rules\n\nReply in Chinese.\n";
	const one = d.withRule(own, "path-first", "Give the file path first.");
	assert.ok(one.startsWith(own.trimEnd()));
	assert.match(one, /<!-- ferry-distill: start -->\n## Learned.*\n\n### path-first\nGive the file path first.\n\n<!-- ferry-distill: end -->\n$/);
	const two = d.withRule(`${one}\nMore of mine.\n`, "path-first", "Always give the file path first.\n### sneaky\n<!-- x -->");
	assert.equal(two.match(/ferry-distill: start/g).length, 1);
	assert.match(two, /### path-first\nAlways give the file path first.\nsneaky\n/);
	assert.match(two, /More of mine\.\n$/);
	assert.match(d.withRule(two, "tests", "Run the tests."), /### path-first[\s\S]*### tests\nRun the tests./);
});

test("a run with a terminal: Apply writes, the report keeps the old content, accepted and never-suggest are remembered", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "ferry-drun-"));
	conversation(cwd, ["Always give the file path first", "next"]);
	conversation(cwd, ["give the file path first please", "next"]);
	_runMemory({ action: "save", scope: "user", name: "answer-style", description: "how to answer", content: "Short answers." }, cwd);
	const srv = fakeServer((b) => {
		if (b.kind === "digest") return digestAnswer(b);
		const own = b.cards.filter((c) => c.card.corrections.length).slice(0, 2);
		const ev = own.map((c) => ({ session: c.session, date: c.date, quote: "file path first" }));
		return { items: [
			{ kind: "memory", op: "update", target: "user", name: "answer-style", content: "Short answers, file path first.", evidence: ev, reason: "said twice" },
			{ kind: "memory", op: "add", target: "user", name: "skip-me", content: "x", evidence: ev },
			{ kind: "habit", content: "Say the goal first.", evidence: ev },
			{ kind: "rule", op: "add", target: "user-agents", name: "too-few", content: "x", evidence: ev },
		], recurrence: [{ item: "old-thing", seen_again: false, evidence: "" }] };
	});
	const picks = ["Apply", "Never suggest this again"];
	const asked = [];
	const notes = [];
	const ctx = { hasUI: true, cwd, model: { id: "m" }, sessionManager: { getSessionFile: () => "" },
		ui: { select: async (t) => (asked.push(t), picks.shift()), notify: (t) => notes.push(t), setStatus: () => {} } };
	try {
		await d.distill(cfg, ctx);
	} finally {
		srv.restore();
	}
	const ask = srv.sent.find((b) => b.kind === "distill");
	assert.ok(ask.cards.length >= 2 && ask.cards.every((c) => c.new) && ask.memories.some((m) => m.name === "answer-style"));
	assert.equal(asked.length, 2);
	assert.match(asked[0], /^Distill \(1 of 2\)\nUpdate memory "answer-style" in your memory \(every project\)\n\nShort answers, file path first\.\n\nWhy: said twice\n\nEvidence \(2 conversations\):/);
	assert.equal(listMemories("user", cwd).find((m) => m.name === "answer-style").body, "Short answers, file path first.");
	assert.ok(!listMemories("user", cwd).some((m) => m.name === "skip-me"));
	const reports = readdirSync(join(HOME, "memory", "distill")).filter((f) => f.endsWith(".md"));
	const report = readFileSync(join(HOME, "memory", "distill", reports[0]), "utf8");
	assert.match(report, /## 1\. memory, user "answer-style": applied/);
	assert.match(report, /Old content:\n\n~~~~\n---\nupdated: \d{4}-\d{2}-\d{2}\n---\nShort answers\.\n~~~~/);
	assert.match(report, /"skip-me": never suggest again/);
	assert.match(report, /habit: noted\n\nSay the goal first\./);
	assert.match(report, /Dropped by Ferry's checks\n\n- rule user-agents "too-few": evidence from 2 conversations, needs 3/);
	assert.match(report, /old-thing: not seen again/);
	const state = d.loadState();
	assert.ok(state.last > 0);
	assert.deepEqual(state.accepted.map((a) => a.name), ["answer-style"]);
	assert.deepEqual(state.never.map((n) => n.key), ["memory:user:skip-me"]);
	assert.match(notes.at(-1), /^Distill: applied 1 of 2; 1 note about how you work .*Report: /);
});

test("without a terminal the proposals are printed and nothing changes", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "ferry-dprint-"));
	const before = existsSync(join(HOME, "memory", "distill", "state.json")) ? readFileSync(join(HOME, "memory", "distill", "state.json"), "utf8") : "";
	const srv = fakeServer((b) => (b.kind === "digest" ? digestAnswer(b) : { items: [{ kind: "memory", op: "add", target: "user", name: "printed",
		content: "Printed only.", evidence: b.cards.slice(0, 2).map((c) => ({ session: c.session, quote: c.card.corrections[0] ?? "x" })) }] }));
	const out = [];
	const write = process.stdout.write;
	process.stdout.write = (t) => (out.push(String(t)), true);
	try {
		await d.distill(cfg, { hasUI: false, cwd, model: { id: "m" }, sessionManager: { getSessionFile: () => "" } });
	} finally {
		process.stdout.write = write;
		srv.restore();
	}
	assert.match(out.join(""), /1\. New memory "printed"[\s\S]*Nothing was changed\. Run \/memory distill in the terminal/);
	assert.ok(!listMemories("user", cwd).some((m) => m.name === "printed"));
	assert.equal(readFileSync(join(HOME, "memory", "distill", "state.json"), "utf8"), before);
});

test("the start-of-conversation notice: only after 10 new conversations and 7 days, once a day", () => {
	const now = Date.now();
	const files = Array.from({ length: 12 }, (_, i) => ({ path: `s${i}`, size: 1, mtime: now - i * 3600_000 }));
	writeFileSync(join(HOME, "memory", "distill", "state.json"), JSON.stringify({ last: now - 3 * 86400_000 }));
	assert.equal(d.distillDue(now, files), null);                               // too soon
	writeFileSync(join(HOME, "memory", "distill", "state.json"), JSON.stringify({ last: now - 8 * 86400_000 }));
	assert.deepEqual(d.distillDue(now, files), { sessions: 12, days: 8 });
	assert.equal(d.distillDue(now, files.slice(0, 9)), null);                   // too few
	writeFileSync(join(HOME, "memory", "distill", "state.json"), JSON.stringify({ last: now - 8 * 86400_000, noticed: new Date(now).toLocaleDateString("sv-SE") }));
	assert.equal(d.distillDue(now, files), null);                               // already said today
	writeFileSync(join(HOME, "memory", "distill", "state.json"), "{}");
	assert.equal(d.distillDue(now, files), null);                               // never ran: count from now
	assert.equal(d.loadState().since, now);
});
