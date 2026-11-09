import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-selfdel-home-"));
const P = await import("../lib/permissions.mjs");
const none = { allow: [], ask: [], deny: [] };
const fwd = (p) => p.replaceAll("\\", "/"); // a bash command takes C:/x on Windows

test("deleting what this session made never asks, wherever it is; in the other modes (not full access) anything else always asks", () => {
	const proj = mkdtempSync(join(tmpdir(), "ferry-selfdel-"));
	const outside = mkdtempSync(join(tmpdir(), "ferry-selfdel-out-"));
	writeFileSync(join(proj, "old.txt"), "x");
	writeFileSync(join(outside, "old.txt"), "x");
	const session = { start: Date.now() + 60_000, made: new Set() }; // everything on disk is older than the session
	P.noteCreated(session, join(proj, "mine.txt"));
	writeFileSync(join(proj, "mine.txt"), "x");
	P.noteCreated(session, join(outside, "mine.txt"));
	writeFileSync(join(outside, "mine.txt"), "x");
	const v = (command, mode, rules = none) => P.decide({ tool: "bash", input: { command }, mode, cwd: proj, rules, session });
	const allowRule = { allow: ["bash(rm*)"], ask: [], deny: [] };
	for (const mode of ["default", "acceptEdits", "bypass"]) {
		assert.equal(v("rm mine.txt", mode).action, "allow", mode); // in the project
		assert.equal(v(`rm -f ${fwd(join(outside, "mine.txt"))}`, mode).action, "allow", mode); // outside it, e.g. a temp folder
		assert.equal(v("rm mine.txt && echo done", mode).action, "allow", mode);
		for (const c of ["rm old.txt", `rm ${fwd(join(outside, "old.txt"))}`, "rm mine.txt old.txt", "rm -rf *.txt", "find . -delete"]) {
			if (mode === "bypass") { // full access: old files may go too (permissions.test.mjs covers what still asks)
				assert.equal(v(c, mode).action, "allow", `${mode}: ${c}`);
				continue;
			}
			const r = v(c, mode);
			assert.equal(r.action, "ask", `${mode}: ${c}`);
			assert.ok(r.always, `${mode}: ${c}`); // no "always allow"
			assert.equal(v(c, mode, allowRule).action, "ask", `${mode} with an allow rule: ${c}`);
		}
	}
	// a delete mixed with other work is not a pure delete: the mode's normal rules decide
	assert.equal(v("rm mine.txt && npm install", "default").action, "ask");
	assert.equal(v("rm mine.txt && npm install", "bypass").action, "allow");
	// blocked paths still win, and plan mode stays read-only
	assert.equal(P.decide({ tool: "bash", input: { command: "rm .env" }, mode: "default", cwd: proj, rules: none, session, blockedPaths: [".env"] }).action, "deny");
	assert.equal(v("rm mine.txt", "plan").action, "deny");
});

test("a file a command made in the system temp folder counts as made this session (by its birth time)", () => {
	const session = P.newSession();
	const f = join(mkdtempSync(join(tmpdir(), "ferry-birth-")), "scratch.txt");
	writeFileSync(f, "x"); // made after the session started, and not noted by any tool
	for (const mode of ["default", "acceptEdits", "bypass"]) {
		const r = P.decide({ tool: "bash", input: { command: `rm ${fwd(f)}` }, mode, cwd: process.cwd(), rules: none, session });
		assert.equal(r.action, "allow", mode);
	}
});
