import assert from "node:assert/strict";
import { test } from "node:test";
import { installSteerKeys, steerNote } from "../lib/steer.mjs";

test("the note tells the agent it was interrupted, what it was doing, and to re-plan", () => {
	const n = steerNote({ doing: "running bash (npm test)", waitedFor: "bash (npm test)" }, 1, "fix the parser");
	assert.match(n, /interrupted you/);
	assert.match(n, /running bash \(npm test\); it was allowed to finish/);
	assert.match(n, /to-do item "fix the parser"/);
	assert.match(n, /1 tool call\(s\) you had started were not run/);
	assert.match(n, /which of your changes need undoing/);
	assert.match(n, /a question \(answer it in a few sentences, then carry on/);
	assert.match(n, /something the user forgot to say/);
	const m = steerNote({ doing: "writing your next step", partial: "First, I will delete" }, 0, "");
	assert.match(m, /What you had written so far .*"First, I will delete"/);
	assert.doesNotMatch(m, /tool call\(s\)/);
	// the request it was working on is quoted, so "no, in English" is read together with it
	const r = steerNote({ doing: "running web_search (6G)", request: "写一份 6G 数据开放的调研\n要中文" }, 0, "");
	assert.match(r, /working on their request "写一份 6G 数据开放的调研 要中文"/);
	assert.match(r, /the rest of the request still stands/);
});

test("the input box of this pi version can be patched", async () => {
	assert.equal(await installSteerKeys(), true);
});

test("the tab title names the conversation and the project, and shows when the agent works or waits", async () => {
	const { ferryTitle, installTitle } = await import("../lib/title.mjs");
	assert.equal(ferryTitle({ first: "fix the login bug", cwd: "/x/my-project", state: "working" }), "⏳ fix the login bug · my-project · Ferry");
	assert.equal(ferryTitle({ name: "release", first: "fix", cwd: "/x/p", state: "asking" }), "❓ release · p · Ferry");
	assert.equal(ferryTitle({ cwd: "/x/p", state: "idle" }), "new conversation · p · Ferry");
	assert.equal(await installTitle(), true);
});

test("a running tool gets a short grace period, then the interruption goes on", async () => {
	const { waitForTool, steerNote, STEER_GRACE_MS } = await import("../lib/steer.mjs");
	assert.equal(STEER_GRACE_MS, 3000);
	assert.equal(await waitForTool({ running: 0 }, 50), "idle", "nothing running: no waiting");
	// a tool that never ends: the wait stops at the limit
	const t0 = Date.now();
	assert.equal(await waitForTool({ running: 1 }, 80), "timeout");
	assert.ok(Date.now() - t0 >= 70 && Date.now() - t0 < 1000);
	// a tool that ends in time: released at once
	const st = { running: 1 };
	const w = waitForTool(st, 5000);
	setTimeout(() => st.waiter(), 20);
	const t1 = Date.now();
	assert.equal(await w, "finished");
	assert.ok(Date.now() - t1 < 1000);
	// the note says the command was stopped
	const n = steerNote({ doing: "running bash (sleep 60)", waitedFor: "bash (sleep 60)", stopped: true }, 0, "");
	assert.match(n, /running command was stopped and its output so far is above/);
	assert.doesNotMatch(n, /allowed to finish/);
});

test("the stopped command's result says the user interrupted", async () => {
	const { createSteer, steerState } = await import("../lib/steer.mjs");
	const h = {};
	createSteer()({ on: (n, f) => { h[n] = f; } });
	const ev = { toolName: "bash", isError: true, content: [{ type: "text", text: "partial\n\nCommand aborted" }] };
	assert.equal(h.tool_result(ev), undefined, "an ordinary failure is left alone");
	steerState.stopping = true;
	const r = h.tool_result(ev);
	steerState.stopping = false;
	assert.equal(r.content.length, 2);
	assert.match(r.content[1].text, /user interrupted/);
	assert.equal(r.content[0].text, "partial\n\nCommand aborted", "the partial output stays");
});
