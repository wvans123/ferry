import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-mem-"));
const { _runMemory, scopeDir } = await import("../lib/memory.mjs");
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
