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
