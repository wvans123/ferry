// switch_mode: the agent asks to enter plan mode, or to leave it; the user decides every time.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-plan-"));
delete process.env.FERRY_AUTO_APPROVE;
delete process.env.FERRY_PERMISSION_MODE;
const { createModes, _state } = await import("../lib/guard.mjs");
const { decide } = await import("../lib/permissions.mjs");

/** A fake pi with createModes loaded; answers: "yes", "no" or undefined (Esc) for each question, in order. */
function load(mode = "default", answers = []) {
	const asked = [];
	const ui = { select: async (title, options) => { asked.push({ title, options }); const a = answers.shift();
		return a === "yes" ? options[0] : a === "no" ? options[1] : undefined; }, notify() {}, setStatus() {} };
	const pi = { on: (n, fn) => { pi[`on_${n}`] = fn; }, registerShortcut: (_k, s) => { pi.shiftTab = s.handler; },
		registerTool: (t) => { pi.tool = t; }, active: ["read", "switch_mode"], getActiveTools: () => pi.active,
		setActiveTools: (a) => { pi.active = a; } };
	createModes({ permissionMode: mode })(pi);
	const ctx = { hasUI: true, ui };
	pi.on_session_start({}, ctx);
	const turn = () => { const sections = {}; pi.on_before_agent_start({ systemPromptOptions: { sections } }); return sections; };
	const call = async (target, c = ctx) => {
		const r = await pi.tool.execute("1", { target, reason: "why" }, undefined, undefined, c);
		return { text: r.content[0].text, switched: r.details.switched };
	};
	return { pi, ctx, asked, turn, call, answers };
}

test("plan: asks every time; yes switches, no and Esc keep the mode", async () => {
	const t = load("acceptEdits", ["no", undefined, "yes"]);
	t.turn();
	assert.equal((await t.call("plan")).switched, false);
	assert.equal(_state.mode, "acceptEdits");
	assert.equal((await t.call("plan")).switched, false);
	assert.equal(_state.mode, "acceptEdits");
	const r = await t.call("plan");
	assert.equal(r.switched, true);
	assert.equal(_state.mode, "plan");
	assert.equal(t.asked.length, 3);
	assert.match(t.asked[0].title, /why/);
	assert.match(t.turn().ferry_mode, /switch_mode \(target back\)/);
	assert.match((await t.call("plan")).text, /already on/); // nothing to ask
	assert.equal(t.asked.length, 3);
});

test("back: asks, returns to the mode before plan; no keeps plan mode", async () => {
	const t = load("acceptEdits", ["yes", "no", "yes"]);
	t.turn();
	await t.call("plan");
	t.turn();
	assert.match((await t.call("back")).text, /stay in plan mode/);
	assert.equal(_state.mode, "plan");
	assert.match(t.asked[1].title, /auto-edit/); // the question names the mode it goes back to
	assert.equal((await t.call("back")).switched, true);
	assert.equal(_state.mode, "acceptEdits");
	assert.equal(t.turn().ferry_mode, undefined);
	assert.match((await t.call("back")).text, /not on/);
	assert.equal(t.asked.length, 3);
});

test("back never ends above the mode the user had: Shift+Tab into plan, full access", async () => {
	// default -> Shift+Tab twice (acceptEdits, plan): back goes to default
	let t = load("default", ["yes"]);
	t.turn();
	t.pi.shiftTab(t.ctx);
	t.pi.shiftTab(t.ctx);
	assert.equal(_state.mode, "plan");
	await t.call("back");
	assert.equal(_state.mode, "default");
	// working in auto-edit, one Shift+Tab: back to auto-edit
	t = load("acceptEdits", ["yes"]);
	t.turn();
	t.pi.shiftTab(t.ctx);
	await t.call("back");
	assert.equal(_state.mode, "acceptEdits");
	// full access, cycled down through default and auto-edit: never back to full access
	t = load("bypass", ["yes"]);
	t.turn();
	for (let i = 0; i < 3; i++) t.pi.shiftTab(t.ctx);
	assert.equal(_state.mode, "plan");
	await t.call("back");
	assert.equal(_state.mode, "acceptEdits");
	// full access, plan mode by the tool: back to full access
	t = load("bypass", ["yes", "yes"]);
	t.turn();
	await t.call("plan");
	await t.call("back");
	assert.equal(_state.mode, "bypass");
	// started in plan mode: back to default
	t = load("plan", ["yes"]);
	t.turn();
	await t.call("back");
	assert.equal(_state.mode, "default");
});

test("no UI: the tool is not offered, and answers that the user must switch", async () => {
	const t = load("default");
	const noUI = { hasUI: false };
	t.pi.on_session_start({}, noUI);
	assert.deepEqual(t.pi.active, ["read"]);
	t.turn();
	const r = await t.call("plan", noUI);
	assert.equal(r.switched, false);
	assert.match(r.text, /Only the user can switch/);
	assert.equal(_state.mode, "default");
	assert.equal(t.asked.length, 0);
});

test("switch_mode is read-only, so it works in plan mode; the plan-mode refusal names it", () => {
	const ro = (n) => n === "switch_mode";
	const d = (tool) => decide({ tool, input: {}, mode: "plan", cwd: process.cwd(), rules: { allow: [], ask: [], deny: [] }, readOnlyTool: ro });
	assert.equal(d("switch_mode").action, "allow");
	assert.match(decide({ tool: "write", input: { path: "a.txt" }, mode: "plan", cwd: process.cwd(),
		rules: { allow: [], ask: [], deny: [] } }).reason, /switch_mode \(target back\)/);
});
