import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-jobs-home-"));
const { createJobs, startCommand, startSubagentJob, stopJob } = await import("../lib/jobs.mjs");

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
