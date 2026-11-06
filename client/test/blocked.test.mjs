import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-blocked-"));
const P = await import("../lib/permissions.mjs");
const NAMES = [".env", ".ssh", "id_rsa", "secrets", "credentials"];
const none = { allow: [], ask: [], deny: [] };
const cwd = mkdtempSync(join(tmpdir(), "ferry-blocked-proj-"));
const run = (tool, input, mode = "bypass") => P.decide({ tool, input, mode, cwd, rules: none, blockedPaths: NAMES });

test("plain text and code are not paths: no false alarm", () => {
	const text = [
		`echo "本次分析对比了 A/B 两个方案，secrets 和 credentials 管理相关内容见下文" > note.txt`,
		`agent-browser eval "fetch(url, {credentials:'include'}).then(r => r.text())"`,
		`agent-browser eval 'const r = await fetch("/api/x", { credentials: "include" }); return r.status'`,
		`python -c "print('rotate the secrets and credentials weekly')"`,
		"cat > notes.md <<'EOF'\nCheck .env and ~/.ssh/id_rsa handling in the doc, credentials too\nEOF",
		`git commit -m "document how secrets are stored"`,
		`grep -rn "credentials" src`,
		`echo "id_rsa is a key name"`,
	];
	for (const c of text) {
		assert.equal(P.blockedHit(c, NAMES), "", c);
		assert.notEqual(run("bash", { command: c }).action, "deny", c);
	}
});

test("real paths are still blocked", () => {
	const cmds = [
		"cat .env", "cat config/.env", "cat ./.env.local", "type C:\\Users\\x\\.ssh\\id_rsa", "cat ~/.ssh/id_rsa", "ls ~/.ssh",
		"cp secrets/key.pem out", "cat ./secrets/x", "cat secrets.json", "cat credentials.json", "cat secrets",
		`cat "config/.env"`, `cat 'C:\\x\\credentials'`, "cd .ssh && ls", "echo hi > .env", "scp id_rsa host:",
		"cat a.txt | tee secrets/out.txt", "FOO=.env cat $FOO", "cat ../credentials/token",
	];
	for (const c of cmds) {
		assert.ok(P.blockedHit(c, NAMES), c);
		const r = run("bash", { command: c });
		assert.equal(r.action, "deny", c);
		assert.match(r.reason, /not allowed by local policy/);
	}
});

test("file tools check their path the same way", () => {
	for (const p of [".env", "config/.env", "C:\\Users\\x\\.ssh\\id_rsa", "secrets/key.pem", "app/credentials.json", "~/.ssh/config"]) {
		for (const tool of ["read", "write", "edit"]) {
			assert.equal(run(tool, { path: p }).action, "deny", `${tool} ${p}`);
		}
	}
	for (const p of ["src/main.js", "docs/secrets-management.md", "notes/credentials-guide.txt", "envelope.txt"]) {
		assert.notEqual(run("read", { path: p }).action, "deny", p);
	}
	// office_read with an out folder
	assert.equal(run("office_read", { path: "a.docx", out: "secrets" }).action, "deny");
});
