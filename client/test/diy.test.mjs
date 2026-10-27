import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-diy-"));
const { globRe, runHook } = await import("../lib/hooks.mjs");
const { commandFiles } = await import("../lib/commands.mjs");
const { createStore } = await import("../lib/checkpoint.mjs");

test("hook globs", () => {
	assert.ok(globRe("**/*.{ts,tsx}").test("src/a/b.tsx"));
	assert.ok(globRe("**/*.ts").test("a.ts"));
	assert.ok(!globRe("src/*.ts").test("src/a/b.ts"));
	assert.ok(globRe("*.py").test("main.py"));
});

test("hooks run in the project folder and report failures", async () => {
	const r = await runHook("echo hi-$FERRY_X && exit 4", tmpdir(), { FERRY_X: "there" });
	assert.equal(r.code, 4);
	assert.match(r.output, /hi-there/);
});

test("a project command replaces a built-in one with the same name", () => {
	const proj = mkdtempSync(join(tmpdir(), "ferry-proj-"));
	mkdirSync(join(proj, ".ferry", "commands"), { recursive: true });
	writeFileSync(join(proj, ".ferry", "commands", "review.md"), "our review");
	const files = commandFiles(proj);
	assert.ok(files.some((f) => f.endsWith("init.md")));
	assert.deepEqual(files.filter((f) => f.endsWith("review.md")), [join(proj, ".ferry", "commands", "review.md")]);
});

test("undo restores changed files and removes created ones", () => {
	const dir = mkdtempSync(join(tmpdir(), "ferry-cp-"));
	const a = join(dir, "a.txt");
	const b = join(dir, "b.txt");
	writeFileSync(a, "one");
	const store = createStore(join(dir, ".cp"));
	store.begin("first");
	store.snapshot(a);
	writeFileSync(a, "two");
	store.begin("second");
	store.snapshot(a);
	store.snapshot(b);
	writeFileSync(a, "three");
	writeFileSync(b, "new");
	const done = store.undo(1);
	assert.equal(readFileSync(a, "utf8"), "one");
	assert.ok(!existsSync(b));
	assert.equal(done.length, 2);
	assert.equal(store.runs.length, 0);
});
