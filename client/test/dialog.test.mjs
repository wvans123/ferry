import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { FerrySelectDialog, patchUISelect, selectDialog } from "../lib/dialog.mjs";

const plain = (lines) => lines.map((l) => stripTerminalSequences(l.replaceAll(CURSOR_MARKER, ""))).join("\n");

test("tall 60-line hw-ppt sync preview fits inside a 20-row terminal with all buttons visible and scrollable", () => {
	const fileLines = Array.from({ length: 60 }, (_, i) => `+ .ferry/skills/hw-ppt/references/sample_${String(i + 1).padStart(2, "0")}_中文缩略图名称.jpg (0 → 84210 bytes)`);
	const title = `上传到服务端 [全局 Skill 库] (Server r0)\n包含整包内容\n  hw-ppt：60 个文件, 4.8 MB (SKILL.md, scripts/×14, references/×45)\n${fileLines.join("\n")}`;
	const options = ["确认同步", "查看文本差异", "取消"];
	let picked = null;
	const dialog = new FerrySelectDialog(title, options, {
		tui: { terminal: { rows: 20, columns: 72 }, requestRender: () => {} },
		theme: null,
		keybindings: null,
		done: (v) => { picked = v; },
	});

	const frame1 = dialog.render(72);
	assert.ok(frame1.length <= 15, `expected <= 15 rows in 20-row terminal, got ${frame1.length}`);
	for (const line of frame1) {
		const w = visibleWidth(line.replaceAll(CURSOR_MARKER, ""));
		assert.ok(w <= 72, `line exceeded width 72: ${w}`);
	}
	const text1 = plain(frame1);
	// All three action buttons are visible on the very first frame!
	assert.match(text1, /→ 1\. 确认同步/);
	assert.match(text1, /2\. 查看文本差异/);
	assert.match(text1, /3\. 取消/);
	assert.match(text1, /详情第 1-/);
	assert.match(text1, /sample_01/);

	// Scroll body down via Right arrow and mouse wheel: buttons remain pinned while later files appear.
	dialog.handleInput("\x1b[C"); // Right arrow
	dialog.handleMouse({ type: "wheel", wheelDelta: 1, y: 2 });
	const text2 = plain(dialog.render(72));
	assert.doesNotMatch(text2, /sample_01/);
	assert.match(text2, /→ 1\. 确认同步/);

	// Down arrow moves selection visibly to option 2, number key '3' jumps to option 3, Enter returns exact original option.
	dialog.handleInput("\x1b[B"); // Down arrow
	assert.match(plain(dialog.render(72)), /→ 2\. 查看文本差异/);
	dialog.handleInput("1");
	dialog.handleInput("\r");
	assert.equal(picked, "确认同步");
});

test("long multi-line permission command keeps all 4 approval choices visible and supports mouse click", () => {
	const cmd = Array.from({ length: 28 }, (_, i) => `python -X utf8 -c "step_${i} = '${"x".repeat(90)}'"`).join(" &&\n");
	const options = [
		"Allow once",
		"Always allow in this project: bash(python*)",
		"Deny",
		"Deny, and tell the agent what to do instead",
	];
	let picked = null;
	const dialog = new FerrySelectDialog(`Allow bash?\n\n  ${cmd}`, options, {
		tui: { terminal: { rows: 22, columns: 80 }, requestRender: () => {} },
		theme: null,
		keybindings: null,
		done: (v) => { picked = v; },
	});

	const lines = dialog.render(80);
	assert.ok(lines.length <= 17);
	const out = plain(lines);
	for (const opt of ["Allow once", "Always allow", "Deny", "Deny, and tell"]) {
		assert.ok(out.includes(opt), `missing option ${opt}`);
	}

	// Click directly on the second option row ("Always allow...")
	const secondRow = dialog.lastLayout.optRowStart + 1;
	dialog.handleMouse({ type: "click", button: "left", y: secondRow });
	assert.equal(picked, options[1]);
});

test("patchUISelect routes through ui.custom, honors AbortSignal, and leaves plain test mocks intact", async () => {
	let fallbackCalled = 0;
	const mockUI = { select: async (_t, opts) => { fallbackCalled++; return opts[0]; } };
	patchUISelect(mockUI);
	assert.equal(await mockUI.select("title", ["A", "B"]), "A");
	assert.equal(fallbackCalled, 1);

	let activeComp = null;
	const customUI = {
		select: async () => { throw new Error("should use custom"); },
		custom: (factory) => new Promise((resolve) => {
			activeComp = factory({ terminal: { rows: 24, columns: 80 } }, null, null, (val) => resolve(val));
			activeComp.render(80);
		}),
	};
	patchUISelect(customUI);

	const p1 = customUI.select("Pick one", ["First", "Second"]);
	activeComp.handleInput("\x1b[B");
	activeComp.handleInput("\r");
	assert.equal(await p1, "Second");

	// AbortSignal (e.g. answered on phone) closes the terminal dialog cleanly with undefined.
	const ac = new AbortController();
	const p2 = selectDialog(customUI, "Approve?", ["Allow once", "Deny"], { signal: ac.signal });
	ac.abort();
	assert.equal(await p2, undefined);
});
