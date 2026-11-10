// /goal: completion criteria agreed first, the user's changes kept, "achieved" checked against the criteria.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-goal-"));
const { createGoal, parseVerdict, reviewPrompt } = await import("../lib/goal.mjs");
const { steerState } = await import("../lib/steer.mjs");

function load(hasUI = true, cfg = {}, deps = {}) {
	const on = {};
	const pi = { entries: [], sent: [], users: [], on: (n, f) => (on[n] = f), fire: (n, e, c) => on[n]?.(e, c),
		registerTool: (t) => { pi.tool = t; }, registerCommand: (_n, c) => { pi.command = c.handler; },
		appendEntry: (_t, d) => pi.entries.push(structuredClone(d)), sendMessage: (...a) => pi.sent.push(a),
		sendUserMessage: (t) => pi.users.push(t) };
	createGoal(cfg, deps)(pi);
	const notes = [];
	const ctx = { hasUI, cwd: process.cwd(), ui: { notify: (t) => notes.push(t), setStatus() {} },
		sessionManager: { getBranch: () => [] }, waitForIdle: async () => {} };
	pi.fire("session_start", {}, ctx);
	const goal = () => pi.entries.at(-1);
	const call = async (params) => (await pi.tool.execute("1", params, undefined, undefined, ctx)).content[0].text;
	const section = () => { const sections = {}; pi.fire("before_agent_start", { systemPromptOptions: { sections } }, ctx); return sections.ferry_goal; };
	const settle = (outcome = "completed") => pi.fire("agent_before_settle", { outcome }, ctx);
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

test("the phone console: the goal line, a message from the phone counts as a change, resume while still working sends nothing", async () => {
	const cfg = {};
	const t = load(true, cfg);
	assert.equal(cfg.goalNow(), null);
	await t.pi.command("tidy the docs folder", t.ctx);
	assert.deepEqual(cfg.goalNow(), { objective: "tidy the docs folder", status: "pursuing", turns: 0 });
	t.pi.fire("input", { text: "(from your phone) keep the old file names", source: "extension" }, t.ctx);
	t.pi.fire("input", { text: "Resume work on the goal", source: "extension" }, t.ctx);
	assert.deepEqual(t.goal().changes.map((c) => c.text), ["(from your phone) keep the old file names"]);
	const sent = t.pi.users.length;
	t.ctx.isIdle = () => false;
	await t.pi.command("pause", t.ctx);
	assert.equal(cfg.goalNow().status, "paused");
	await t.pi.command("resume", t.ctx);
	assert.equal(cfg.goalNow().status, "pursuing");
	assert.equal(t.pi.users.length, sent, "the running request simply goes on");
	await t.pi.command("pause", t.ctx);
	t.ctx.isIdle = () => true;
	await t.pi.command("resume", t.ctx);
	assert.match(t.pi.users.at(-1), /^Resume work on the goal: tidy the docs folder/);
});

const failedRun = (t, msg) => { t.ctx.sessionManager.getBranch = () => [{ type: "message", message: { role: "assistant", stopReason: "error", errorMessage: msg } }]; return t.settle("error"); };

test("an error ends a run: the goal is sent on after a wait, at most 3 times, then paused with a note and one phone push", async () => {
	const pushed = [];
	const cfg = { phone: (...a) => pushed.push(a) };
	const t = load(true, cfg, { retryMs: [5, 5, 5] });
	await t.pi.command("write the report", t.ctx);
	for (let n = 1; n <= 3; n++) {
		assert.equal(failedRun(t, "429 Too Many Requests\nsecond line"), undefined, "the hook does not block and does not continue by itself");
		assert.equal(t.pi.sent.length, n - 1, "nothing is sent before the wait is over");
		await sleep(40);
		const [msg, opts] = t.pi.sent.at(-1);
		assert.equal(msg.customType, "ferry-goal-continue");
		assert.equal(msg.display, false);
		assert.equal(opts.triggerTurn, true);
		assert.match(msg.content, new RegExp(`last request failed \\(429 Too Many Requests\\); this is retry ${n} of 3`));
		assert.match(msg.content, /Objective: write the report/);
	}
	assert.equal(t.goal().status, "pursuing");
	failedRun(t, "429 Too Many Requests\nsecond line");
	await sleep(40);
	assert.equal(t.pi.sent.length, 3, "no fourth retry");
	assert.equal(t.goal().status, "paused");
	assert.match(t.goal().note, /3 retries after an error did not help: 429 Too Many Requests$/);
	assert.equal(pushed.length, 1);
	assert.equal(pushed[0][0], "Goal paused");
	assert.match(pushed[0][1], /429 Too Many Requests.*\/goal resume continues it/);
	await t.pi.command("resume", t.ctx);
	assert.equal(t.goal().status, "pursuing");
});

test("a run without error resets the retry count; typing, pause and Esc cancel a waiting retry", async () => {
	const t = load(true, {}, { retryMs: [30, 30, 30] });
	await t.pi.command("write the report", t.ctx);
	failedRun(t, "boom");
	failedRun(t, "boom");
	failedRun(t, "boom");
	await sleep(5);
	t.settle("completed");
	for (let i = 0; i < 3; i++) failedRun(t, "boom");
	assert.notEqual(t.goal().status, "paused", "three errors again after a good run are three fresh retries");
	t.pi.fire("input", { text: "keep going please", source: "interactive" }, t.ctx);
	await sleep(60);
	assert.equal(t.pi.sent.length, 0, "a message from the user cancelled the waiting retry");
	failedRun(t, "boom");
	await t.pi.command("pause", t.ctx);
	await sleep(60);
	assert.equal(t.pi.sent.length, 0);
	await t.pi.command("resume", t.ctx);
	failedRun(t, "boom");
	t.settle("aborted");
	await sleep(60);
	assert.equal(t.pi.sent.length, 0);
	assert.equal(t.goal().status, "paused", "Esc pauses at once, no retry");
});

const withReviewer = (answers, extra = {}) => {
	const calls = [];
	const cfg = { runSubagent: async (o) => { calls.push(o); const a = answers.shift(); if (a instanceof Error) throw a; return a; }, ...extra };
	return { calls, cfg };
};
const claim = { status: "achieved", summary: "done", checks: [{ criterion: 1, evidence: "npm test: 40 passed" }, { criterion: 2, evidence: "USAGE.md has it" }] };
async function setup(cfg) {
	const t = load(true, cfg);
	await t.pi.command("ship it", t.ctx);
	t.pi.fire("input", { text: "also keep the old file names", source: "interactive" }, t.ctx);
	await t.call({ status: "criteria", criteria: ["tests pass", "docs updated"] });
	return t;
}

test("review: the reviewer gets only the facts; fail sends the agent back, pass marks the goal achieved", async () => {
	const r = withReviewer(["VERDICT: fail\n1. met\n2. not met: USAGE.md has no section", "VERDICT: pass\n1. met\n2. met"]);
	const t = await setup(r.cfg);
	let out = await t.call(claim);
	assert.match(out, /^Not accepted: an independent reviewer/);
	assert.match(out, /2\. not met: USAGE\.md has no section/);
	assert.match(out, /review 1 of 2/);
	assert.equal(t.goal().status, "pursuing");
	const p = r.calls[0];
	assert.equal(p.agent, "review");
	assert.deepEqual(p.tools, ["bash"]);
	assert.match(p.prompt, /Objective:\nship it/);
	assert.match(p.prompt, /1\. tests pass\n   Evidence the agent claims: npm test: 40 passed/);
	assert.match(p.prompt, /- also keep the old file names/);
	assert.match(p.prompt, new RegExp(`Working folder: ${process.cwd().replace(/[\\/]/g, ".")}`));
	assert.match(p.prompt, /VERDICT: pass/);
	out = await t.call(claim);
	assert.match(out, /Goal marked achieved/);
	assert.equal(t.goal().status, "achieved");
	assert.match(t.goal().note, /\[independently reviewed: pass\]$/);
});

test("review: two failed rounds, then the next report is accepted with the open findings in the note and the result", async () => {
	const r = withReviewer(["VERDICT: fail\nfirst problem", "VERDICT: fail\nsecond problem: no docs"]);
	const t = await setup(r.cfg);
	assert.match(await t.call(claim), /first problem/);
	assert.match(await t.call(claim), /second problem/);
	const out = await t.call(claim);
	assert.match(out, /Goal marked achieved/);
	assert.match(out, /still open:\nsecond problem: no docs/);
	assert.equal(r.calls.length, 2, "no third review");
	assert.match(t.goal().note, /review rounds used up; open findings from the last round: second problem: no docs/);
});

test("review: off, no subagents, a reviewer error or an answer without a verdict never block the goal", async () => {
	for (const [cfg, why] of [
		[{ goalReview: false, runSubagent: async () => "VERDICT: fail" }, /goalReview is off/],
		[{}, /subagents are off/],
		[withReviewer([new Error("HTTP 500\nmore")]).cfg, /the reviewer failed \(HTTP 500\)/],
		[withReviewer(["looks fine to me"]).cfg, /the reviewer gave no VERDICT line/],
	]) {
		const t = await setup(cfg);
		assert.match(await t.call(claim), /Goal marked achieved/);
		assert.match(t.goal().note, new RegExp(`\\[not independently reviewed: ${why.source}`));
	}
});

test("review: parseVerdict and the prompt without criteria", () => {
	assert.deepEqual(parseVerdict("\n VERDICT: PASS\nall good"), { pass: true, findings: "all good" });
	assert.equal(parseVerdict("**VERDICT: fail**\nx").pass, false);
	assert.equal(parseVerdict("Sure! VERDICT: pass"), null);
	assert.match(reviewPrompt({ objective: "o" }, [], "files exist", "/w"), /no criteria were recorded[\s\S]*General evidence: files exist/);
});
