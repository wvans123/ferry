import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "ferry-subview-"));
process.env.FERRY_HOME = home;
const { createTranscript, transcriptPath, SUBAGENTS_DIR } = await import("../lib/subagent.mjs");
const { subagentText, transcriptTail, widgetLine } = await import("../lib/jobs.mjs");
const { cleanOldFiles } = await import("../lib/config.mjs");

test("a transcript holds the task, each step and the report; results are cut, a follow-up appends", () => {
	const file = transcriptPath(3, "research", "Check new 3GPP contributions!");
	assert.equal(file.startsWith(SUBAGENTS_DIR), true);
	assert.match(file, /subagents[\\/]\d{4}-\d{2}-\d{2}[\\/]3-research-check-new-3gpp-contributions\.md$/);
	assert.match(transcriptPath("7.2", "general", "看 稿件"), /7\.2-general-看-稿件\.md$/);

	const t = createTranscript(file, "Subagent 3: research: check", { resultBytes: 100 });
	t.task("Find the latest CR on 38.331.");
	t.assistant("I will search first.");
	t.toolCall("web_search", { query: "38.331 CR" });
	t.toolResult("web_search", "x".repeat(500), false);
	t.report("Found CR 1234.");
	let text = readFileSync(file, "utf8");
	assert.match(text, /^# Subagent 3: research: check\n/);
	assert.match(text, /## Task .*\n\nFind the latest CR on 38\.331\./);
	assert.match(text, /### Assistant\n\nI will search first\./);
	assert.match(text, /### Tool call: web_search\n\n```json\n\{"query":"38\.331 CR"\}/);
	assert.match(text, /x{100}\n\.\.\.\(cut here: 500 bytes in all\)/);
	assert.doesNotMatch(text, /x{101}/);
	assert.match(text, /## Report .*\n\nFound CR 1234\./);

	// resume: a new writer on the same file adds to it, without a second title
	const again = createTranscript(file, "Subagent 3: research: check");
	again.task("Now also check 38.300.");
	again.error("Subagent stopped");
	text = readFileSync(file, "utf8");
	assert.equal(text.match(/^# /gm).length, 1);
	assert.ok(text.indexOf("Found CR 1234.") < text.indexOf("Now also check 38.300."));
	assert.match(text, /## Failed .*\n\nSubagent stopped/);
});

test("past the cap: one note, no more details, tasks and reports still written", () => {
	const file = join(home, "cap.md");
	const t = createTranscript(file, "cap", { maxBytes: 600 });
	t.task("first");
	for (let i = 0; i < 20; i++) t.toolResult("read", `line ${i} ${"y".repeat(40)}`, false);
	t.report("REPORT ONE");
	t.toolCall("read", { path: "late.txt" });
	t.task("second");
	t.report("REPORT TWO");
	const text = readFileSync(file, "utf8");
	assert.equal(text.match(/transcript reached/g).length, 1);
	assert.doesNotMatch(text, /late\.txt/);
	assert.doesNotMatch(text, /line 19/);
	assert.match(text, /REPORT ONE[\s\S]*second[\s\S]*REPORT TWO/);
});

test("the Running line shows a subagent's current step, cut to the width", () => {
	const job = { id: 3, kind: "subagent", name: "research: new contributions", status: "running" };
	assert.equal(widgetLine(job), "  #3 subagent: research: new contributions");
	job.agent = "research";
	job.steps = ["web_search \"38.331\"", "read docs/38331.pdf"];
	assert.equal(widgetLine(job), "  #3 research: read docs/38331.pdf");
	job.steps.push(`read ${"a".repeat(200)}`);
	const cut = widgetLine(job, 40);
	assert.equal(cut.length, 40);
	assert.ok(cut.endsWith("..."));
	assert.equal(widgetLine({ id: 4, kind: "command", name: "dev server" }), "  #4 command: dev server");
});

test("/tasks shows a running subagent's steps, then its report, and the transcript", () => {
	const file = join(home, "t.md");
	writeFileSync(file, Array.from({ length: 50 }, (_, i) => `row ${i}`).join("\n"));
	const job = { id: 5, kind: "subagent", status: "running", transcript: file };
	assert.match(subagentText(job), /^\(starting\)\n\nTranscript: /);
	job.steps = ["ls data", "read data/f03.txt"];
	assert.match(subagentText(job), /^Steps so far \(2\):\n {2}ls data\n {2}read data\/f03\.txt\n\nTranscript: .*t\.md$/);
	Object.assign(job, { status: "done", report: "ALL DONE" });
	assert.match(subagentText(job), /^ALL DONE\n\nTranscript: /);
	const tail = transcriptTail(job, 5);
	assert.equal(tail, "row 45\nrow 46\nrow 47\nrow 48\nrow 49");
	assert.equal(transcriptTail({ transcript: join(home, "none.md") }), "(no transcript yet)");
});

test("Ferry's own working files go after 7 days; recent ones and the kept names stay", () => {
	const dir = join(home, "jobs");
	const old = (p) => utimesSync(p, new Date(Date.now() - 8 * 86400_000), new Date(Date.now() - 8 * 86400_000));
	for (const n of ["111", "222", String(process.pid)]) mkdirSync(join(dir, n), { recursive: true });
	writeFileSync(join(dir, "old.md"), "x");
	old(join(dir, "111"));
	old(join(dir, "old.md"));
	old(join(dir, String(process.pid)));
	cleanOldFiles(dir, [String(process.pid)]);
	assert.equal(existsSync(join(dir, "111")), false);
	assert.equal(existsSync(join(dir, "old.md")), false);
	assert.equal(existsSync(join(dir, "222")), true);
	assert.equal(existsSync(join(dir, String(process.pid))), true);
	cleanOldFiles(join(home, "missing")); // no folder yet: nothing happens
});
