import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-compact-"));
const { AGENT_DIR, PI_RESERVE, applyCompactReserves, compactReserves, compactThreshold, ensureAgentDir, writeCompactReserves, DEFAULTS } =
	await import("../lib/config.mjs");
const { afterSummaryNote, createCompact } = await import("../lib/compact.mjs");

const m = (id, contextWindow, provider = "kiro") => ({ id, contextWindow, provider });
const cfg = (o = {}) => ({ compactAt: "90%", compactLimit: "400k", contextWindow: {}, ...o });

test("the threshold is compactAt of the window or compactLimit, whichever is smaller", () => {
	assert.equal(compactThreshold(128_000, cfg()), 115_200);
	assert.equal(compactThreshold(200_000, cfg()), 180_000);
	assert.equal(compactThreshold(1_000_000, cfg()), 400_000);
	assert.equal(compactThreshold(1_000_000, cfg({ compactLimit: "0" })), 900_000);
	assert.equal(compactThreshold(1_000_000, cfg({ compactAt: "50%", compactLimit: "600k" })), 500_000);
	assert.equal(compactThreshold(1_000_000, cfg({ compactAt: "off" })), 0);
	assert.equal(DEFAULTS.compactLimit, "200k");
});

test("pi's margin is window minus threshold, never below pi's own 16384", () => {
	const r = compactReserves([m("a", 128_000), m("b", 200_000), m("c", 1_000_000, "ferry")], cfg());
	// 128k: 90% leaves 12.8k, below pi's default, so pi's 16384 stays
	assert.deepEqual(r, { "kiro/a": PI_RESERVE, "kiro/b": 20_000, "ferry/c": 600_000 });
	// 99% of a 128k window would leave 1280: pi's default stays
	assert.equal(compactReserves([m("a", 128_000)], cfg({ compactAt: "99%" }))["kiro/a"], PI_RESERVE);
	// off: pi's rule, no entry
	assert.deepEqual(compactReserves([m("a", 128_000)], cfg({ compactAt: "off" })), {});
});

test("a size chosen with /context counts, but never above the server's", () => {
	const models = [m("a", 1_000_000), m("b", 128_000)];
	const r = compactReserves(models, cfg({ contextWindow: { a: 200_000, b: 500_000 } }));
	assert.equal(r["kiro/a"], 20_000); // 200k window, 90% = 180k
	assert.equal(r["kiro/b"], PI_RESERVE); // the server's 128k wins
});

test("settings are merged: the user's own entries stay, a model back on pi's rule loses the margin", () => {
	const s = { compaction: { keepRecentTokens: 20000, modelOverrides: { "kiro/a": { keepRecentTokens: 5000, reserveTokens: 1 }, "x/y": { reserveTokens: 7 } } } };
	applyCompactReserves(s, [m("a", 1_000_000)], cfg());
	assert.deepEqual(s.compaction.modelOverrides["kiro/a"], { keepRecentTokens: 5000, reserveTokens: 600_000 });
	assert.deepEqual(s.compaction.modelOverrides["x/y"], { reserveTokens: 7 });
	applyCompactReserves(s, [m("a", 1_000_000)], cfg({ compactAt: "off" }));
	assert.deepEqual(s.compaction.modelOverrides["kiro/a"], { keepRecentTokens: 5000 });
});

test("ensureAgentDir writes the margins and /context rewrites them", () => {
	const models = [m("auto", 1_000_000, "ferry")];
	ensureAgentDir("auto", models, "medium", "20k", cfg());
	const file = join(AGENT_DIR, "settings.json");
	let s = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(s.compaction.keepRecentTokens, 20000);
	assert.equal(s.compaction.modelOverrides["ferry/auto"].reserveTokens, 600_000);
	writeCompactReserves(models, cfg({ contextWindow: { auto: 128_000 } }));
	s = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(s.compaction.modelOverrides["ferry/auto"].reserveTokens, PI_RESERVE);
	assert.equal(s.compaction.keepRecentTokens, 20000);
});

