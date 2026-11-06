import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-mem-"));
const { _runMemory, listMemories, loadIndex, memorySection, scopeDir } = await import("../lib/memory.mjs");
const review = await import("../lib/memreview.mjs");
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

test("a memory file gets an updated date, a read shows its age, pinned and other header lines survive a replace", () => {
	const today = new Date().toLocaleDateString("sv-SE");
	assert.match(onDisk(), new RegExp(`^---\\nupdated: ${today}\\n---\\nMerged`));
	assert.match(_runMemory({ action: "read", scope: "user", name: "db" }, cwd).content[0].text, new RegExp(`^\\(updated ${today}, today\\)\\n\\nMerged`));
	const file = join(scopeDir("user", cwd), "db.md");
	writeFileSync(file, "---\nupdated: 2026-01-02\npinned: true\ntype: feedback\n---\nPinned text\n");
	assert.match(save("Pinned text").content[0].text, /nothing to do/, "the header is not part of the content");
	save("Pinned text, merged", { replace: true });
	assert.match(onDisk(), new RegExp(`updated: ${today}\\npinned: true\\ntype: feedback\\n---\\nPinned text, merged`));
	writeFileSync(join(scopeDir("user", cwd), "old.md"), "An old memory without a header\n");
	const tenDays = new Date(Date.now() - 10 * 86400_000);
	utimesSync(join(scopeDir("user", cwd), "old.md"), tenDays, tenDays);
	assert.match(_runMemory({ action: "read", scope: "user", name: "old" }, cwd).content[0].text, /, 10 days ago\)\n\nAn old memory/);
});

test("a full index: new lines go first so they are loaded, and the model is told to merge", () => {
	const c2 = mkdtempSync(join(tmpdir(), "ferry-memfull-"));
	const dir = scopeDir("project", c2);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "MEMORY.md"), Array.from({ length: 210 }, (_, i) => `- [old-${i}](old-${i}.md): old note ${i}`).join("\n"));
	_runMemory({ action: "save", scope: "project", name: "fresh", description: "the newest note", content: "Fresh." }, c2);
	const idx = loadIndex(dir);
	assert.match(idx.split("\n")[0], /\[fresh\]/);
	assert.match(idx, /index cut at 200 lines: the oldest memories are not shown/);
	assert.match(memorySection(c2), /This index is nearly full: 211 lines.*\/memory tidy/);
	assert.doesNotMatch(memorySection(cwd), /nearly full/);
	_runMemory({ action: "save", scope: "project", name: "old-5", description: "changed", content: "Old five, updated." }, c2);
	assert.match(loadIndex(dir).split("\n")[0], /\[old-5\]\(old-5\.md\): changed/, "an updated memory moves to the top");
});

test("compact transcript: user and assistant text, tool results a line, the middle cut", () => {
	const msg = (role, content, extra = {}) => ({ type: "message", message: { role, content, ...extra } });
	const entries = [msg("user", "Always use pnpm here"), msg("assistant", [{ type: "text", text: "OK." }, { type: "toolCall", name: "bash" }]),
		msg("toolResult", [{ type: "text", text: "x".repeat(5000) }], { toolName: "bash" }), msg("user", [{ type: "text", text: "thanks" }])];
	const t = review.compactTranscript(entries);
	assert.match(t, /^\[User\]: Always use pnpm here\n\n\[Assistant\]: OK\.\n\n {2}\(bash result: x{200} \.\.\.\)\n\n\[User\]: thanks$/);
	const long = review.compactTranscript(Array.from({ length: 100 }, (_, i) => msg("user", `message ${i} ${"word ".repeat(100)}`)), 6000);
	assert.ok(long.length < 6100 && long.startsWith("[User]: message 0") && long.includes("middle is left out") && long.includes("message 99"));
});

test("a conversation is reviewed once, and again only after it grew", () => {
	assert.equal(review.needsReview("s1", 2), false);
	assert.equal(review.needsReview("s1", 3), true);
	review.markReviewed("s1", 3);
	assert.equal(review.needsReview("s1", 5), false);
	assert.equal(review.needsReview("s1", 6), true);
});

test("candidates: updates only of memories the model saw, never of pinned ones; an add never overwrites", () => {
	const c3 = mkdtempSync(join(tmpdir(), "ferry-memcand-"));
	_runMemory({ action: "save", scope: "project", name: "build", description: "how to build", content: "npm run build" }, c3);
	_runMemory({ action: "save", scope: "project", name: "keep", description: "pinned", content: "Keep me" }, c3);
	const keep = join(scopeDir("project", c3), "keep.md");
	writeFileSync(keep, readFileSync(keep, "utf8").replace("---\n", "---\npinned: true\n"));
	const { memories, editable } = review.editableMemories(c3);
	assert.deepEqual(memories.filter((m) => m.scope === "project").map((m) => m.name), ["build"]);
	const out = review.checkCandidates([
		{ action: "update", scope: "project", name: "build", content: "pnpm build" },
		{ action: "update", scope: "project", name: "keep", content: "changed" },
		{ action: "add", scope: "project", name: "build", content: "another build note" },
		{ action: "update", scope: "project", name: "new-one", content: "x" },
		{ action: "add", scope: "global", name: "nope", content: "x" },
	], c3, editable);
	assert.deepEqual(out.map((c) => `${c.action}:${c.name}`), ["update:build", "add:build-2", "add:new-one"]);
});

