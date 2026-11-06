import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-subask-"));
const { createGuard, _state } = await import("../lib/guard.mjs");

function guard(opts, answer) {
	let handler;
	createGuard({ blockedPaths: [] }, opts)({ on: (_n, fn) => { handler = fn; }, getAllTools: () => [] });
	const proj = mkdtempSync(join(tmpdir(), "ferry-subask-proj-"));
	return (toolName, input) => handler({ toolName, input }, { cwd: proj, hasUI: false });
}

test("a subagent's question leaves a line before and a line after the answer in the main window", async () => {
	_state.mode = "default";
	const notes = [];
	const ui = { select: async () => "Allow once", notify: (t, kind) => notes.push([kind, t]), input: async () => "" };
	const call = guard({ ui, label: "research: find papers" });
	assert.equal(await call("bash", { command: "npm install left-pad" }), undefined);
	assert.equal(notes.length, 2);
	assert.match(notes[0][1], /Subagent \(research: find papers\) asks to run bash: npm install left-pad/);
	assert.match(notes[1][1], /Subagent \(research: find papers\): bash npm install left-pad: allowed once/);
	// a denial, and a long command is shortened
	notes.length = 0;
	const deny = guard({ ui: { ...ui, select: async () => "Deny" }, label: "x" });
	const r = await deny("bash", { command: `echo ${"a".repeat(400)} > out.txt` });
	assert.ok(r.block);
	assert.ok(notes[0][1].length < 260);
	assert.match(notes[1][1], /denied/);
});

test("the main agent's own questions get no extra lines", async () => {
	const notes = [];
	const ui = { select: async () => "Allow once", notify: (t) => notes.push(t), input: async () => "" };
	let handler;
	createGuard({ blockedPaths: [] })({ on: (_n, fn) => { handler = fn; }, getAllTools: () => [] });
	const proj = mkdtempSync(join(tmpdir(), "ferry-subask-main-"));
	assert.equal(await handler({ toolName: "bash", input: { command: "npm install x" } }, { cwd: proj, hasUI: true, ui }), undefined);
	assert.deepEqual(notes, []);
});
