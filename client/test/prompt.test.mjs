import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-prompt-home-"));
const { createPrompt } = await import("../lib/prompt.mjs");

/** The system prompt Ferry writes for the main agent, or for a subagent. */
function promptOf(opts) {
	let handler;
	createPrompt({}, opts)({ on: (name, fn) => name === "before_agent_start" && (handler = fn) });
	const o = { contextFiles: [], selectedTools: ["read", "bash"], hiddenTools: [], toolSnippets: { read: "Read files" },
		toolGuidelines: {}, promptGuidelines: [], sections: {}, cwd: process.cwd() };
	handler({ systemPromptOptions: o }, { cwd: process.cwd() });
	return o.customPrompt;
}

test("the main agent says what it does while it works; both agents batch calls, act and keep the user's files", () => {
	const main = promptOf();
	const sub = promptOf({ subagent: true });
	assert.match(main, /# While you work/);
	assert.match(main, /Before the first tool call, say in one sentence/);
	assert.match(main, /Some messages come from Ferry, not the user/);
	assert.doesNotMatch(sub, /# While you work/);
	for (const p of [main, sub]) {
		assert.match(p, /make them in the same reply/);
		assert.match(p, /Once you know enough to act, act/);
		assert.match(p, /belong to the user/);
		assert.match(p, /The final reply must make sense on its own/);
	}
});
