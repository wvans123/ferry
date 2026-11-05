import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findFerry } from "../lib/teamcli.mjs";

test("ferry team finds the ferry command Paperclip should start", () => {
	const dir = mkdtempSync(join(tmpdir(), "ferry-team-"));
	writeFileSync(join(dir, "ferry.cmd"), "@echo off\n");
	assert.equal(findFerry({ PATH: `C:\\nowhere;${dir}` }, "win32"), join(dir, "ferry.cmd"));
	assert.equal(findFerry({ PATH: "/nowhere" }, "linux"), "");
});

test("a team member has a memory of its own besides the shared project memory", async () => {
	process.env.FERRY_HOME ??= mkdtempSync(join(tmpdir(), "ferry-home-"));
	const { scopeDir, memorySection } = await import("../lib/memory.mjs");
	const cwd = join(tmpdir(), "team-project");
	mkdirSync(cwd, { recursive: true });
	delete process.env.PAPERCLIP_AGENT_ID;
	assert.equal(scopeDir("role", cwd), scopeDir("project", cwd)); // outside a team: just the project memory
	assert.doesNotMatch(memorySection(cwd), /role\) memory/);
	process.env.PAPERCLIP_AGENT_ID = "agent-1";
	assert.equal(scopeDir("role", cwd), join(scopeDir("project", cwd), "roles", "agent-1"));
	assert.match(memorySection(cwd), /shared by the whole team/);
	delete process.env.PAPERCLIP_AGENT_ID;
});

test("ferry team start opens the board once it answers, and gives up when Paperclip stops", async () => {
	const { whenUp } = await import("../lib/teamcli.mjs");
	const http = await import("node:http");
	let calls = 0;
	const s = http.createServer((req, res) => {
		calls++;
		res.writeHead(calls < 3 ? 503 : 200).end("{}");
	});
	await new Promise((r) => s.listen(0, "127.0.0.1", r));
	assert.equal(await whenUp(`http://127.0.0.1:${s.address().port}`, () => true, 10), true);
	assert.equal(calls, 3);
	s.close();
	assert.equal(await whenUp("http://127.0.0.1:9", () => false, 10), false);
});
