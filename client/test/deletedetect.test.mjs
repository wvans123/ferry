import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-detect-home-"));
const P = await import("../lib/permissions.mjs");
const none = { allow: [], ask: [], deny: [] };
const fwd = (p) => p.replaceAll("\\", "/");

// a project with old files and files "made this session" (born after the session start; the clock is set back)
function setup() {
	const proj = mkdtempSync(join(tmpdir(), "ferry-detect-"));
	writeFileSync(join(proj, "old_1.txt"), "x");
	mkdirSync(join(proj, "out"));
	writeFileSync(join(proj, "out", "old.json"), "x");
	const session = { start: Date.now() + 60_000, made: new Set() };
	const mk = (rel) => {
		mkdirSync(join(proj, rel, ".."), { recursive: true });
		P.noteCreated(session, join(proj, rel));
		writeFileSync(join(proj, rel), "x");
	};
	return { proj, session, mk };
}
const verdict = (proj, session, command, mode = "default") =>
	P.decide({ tool: "bash", input: { command }, mode, cwd: proj, rules: none, session });

test("a glob: every match must be session-made; no match deletes nothing", () => {
	const { proj, session, mk } = setup();
	mk("tmp_a.txt");
	mk("tmp_b.txt");
	mk("out/new1.json");
	mk("out/new2.json");
	for (const mode of ["default", "acceptEdits", "bypass"]) {
		assert.equal(verdict(proj, session, "rm tmp_*.txt", mode).action, "allow", mode);
		assert.equal(verdict(proj, session, "rm -f out/new?.json", mode).action, "allow", mode);
		assert.equal(verdict(proj, session, "Remove-Item .\\out\\new[12].json", mode).action, "allow", mode);
		assert.equal(verdict(proj, session, "rm nothing_*.zip", mode).action, "allow", mode); // no match
	}
	const old = verdict(proj, session, "rm *.txt"); // old_1.txt is older than the session
	assert.equal(old.action, "ask");
	assert.ok(old.always);
	assert.match(old.danger, /old_1\.txt.*from \*\.txt.*did not create/);
	assert.equal(verdict(proj, session, "rm out/*.json").action, "ask"); // old.json is in there
	assert.match(verdict(proj, session, "rm out/*.json").danger, /old\.json/);
	// ** reaches into folders
	assert.equal(verdict(proj, session, "rm -rf **/new1.json").action, "allow");
	assert.equal(verdict(proj, session, "rm -rf **/*.json").action, "ask");
});

test("a glob that matches too many files cannot be listed", () => {
	const { proj, session } = setup();
	const big = join(proj, "many");
	mkdirSync(big);
	for (let i = 0; i < 2100; i++) writeFileSync(join(big, `f${i}.tmp`), "x");
	const v = verdict(proj, session, "rm many/*.tmp");
	assert.equal(v.action, "ask");
	assert.match(v.danger, /more than 2000 files/);
});

test("variables: known ones become real paths, unknown ones cannot be listed", () => {
	const env = { TEMP: join(tmpdir(), "ferry-vars-temp"), USERPROFILE: tmpdir(), LOCALAPPDATA: join(tmpdir(), "lad") };
	assert.equal(P.expandVars("%TEMP%\\x", env), `${env.TEMP}\\x`);
	assert.equal(P.expandVars("$env:TEMP\\x", env), `${env.TEMP}\\x`);
	assert.equal(P.expandVars("$TEMP/x", env), `${env.TEMP}/x`);
	assert.equal(P.expandVars("${TEMP}/x", env), `${env.TEMP}/x`);
	assert.equal(P.expandVars("%LOCALAPPDATA%\\a", env), `${env.LOCALAPPDATA}\\a`);
	assert.equal(P.expandVars("$env:temp\\x", env), `${env.TEMP}\\x`); // names are not case sensitive
	assert.ok(P.expandVars("~/x", env).endsWith("/x") && !P.expandVars("~/x", env).startsWith("~"));
	assert.equal(P.expandVars("$SOMETHING/x", env), null);
	assert.equal(P.expandVars("%NOPE%\\x", env), null);
	assert.equal(P.expandVars("a~b", env), "a~b"); // a ~ inside a name is just a character

	// end to end: a file made in the temp folder, deleted through a variable
	const dir = mkdtempSync(join(tmpdir(), "ferry-vars-"));
	const session = { start: Date.now() + 60_000, made: new Set() };
	const f = join(dir, "scratch.txt");
	P.noteCreated(session, f);
	writeFileSync(f, "x");
	const e = { TEMP: dir };
	assert.deepEqual(P.expandTarget("$TEMP/scratch.txt", process.cwd(), e), { paths: [f] });
	assert.equal(P.unsafeDeleteOf("rm $TEMP/scratch.txt", process.cwd(), [], session, e), "");
	assert.equal(P.unsafeDeleteOf("rm %TEMP%/scratch.txt", process.cwd(), [], session, e), "");
	assert.equal(P.unsafeDeleteOf("Remove-Item $env:TEMP\\scratch.txt", process.cwd(), [], session, e), "");
	assert.match(P.unsafeDeleteOf("rm $UNKNOWN/scratch.txt", process.cwd(), [], session, e), /cannot list.*variable Ferry does not know/);
	// something that was there before is still asked about
	const oldSession = { start: Date.now() + 60_000, made: new Set() };
	assert.match(P.unsafeDeleteOf("rm $TEMP/scratch.txt", process.cwd(), [], oldSession, e), /scratch\.txt.*did not create/);
	// a glob after a variable
	assert.equal(P.unsafeDeleteOf("rm -f $TEMP/*.txt", process.cwd(), [], session, e), "");
	void fwd;
});