function fakePi() {
	const on = {};
	const sent = [];
	return { on: (n, f) => (on[n] = f), fire: (n, e, ctx) => on[n]?.(e, ctx), sendMessage: (...a) => sent.push(a), sent };
}
const ctx = () => {
	const c = { hasUI: true, status: [], notes: [] };
	c.ui = { setStatus: (k, v) => c.status.push(v), notify: (t) => c.notes.push(t) };
	return c;
};

test("two failed summaries in a row stop the automatic ones until the next prompt, and the phone hears of it", () => {
	const pings = [];
	const pi = fakePi();
	createCompact({ phone: (...a) => pings.push(a) })(pi);
	const c = ctx();
	const fail = { reason: "threshold", aborted: false, errorMessage: "502" };
	assert.equal(pi.fire("session_before_compact", { reason: "threshold" }), undefined);
	pi.fire("session_compact_failed", fail, c);
	assert.equal(pi.fire("session_before_compact", { reason: "threshold" }), undefined, "one failure: try again");
	pi.fire("session_compact_failed", fail, c);
	assert.deepEqual(pi.fire("session_before_compact", { reason: "threshold" }), { cancel: true });
	assert.equal(pi.fire("session_before_compact", { reason: "manual" }), undefined, "/compact still works");
	assert.equal(pings.length, 1);
	assert.match(pings[0][0], /failed twice/);
	assert.ok(c.status.at(-1).includes("off for this request") && c.notes.length === 1);
	// the cancelled attempts are reported as aborted: they are not new failures
	pi.fire("session_compact_failed", { reason: "threshold", aborted: true }, c);
	assert.equal(pings.length, 1);
	// Ferry's own continuation does not reset; the user's next message does
	pi.fire("input", { source: "extension" }, c);
	assert.deepEqual(pi.fire("session_before_compact", { reason: "threshold" }), { cancel: true });
	pi.fire("input", { source: "interactive" }, c);
	assert.equal(pi.fire("session_before_compact", { reason: "threshold" }), undefined);
});

test("a summary that works in between starts the count again", () => {
	const pi = fakePi();
	createCompact({})(pi);
	const fail = { reason: "threshold", aborted: false };
	pi.fire("session_compact_failed", fail, ctx());
	pi.fire("session_compact", { reason: "threshold", compactionEntry: {} });
	pi.fire("session_compact_failed", fail, ctx());
	assert.equal(pi.fire("session_before_compact", { reason: "threshold" }), undefined);
});

test("after a summary one hidden message is kept in the conversation: changed files, loaded skills, the task list (paths only)", () => {
	const pi = fakePi();
	createCompact({}, { todoText: () => "[x] read spec\n[>] write CR\n[ ] review" })(pi);
	pi.fire("session_compact", { reason: "threshold", compactionEntry: { details: {
		readFiles: ["/p/a.txt", "/h/skills/office/SKILL.md"], modifiedFiles: ["/p/cr.docx", "/p/notes.md"] } } });
	assert.equal(pi.sent.length, 1);
	const [msg, opts] = pi.sent[0];
	assert.equal(msg.customType, "ferry-compact-note");
	assert.equal(msg.display, false);
	assert.equal(opts.deliverAs, "steer");
	assert.match(msg.content, /\/p\/cr\.docx/);
	assert.match(msg.content, /\/p\/notes\.md/);
	assert.match(msg.content, /skills\/office\/SKILL\.md/);
	assert.match(msg.content, /\[>\] write CR/);
	assert.doesNotMatch(msg.content, /a\.txt/, "files that were only read are not listed");
	const quiet = fakePi();
	createCompact({})(quiet);
	quiet.fire("session_compact", { reason: "threshold", compactionEntry: {} });
	assert.equal(quiet.sent.length, 0, "nothing to list: no message");
});

test("no note when there is nothing to list, and a long list is cut", () => {
	assert.equal(afterSummaryNote({ readFiles: ["/p/a"], modifiedFiles: [] }), "");
	const many = afterSummaryNote({ modifiedFiles: Array.from({ length: 40 }, (_, i) => `/p/f${i}`) });
	assert.match(many, /f39/);
	assert.match(many, /25 earlier/);
	assert.doesNotMatch(many, /f0\n/);
});
