import assert from "node:assert/strict";
import { test } from "node:test";
import { installSteerKeys, steerNote } from "../lib/steer.mjs";

test("the note tells the agent it was interrupted, what it was doing, and to re-plan", () => {
	const n = steerNote({ doing: "running bash (npm test)", waitedFor: "bash (npm test)" }, 1, "fix the parser");
	assert.match(n, /interrupted you/);
	assert.match(n, /running bash \(npm test\); it was allowed to finish/);
	assert.match(n, /to-do item "fix the parser"/);
	assert.match(n, /1 tool call\(s\) you had started were not run/);
	assert.match(n, /what was wrong and which of your changes need undoing/);
	const m = steerNote({ doing: "writing your next step", partial: "First, I will delete" }, 0, "");
	assert.match(m, /What you had written so far .*"First, I will delete"/);
	assert.doesNotMatch(m, /tool call\(s\)/);
});

test("the input box of this pi version can be patched", async () => {
	assert.equal(await installSteerKeys(), true);
});