test("cd dir && rm ...: relative targets follow the cd", () => {
	const { proj, session, mk } = setup();
	mk("work/a.tmp");
	mk("work/b.tmp");
	for (const mode of ["default", "acceptEdits", "bypass"]) {
		assert.equal(verdict(proj, session, "cd work && rm a.tmp", mode).action, "allow", mode);
		assert.equal(verdict(proj, session, "cd work; rm -f *.tmp", mode).action, "allow", mode);
		assert.equal(verdict(proj, session, `cd ${fwd(join(proj, "work"))} && rm a.tmp b.tmp`, mode).action, "allow", mode);
		assert.equal(verdict(proj, session, "Set-Location work; Remove-Item a.tmp", mode).action, "allow", mode);
	}
	// the same names in the project root are old files and not made by us: cd decides which file is meant
	writeFileSync(join(proj, "a.tmp"), "x");
	const session2 = { start: Date.now() + 60_000, made: new Set() };
	assert.equal(verdict(proj, session2, "rm a.tmp").action, "ask");
	// a cd that cannot be followed stays "cannot list"
	for (const c of ["cd work | rm a.tmp", "cd $(pwd)/work && rm a.tmp", "cd work && rm a.tmp & echo", "cd $NOPE && rm a.tmp"]) {
		const v = verdict(proj, session, c);
		assert.equal(v.action, "ask", c);
		assert.ok(v.always, c);
	}
});

test("the ask text says which target was not made by this session, or what could not be listed", () => {
	const { proj, session, mk } = setup();
	mk("mine.txt");
	const v = verdict(proj, session, "rm mine.txt old_1.txt");
	assert.match(v.danger, /deletes old_1\.txt, which Ferry did not create in this session/);
	assert.doesNotMatch(v.danger, /mine/);
	assert.match(verdict(proj, session, "find . -name '*.pyc' -delete").danger, /cannot list.*find\/xargs/);
	assert.match(verdict(proj, session, "git clean -fdx").danger, /cannot list.*git clean/);
	assert.match(verdict(proj, session, "ls | xargs rm").danger, /cannot list/);
	assert.match(verdict(proj, session, "rm $WHATEVER").danger, /cannot list.*\$WHATEVER uses a variable/);
});

test("a resumed conversation: its record brings back the start and what was made", () => {
	assert.equal(P.restoreSession([]), null);
	assert.equal(P.restoreSession([{ foo: 1 }, null]), null);
	const r = P.restoreSession([{ start: 1000 }, { add: ["/a/b"] }, { add: ["/c"] }, { start: 2000 }]);
	assert.equal(r.start, 1000);
	assert.deepEqual([...r.made].sort(), ["/a/b", "/c"]);
	// a file made before the restart (born after the conversation began, before this process) counts
	const { proj, mk } = setup();
	const early = Date.now() - 3_600_000;
	const session = { start: early, made: new Set() };
	mk("from-before-restart.txt");
	assert.equal(verdict(proj, session, "rm from-before-restart.txt").action, "allow");
	const fresh = P.newSession();
	fresh.start = Date.now() + 60_000; // a process that started after the file was made
	assert.equal(verdict(proj, fresh, "rm from-before-restart.txt").action, "ask");
	fresh.start = r.start; // restored: start of the conversation
	assert.equal(verdict(proj, fresh, "rm from-before-restart.txt").action, "allow");
});

test("the guard saves the conversation's record and restores it on resume", async () => {
	const { createGuard, _state } = await import("../lib/guard.mjs");
	const saved = [];
	const handlers = {};
	createGuard({})({ on: (n, fn) => { handlers[n] = fn; }, getAllTools: () => [], appendEntry: (type, data) => saved.push({ type: "custom", customType: type, data }) });
	const entries = [];
	const ctx = { cwd: mkdtempSync(join(tmpdir(), "ferry-detect-guard-")), hasUI: false, sessionManager: { getEntries: () => entries } };
	handlers.session_start({}, ctx); // a new conversation: the start is saved
	assert.equal(saved.length, 1);
	assert.ok(Number.isFinite(saved[0].data.start));
	_state.mode = "bypass";
	await handlers.tool_call({ toolName: "write", input: { path: "new.txt", content: "x" } }, ctx);
	assert.equal(saved.length, 2);
	assert.ok(saved[1].data.add.length >= 1);
	// resume: the records come back from the conversation
	_state.session = P.newSession();
	const firstStart = saved[0].data.start - 5000;
	entries.push({ type: "custom", customType: "ferry-made", data: { start: firstStart } }, saved[1]);
	handlers.session_start({}, ctx);
	assert.equal(_state.session.start, firstStart);
	assert.equal(_state.session.made.size, saved[1].data.add.length);
	assert.equal(saved.length, 2); // nothing new is saved when a record exists
	_state.mode = "default";
});
