import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-jobs-home-"));
const { createJobs, describeJob, startCommand, startSubagentJob, stopJob, watchTuning } = await import("../lib/jobs.mjs");

/** Loads the jobs module into a stand-in for pi; returns the messages it sends. */
function load(cfg, hasUI = true) {
	const sent = [];
	const on = {};
	createJobs(cfg)({
		sendMessage: (message, options) => sent.push({ text: message.content, options }),
		on: (name, fn) => (on[name] = fn),
		registerTool: () => {},
		registerCommand: () => {},
	});
	on.session_start({}, { hasUI, ui: { notify: () => {}, setWidget: () => {} } });
	return sent;
}

const ended = (job) => new Promise((resolve) => {
	const t = setInterval(() => job.ended && (clearInterval(t), resolve()), 20);
});

test("in the window, a background job that ends starts the agent's next step (or a turn of its own)", async () => {
	const sent = load({});
	const job = startCommand("echo napped", "napper", process.cwd());
	await ended(job);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].options, { triggerTurn: true, deliverAs: "steer" });
	assert.match(sent[0].text, /Background job \d+ \(napper\) exited with code 0/);
	assert.match(sent[0].text, /napped/);
	assert.match(sent[0].text, /From Ferry, not the user/);

	const sub = startSubagentJob("explore: look around", async () => "REPORT: three files");
	await ended(sub);
	assert.deepEqual(sent[1].options, { triggerTurn: true, deliverAs: "steer" });
	assert.match(sent[1].text, /Background subagent \d+ \(explore: look around\) finished\.\nReport:\nREPORT: three files/);
});

test("a job you stopped, wakeOnJobEnd = false, or no window: the agent hears with your next message", async () => {
	let sent = load({});
	const job = startCommand("sleep 5", "long", process.cwd());
	stopJob(job);
	await ended(job);
	assert.deepEqual(sent.at(-1).options, { deliverAs: "nextTurn" });
	assert.doesNotMatch(sent.at(-1).text, /From Ferry/);

	for (const [cfg, hasUI] of [[{ wakeOnJobEnd: false }, true], [{}, false]]) {
		sent = load(cfg, hasUI);
		const quick = startCommand("echo hi", "quick", process.cwd());
		await ended(quick);
		assert.deepEqual(sent.at(-1).options, { deliverAs: "nextTurn" });
	}
});

test("a watched job: each batch of lines reaches the agent while it runs; the end brings no repeat", async () => {
	watchTuning.windowMs = 150;
	const sent = load({});
	const job = startCommand("echo one; echo two; sleep 0.6; echo three; sleep 0.6; printf 'four\\nfive'", "poller", process.cwd(), { watch: true });
	await ended(job);
	await new Promise((r) => setTimeout(r, 50));
	const watched = sent.filter((m) => m.text.startsWith("Watched job"));
	assert.equal(watched.length, 3, JSON.stringify(sent.map((m) => m.text)));
	assert.match(watched[0].text, /\(poller\) printed:\none\ntwo\n\(From Ferry, not the user: output from a job you started with watch/);
	assert.equal(watched[1].text.split("\n")[1], "three");
	assert.match(watched[2].text, /printed:\nfour\nfive\n/); // the last line without a newline is delivered at the end
	assert.deepEqual(watched[0].options, { triggerTurn: true, deliverAs: "steer" });
	const end = sent.at(-1).text;
	assert.match(end, /Background job \d+ \(poller\) exited with code 0\./);
	assert.doesNotMatch(end, /Last output/); // the lines were delivered already
	assert.match(describeJob(job), /watched command done/);
	watchTuning.windowMs = 2000;
});

test("a watched job that floods: one message per window, cut to maxLines, pointing at job_output", async () => {
	watchTuning.windowMs = 150;
	watchTuning.maxLines = 5;
	const sent = load({});
	const job = startCommand("for i in $(seq 1 12); do echo line-$i; done", "flood", process.cwd(), { watch: true });
	await ended(job);
	await new Promise((r) => setTimeout(r, 50));
	const watched = sent.filter((m) => m.text.startsWith("Watched job"));
	assert.equal(watched.length, 1);
	assert.match(watched[0].text, /line-1\nline-2\nline-3\nline-4\nline-5\n\(\.\.\. 7 more lines; job_output \d+ shows them all\)/);
	watchTuning.windowMs = 2000;
	watchTuning.maxLines = 40;
});

test("a stopped watch job delivers nothing more", async () => {
	watchTuning.windowMs = 150;
	const sent = load({});
	const job = startCommand("echo early; sleep 5; echo late", "stopper", process.cwd(), { watch: true });
	await new Promise((r) => setTimeout(r, 400));
	stopJob(job);
	await ended(job);
	const watched = sent.filter((m) => m.text.startsWith("Watched job"));
	assert.equal(watched.length, 1);
	assert.match(watched[0].text, /early/);
	assert.match(sent.at(-1).text, /was stopped/);
	watchTuning.windowMs = 2000;
});
