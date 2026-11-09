import assert from "node:assert/strict";
import { test } from "node:test";

const { createLoop, parseLoop, everyText } = await import("../lib/loop.mjs");

/** Loads the loop module into a stand-in for pi; returns what it sends and the handlers to drive it. */
function load(minMs = 20, hasUI = true) {
	const sent = [];
	const notes = [];
	const widgets = [];
	const on = {};
	let command;
	let idle = true;
	createLoop({}, { minMs, secondMs: 1 })({ // "30s" passes in 30 ms
		sendMessage: (message, options) => sent.push({ text: message.content, display: message.display, options }),
		on: (name, fn) => (on[name] = fn),
		registerCommand: (_name, def) => (command = def),
	});
	const ctx = { hasUI, ui: { notify: (t, l) => notes.push({ t, l }), setWidget: (_k, v) => widgets.push(v) }, isIdle: () => idle };
	on.session_start({}, ctx);
	return { sent, notes, widgets, on, run: (args) => command.handler(args, ctx), setIdle: (v) => (idle = v) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("parseLoop: interval first, s/m/h/d, default 10 minutes, floor at the minimum", () => {
	assert.deepEqual(parseLoop("5m check CI"), { everyMs: 300_000, prompt: "check CI", every: "5m" });
	assert.deepEqual(parseLoop("2h look at the inbox"), { everyMs: 7_200_000, prompt: "look at the inbox", every: "2h" });
	assert.deepEqual(parseLoop("check the deploy"), { everyMs: 600_000, prompt: "check the deploy", every: "10m" });
	assert.deepEqual(parseLoop("10s poll", 60_000), { everyMs: 60_000, prompt: "poll", every: "1m" });
	assert.deepEqual(parseLoop("10s poll", 5_000), { everyMs: 10_000, prompt: "poll", every: "10s" });
	assert.deepEqual(parseLoop("30s poll", 20, 1), { everyMs: 30, prompt: "poll", every: "30s" });
	assert.match(parseLoop("").error, /Usage/);
	assert.match(parseLoop("5m").error, /Usage/);
	assert.match(parseLoop("2d x").error, /longest/);
	assert.equal(everyText(300_000), "5m");
	assert.equal(everyText(7_200_000), "2h");
	assert.equal(everyText(45_000), "45s");
});

test("a loop sends its prompt every interval as a Ferry message that starts a turn, and stops on request", async () => {
	const { sent, notes, widgets, run } = load();
	await run("30s LOOPTEST say tick");
	assert.match(notes.at(-1).t, /Loop #1: every 30s/);
	await sleep(75);
	assert.ok(sent.length >= 2 && sent.length <= 4, String(sent.length));
	assert.deepEqual(sent[0].options, { triggerTurn: true, deliverAs: "followUp" });
	assert.equal(sent[0].display, true);
	assert.match(sent[0].text, /^\(From Ferry, not the user: \/loop #1, every 30s, run 1\./);
	assert.match(sent[0].text, /\nLOOPTEST say tick$/);
	assert.match(sent[1].text, /run 2\./);
	assert.match(widgets.at(-1)[0], /\/loop #1 every 30s: LOOPTEST say tick \(\d+ runs\)/);
	await run("");
	assert.match(notes.at(-1).t, /Loops:\n#1 every 30s, \d+ runs: LOOPTEST say tick/);
	await run("stop 1");
	assert.match(notes.at(-1).t, /Stopped #1/);
	assert.equal(widgets.at(-1), undefined);
	const n = sent.length;
	await sleep(60);
	assert.equal(sent.length, n); // nothing after stop
	await run("");
	assert.match(notes.at(-1).t, /No loops/);
});

test("while the agent is busy and the last tick is still waiting, ticks are skipped, not piled up", async () => {
	const { sent, notes, on, run, setIdle } = load();
	setIdle(false);
	await run("20s LOOPTEST again");
	await sleep(75); // several intervals
	assert.equal(sent.length, 1); // the first tick is queued as a follow-up; the others are skipped
	on.agent_settled(); // the agent finished: the queued tick was taken up
	await sleep(30);
	assert.equal(sent.length, 2);
	await run("");
	assert.match(notes.at(-1).t, /#1 every 20s, 2 runs, \d+ skipped/);
	on.session_shutdown();
	const n = sent.length;
	await sleep(50);
	assert.equal(sent.length, n); // loops end with the window
});

test("usage, bad input, and no window", async () => {
	const { notes, run } = load();
	await run("5m");
	assert.match(notes.at(-1).t, /Usage/);
	await run("stop 9");
	assert.match(notes.at(-1).t, /No loop #9/);
	const other = load(20, false);
	const out = [];
	const w = process.stdout.write.bind(process.stdout);
	process.stdout.write = (s) => (out.push(String(s)), true);
	try {
		await other.run("5m anything");
	} finally {
		process.stdout.write = w;
	}
	assert.match(out.join(""), /needs the window/);
});
