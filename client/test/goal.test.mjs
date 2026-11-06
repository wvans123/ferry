// /goal: completion criteria agreed first, the user's changes kept, "achieved" checked against the criteria.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-goal-"));
const { createGoal } = await import("../lib/goal.mjs");
const { steerState } = await import("../lib/steer.mjs");

function load(hasUI = true) {
	const on = {};
	const pi = { entries: [], sent: [], users: [], on: (n, f) => (on[n] = f), fire: (n, e, c) => on[n]?.(e, c),
		registerTool: (t) => { pi.tool = t; }, registerCommand: (_n, c) => { pi.command = c.handler; },
		appendEntry: (_t, d) => pi.entries.push(structuredClone(d)), sendMessage: (...a) => pi.sent.push(a),
		sendUserMessage: (t) => pi.users.push(t) };
	createGoal({})(pi);
	const notes = [];
	const ctx = { hasUI, cwd: process.cwd(), ui: { notify: (t) => notes.push(t), setStatus() {} },
		sessionManager: { getBranch: () => [] }, waitForIdle: async () => {} };
	pi.fire("session_start", {}, ctx);
	const goal = () => pi.entries.at(-1);
	const call = async (params) => (await pi.tool.execute("1", params, undefined, undefined, ctx)).content[0].text;
	const section = () => { const sections = {}; pi.fire("before_agent_start", { systemPromptOptions: { sections } }, ctx); return sections.ferry_goal; };
	const settle = () => pi.fire("agent_before_settle", { outcome: "completed" }, ctx);
	return { pi, ctx, notes, goal, call, section, settle };
}

test("with a terminal the guide asks to agree on criteria once with ask_user; without one it asks for assumed criteria", async () => {
	const t = load(true);
	await t.pi.command("tidy the docs folder", t.ctx);
	assert.match(t.section(), /ask the user once with ask_user/);
	assert.match(t.section(), /goal_update status "criteria"/);
	const p = load(false);
	await p.pi.command("tidy the docs folder", p.ctx);
	assert.match(p.section(), /Nobody can answer questions in this run/);
	assert.doesNotMatch(p.section(), /ask_user/);
});

test("criteria are recorded in the goal, shown in /goal, the guide and every continue message", async () => {
	const t = load(false);
	await t.pi.command("tidy the docs folder", t.ctx);
	assert.match(t.settle().entries[0].content, /not recorded completion criteria yet/);
	assert.match(await t.call({ status: "criteria", criteria: ["every doc uses the glossary terms", "a list of changed files"] }), /Recorded 2/);
	assert.deepEqual(t.goal().criteria, ["every doc uses the glossary terms", "a list of changed files"]);
	assert.equal(t.goal().criteriaAssumed, true);
	assert.match(t.section(), /Completion criteria \(assumed[^\n]*\n1\. every doc uses the glossary terms\n2\. a list of changed files/);
	const cont = t.settle();
	assert.equal(cont.entries[0].customType, "ferry-goal-continue");
	assert.equal(cont.entries[0].display, false);
	assert.match(cont.entries[0].content, /^Continue working toward the goal/);
	assert.match(cont.entries[0].content, /2\. a list of changed files/);
	await t.pi.command("", t.ctx);
	assert.match(t.notes.at(-1), /1\. every doc uses the glossary terms/);
	assert.match(await t.call({ status: "criteria", criteria: [] }), /Give the criteria/);
});

test("what the user says while the goal runs is kept (last 10, cut short) and rides in continue messages and the note after a summary", async () => {
	const t = load(true);
	await t.pi.command("write the report", t.ctx);
	t.pi.fire("input", { text: "My goal: write the report", source: "extension" }, t.ctx);
	t.pi.fire("input", { text: "/model", source: "interactive" }, t.ctx);
	assert.equal(t.goal().changes, undefined, "Ferry's own messages and commands are not changes");
	t.pi.fire("input", { text: "use  British\nspelling", source: "interactive", streamingBehavior: "steer" }, t.ctx);
	steerState.redirecting = true;
	t.pi.fire("input", { text: "use British spelling", source: "interactive" }, t.ctx);
	steerState.redirecting = false;
	assert.deepEqual(t.goal().changes.map((c) => c.text), ["use British spelling"], "an interruption sends the same text again: kept once");
	for (let i = 0; i < 12; i++) t.pi.fire("input", { text: `change ${i} ${"x".repeat(400)}`, source: "interactive" }, t.ctx);
	const changes = t.goal().changes;
	assert.equal(changes.length, 10);
	assert.match(changes[0].text, /^change 2 /);
	assert.ok(changes[0].text.length <= 301);
	const cont = t.settle().entries[0].content;
	assert.match(cont, /Requirements the user changed since the start/);
	assert.match(cont, /- change 11 /);
	t.pi.fire("session_compact", { reason: "threshold" });
	const [msg, opts] = t.pi.sent.at(-1);
	assert.equal(msg.customType, "ferry-goal-note");
	assert.equal(msg.display, false);
	assert.equal(opts.deliverAs, "steer");
	assert.match(msg.content, /still working on the user's goal: write the report/);
	assert.match(msg.content, /- change 11 /);
	assert.doesNotMatch(t.section(), /change 11/, "the system prompt does not change with every message");
});

test("achieved without evidence for every criterion is sent back twice, then accepted", async () => {
	const t = load(true);
	await t.pi.command("ship it", t.ctx);
	await t.call({ status: "criteria", criteria: ["tests pass", "docs updated", "changelog line"] });
	assert.equal(t.goal().criteriaAssumed, false);
	let r = await t.call({ status: "achieved", summary: "done", checks: [{ criterion: 1, evidence: "npm test: 40 passed" }, { criterion: 2, evidence: " " }] });
	assert.match(r, /Not accepted yet: no evidence for criteria 2, 3/);
	assert.match(r, /3\. changelog line/);
	assert.equal(t.goal().status, "pursuing");
	r = await t.call({ status: "achieved", summary: "done", evidence: "all good" });
	assert.match(r, /criteria 1, 2, 3/);
	r = await t.call({ status: "achieved", summary: "done", checks: [{ criterion: 1, evidence: "npm test" }] });
	assert.match(r, /Goal marked achieved/);
	assert.equal(t.goal().status, "achieved");
	assert.match(t.goal().note, /no evidence for criteria 2, 3/);
});

test("achieved with evidence for each criterion is accepted at once; without criteria it works as before", async () => {
	const t = load(true);
	await t.pi.command("ship it", t.ctx);
	await t.call({ status: "criteria", criteria: ["tests pass", "docs updated"] });
	const r = await t.call({ status: "achieved", summary: "done",
		checks: [{ criterion: 1, evidence: "npm test: 40 passed" }, { criterion: 2, evidence: "USAGE.md has the section" }] });
	assert.match(r, /Goal marked achieved/);
	assert.match(t.goal().note, /1: npm test: 40 passed; 2: USAGE\.md has the section/);
	const old = load(true);
	await old.pi.command("ship it", old.ctx);
	assert.match(await old.call({ status: "achieved", summary: "done", evidence: "files exist" }), /Goal marked achieved/);
	const u = load(true);
	await u.pi.command("ship it", u.ctx);
	await u.call({ status: "criteria", criteria: ["tests pass"] });
	assert.match(await u.call({ status: "unmet", summary: "need the API key" }), /Goal marked unmet/);
});