test("confirming: Save writes (an update replaces), Skip leaves it, Skip the rest stops", async () => {
	const c4 = mkdtempSync(join(tmpdir(), "ferry-memconf-"));
	_runMemory({ action: "save", scope: "project", name: "lang", description: "language", content: "Reply in English" }, c4);
	const picks = ["Save", "Skip", "Skip the rest"];
	const titles = [];
	const notes = [];
	const ctx = { ui: { select: async (t) => (titles.push(t), picks.shift()), notify: (t) => notes.push(t) } };
	await review.confirmCandidates(ctx, [
		{ action: "update", scope: "project", name: "lang", description: "", content: "Reply in Chinese\nWhy: the user asked", reason: "the user said so" },
		{ action: "add", scope: "project", name: "skipped", content: "x" },
		{ action: "add", scope: "project", name: "never", content: "y" },
		{ action: "add", scope: "project", name: "not-asked", content: "z" },
	], c4);
	assert.equal(titles.length, 3);
	assert.match(titles[0], /Remember this\? .*1 of 4\)\nUpdate project memory "lang"\n\nReply in Chinese\nWhy: the user asked\n\nWhy: the user said so/);
	const mem = listMemories("project", c4);
	assert.deepEqual(mem.map((m) => [m.name, m.body, m.description]), [["lang", "Reply in Chinese\nWhy: the user asked", "language"]]);
	assert.match(notes[0], /Saved 1 memory/);
});

test("a new conversation: the previous one goes to the server once, the proposals are shown and the accepted one saved", async () => {
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const c6 = mkdtempSync(join(tmpdir(), "ferry-memprev-"));
	const prev = SessionManager.create(c6, mkdtempSync(join(tmpdir(), "ferry-memsess-")));
	for (const text of ["Use pnpm, never npm", "build it", "thanks"]) {
		prev.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
		prev.appendMessage({ role: "assistant", content: [{ type: "text", text: `done: ${text}` }], api: "openai-completions", provider: "ferry",
			model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now() });
	}
	const sent = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		sent.push({ url, body: JSON.parse(init.body) });
		return new Response(JSON.stringify({ candidates: [{ action: "add", scope: "project", name: "uses-pnpm", description: "package manager",
			content: "Use pnpm.\nWhy: the user said so.\nHow to apply: every install.", reason: "you said: Use pnpm, never npm" }] }),
		{ headers: { "content-type": "application/json" } });
	};
	const handlers = {};
	review.createMemoryReview({ server: "http://ferry.test", token: "t", globalMemory: false })({ on: (n, h) => { handlers[n] = h; } });
	const asked = [];
	const ctx = { hasUI: true, cwd: c6, isIdle: () => true, model: { id: "m" },
		sessionManager: { getSessionFile: () => join(c6, "current.jsonl"), getBranch: () => [] },
		ui: { getEditorText: () => "", select: async (t) => (asked.push(t), "Save"), notify: () => {} } };
	const start = () => handlers.session_start({ reason: "new", previousSessionFile: prev.getSessionFile() }, ctx);
	try {
		start();
		for (let i = 0; i < 50 && !asked.length; i++) await new Promise((r) => setTimeout(r, 100));
		assert.equal(sent.length, 1);
		assert.equal(sent[0].url, "http://ferry.test/v1/ferry/memory-review");
		assert.equal(sent[0].body.kind, "propose");
		assert.match(sent[0].body.transcript, /^\[User\]: Use pnpm, never npm\n\n\[Assistant\]: done: Use pnpm, never npm/);
		assert.match(asked[0], /New project memory "uses-pnpm": package manager/);
		assert.deepEqual(listMemories("project", c6).map((m) => m.name), ["uses-pnpm"]);
		start(); // the same conversation again: already looked at
		await new Promise((r) => setTimeout(r, 1500));
		assert.equal(sent.length, 1);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("tidy: operations only on memories the model saw; a merge writes the result and removes the sources", () => {
	const c5 = mkdtempSync(join(tmpdir(), "ferry-memtidy-"));
	for (const n of ["a", "b", "c"]) _runMemory({ action: "save", scope: "project", name: n, description: `note ${n}`, content: `Note ${n}` }, c5);
	const { editable } = review.editableMemories(c5);
	const ops = review.checkOperations([
		{ op: "merge", scope: "project", sources: ["a", "b"], name: "ab", description: "a and b", content: "Notes a and b", reason: "same point" },
		{ op: "delete", scope: "project", name: "missing" },
		{ op: "merge", scope: "project", sources: ["a"], name: "a", content: "x" },
		{ op: "rewrite", scope: "user", name: "c", content: "x" },
		{ op: "delete", scope: "project", name: "c", reason: "stale" },
	], editable);
	assert.deepEqual(ops.map((o) => `${o.op}:${o.name}`), ["merge:ab", "delete:c"]);
	assert.match(review.describeOperation(ops[0]), /^Merge project memories "a" \+ "b" into "ab"\nWhy: same point\n\nNotes a and b$/);
	review.applyOperation(ops[0], c5);
	assert.deepEqual(listMemories("project", c5).map((m) => [m.name, m.body]), [["ab", "Notes a and b"], ["c", "Note c"]]);
	assert.throws(() => review.applyOperation(ops[0], c5), /no longer there/);
});
