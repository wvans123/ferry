import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-mem-"));
const { _runMemory, memorySection, scopeDir } = await import("../lib/memory.mjs");
const cwd = mkdtempSync(join(tmpdir(), "ferry-memcwd-"));
const save = (content, extra = {}) => _runMemory({ action: "save", scope: "user", name: "db", content, ...extra }, cwd);
const onDisk = () => readFileSync(join(scopeDir("user", cwd), "db.md"), "utf8");

test("saving under an existing name keeps the old content and returns it", () => {
	assert.match(save("Old: tests use the real database. Port 5433.").content[0].text, /Saved user memory "db"/);
	const r = save("New: tests use mocks.");
	assert.match(r.content[0].text, /nothing was saved/);
	assert.match(r.content[0].text, /Port 5433/);
	assert.match(r.content[0].text, /replace: true/);
	assert.match(onDisk(), /Port 5433/);
});

test("identical content is a no-op, replace: true overwrites", () => {
	assert.match(save("Old: tests use the real database. Port 5433.").content[0].text, /nothing to do/);
	assert.match(save("Merged: real database, port 5433, but mocks for the mailer.", { replace: true }).content[0].text, /Saved user memory "db"/);
	assert.match(onDisk(), /Merged/);
	assert.doesNotMatch(onDisk(), /Old:/);
});

test("the guide asks for confirmed approaches with Why / How to apply, merging, absolute dates and checking names", () => {
	const s = memorySection(cwd);
	assert.match(s, /confirms a non-obvious way of working/);
	assert.match(s, /"Why:" line .* "How to apply:" line/);
	assert.match(s, /look in the index for a memory that already covers the point/);
	assert.match(s, /absolute dates/);
	assert.match(s, /check that it still exists/);
	assert.match(s, /save what was non-obvious about it/);
	assert.doesNotMatch(s, /[^\n]\n {2}/, "wrapped lines are joined");
});
