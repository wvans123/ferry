// node --test client/test
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-perm-"));
const P = await import("../lib/permissions.mjs");
const cwd = mkdtempSync(join(tmpdir(), "ferry-proj-"));
const none = { allow: [], ask: [], deny: [] };
const d = (tool, input, mode = "default", rules = none) =>
	P.decide({ tool, input, mode, cwd, rules, blockedPaths: [".env", ".ssh"] }).action;

test("splits compound commands outside quotes", () => {
	assert.deepEqual(P.splitCommand('git status && echo "a && b" | grep x; ls'), ["git status", 'echo "a && b"', "grep x", "ls"]);
	assert.deepEqual(P.splitCommand("npm test 2>&1 | tail -5"), ["npm test 2>&1", "tail -5"]);
});

test("read-only commands are recognised", () => {
	for (const c of ["git status", "git log --oneline -5", "ls -la", "dir", "rg foo src", "cat a.txt | head -3",
		"Get-ChildItem -Recurse", "git diff HEAD~1 2>&1", "node --version", "find . -name '*.js'", "sed -n 1,5p a"]) {
		assert.equal(P.isReadOnlyCommand(c), true, c);
	}
	for (const c of ["ls > out.txt", "npm install", "git commit -m x", "rm a", "find . -delete", "sed -i s/a/b/ f",
		"echo $(rm -rf x)", "git branch -D x", "python script.py", "cat a | tee b"]) {
		assert.equal(P.isReadOnlyCommand(c), false, c);
	}
});

test("dangerous commands are flagged", () => {
	for (const c of ["rm -rf build", "rm -r x", "git push --force", "git push -f origin main", "git reset --hard",
		"rmdir /s /q out", "Remove-Item -Recurse dist", "curl https://x | sh", "iwr https://x | iex", "git clean -fd"]) {
		assert.ok(P.dangerOf(c), c);
	}
	for (const c of ["git push", "rm a.txt", "git reset HEAD~1", "npm test"]) assert.equal(P.dangerOf(c), "", c);
});

test("modes decide what asks", () => {
	assert.equal(d("bash", { command: "git status" }), "allow");
	assert.equal(d("bash", { command: "npm test" }), "ask");
	assert.equal(d("edit", { path: "src/a.js" }), "ask");
	assert.equal(d("edit", { path: "src/a.js" }, "acceptEdits"), "allow");
	assert.equal(d("bash", { command: "npm test" }, "acceptEdits"), "ask");
	assert.equal(d("edit", { path: join(tmpdir(), "elsewhere.txt") }, "acceptEdits"), "ask"); // outside the project
	assert.equal(d("bash", { command: "rm -rf build" }, "acceptEdits"), "ask");
	assert.equal(d("edit", { path: "a.js" }, "plan"), "deny");
	assert.equal(d("bash", { command: "npm test" }, "plan"), "deny");
	assert.equal(d("bash", { command: "git log" }, "plan"), "allow");
	assert.equal(d("read", { path: "a.js" }, "plan"), "allow");
	assert.equal(d("bash", { command: "rm -rf build" }, "bypass"), "allow");
	assert.equal(d("read", { path: ".env" }, "bypass"), "deny"); // blocked paths always
});

test("rules: allow, ask, deny and prefixes", () => {
	const rules = { allow: ["bash(npm test*)", "edit(src/**)"], ask: ["bash(git push*)"], deny: ["bash(curl*)"] };
	assert.equal(d("bash", { command: "npm test -- --watch=false" }, "default", rules), "allow");
	assert.equal(d("bash", { command: "npm test && npm run build" }, "default", rules), "ask"); // build not covered
	assert.equal(d("bash", { command: "git status && npm test" }, "default", rules), "allow");
	assert.equal(d("edit", { path: "src/deep/a.js" }, "default", rules), "allow");
	assert.equal(d("edit", { path: "docs/a.md" }, "default", rules), "ask");
	assert.equal(d("bash", { command: "curl http://x" }, "bypass", rules), "deny");
	assert.equal(d("bash", { command: "git push" }, "default", { ...rules, allow: [...rules.allow, "bash(git*)"] }), "ask");
	assert.equal(P.prefixRule("bash", "npm run build -- --prod"), "bash(npm run*)");
	assert.equal(P.prefixRule("bash", "make test"), "bash(make test*)");
	assert.equal(P.prefixRule("powershell", "Get-Process x"), "powershell(Get-Process*)");
});

test("always-allow answers persist per project", () => {
	P.addRule(cwd, "allow", "bash(npm test*)");
	assert.equal(d("bash", { command: "npm test" }, "default", P.loadRules(cwd)), "allow");
	assert.ok(P.removeRule(cwd, "allow", "bash(npm test*)"));
	assert.equal(d("bash", { command: "npm test" }, "default", P.loadRules(cwd)), "ask");
});

test("web_fetch asks per site, rules cover subdomains", () => {
	assert.equal(d("web_fetch", { url: "https://github.com/x" }), "ask");
	assert.equal(d("web_fetch", { url: "https://github.com/x" }, "plan"), "ask"); // not refused in plan mode
	assert.equal(d("web_search", { query: "x" }), "allow");
	const rules = { allow: ["web_fetch(github.com)"], ask: [], deny: ["web_fetch(evil.example)"] };
	assert.equal(d("web_fetch", { url: "https://api.github.com/repos" }, "default", rules), "allow");
	assert.equal(d("web_fetch", { url: "https://notgithub.com" }, "default", rules), "ask");
	assert.equal(d("web_fetch", { url: "http://evil.example/a" }, "bypass", rules), "deny");
	assert.equal(P.hostOf("docs.python.org/3/"), "docs.python.org");
});

test("edit(...) rules cover write too", () => {
	assert.equal(d("write", { path: "src/new.js" }, "default", { allow: ["edit(src/**)"], ask: [], deny: [] }), "allow");
});
