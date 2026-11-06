import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-subresume-"));
const { createKeeper } = await import("../lib/subagent.mjs");
const { trackSubagent } = await import("../lib/jobs.mjs");

const disposed = [];
const entry = (id) => ({ agent: { name: "research" }, session: { dispose: () => disposed.push(id) } });

test("finished subagents are kept for a follow-up, the latest five", () => {
	disposed.length = 0;
	const k = createKeeper(5);
	for (let id = 1; id <= 6; id++) k.done(id, entry(id), false);
	assert.deepEqual(k.ids(), [2, 3, 4, 5, 6]);
	assert.deepEqual(disposed, [1]); // the oldest goes, with its session
	assert.throws(() => k.take(1), /Subagent 1 is gone .*latest 5.*Start a fresh task with the full prompt/);
	// a follow-up takes it out while it runs, then it is the newest
	const e = k.take(2);
	assert.equal(e.agent.name, "research");
	assert.throws(() => k.take(2), /still working on a follow-up/);
	k.done(7, entry(7), false);
	assert.deepEqual(k.ids(), [3, 4, 5, 6, 7]); // 2 is busy, so nothing else is dropped
	k.done(2, e, false);
	assert.deepEqual(k.ids(), [4, 5, 6, 7, 2]);
	assert.deepEqual(disposed, [1, 3]);
});

test("a stopped run is not kept; shutdown drops them all", () => {
	disposed.length = 0;
	const k = createKeeper(5);
	k.done(1, entry(1), false);
	k.done(2, entry(2), true);
	assert.deepEqual(k.ids(), [1]);
	const e = k.take(1);
	k.done(1, e, true); // a follow-up that was stopped: the subagent is gone
	assert.deepEqual(k.ids(), []);
	assert.throws(() => k.take(1), /gone/);
	k.done(3, entry(3), false);
	k.done(4, entry(4), false);
	k.clear();
	assert.deepEqual(k.ids(), []);
	assert.deepEqual(disposed, [2, 1, 3, 4]);
});

test("a subagent still running cannot be resumed", () => {
	const k = createKeeper(5);
	const t = trackSubagent("explore: look around");
	assert.throws(() => k.take(t.job.id), new RegExp(`Subagent ${t.job.id} is still running`));
	t.end("done");
	assert.throws(() => k.take(t.job.id), /gone/);
});
