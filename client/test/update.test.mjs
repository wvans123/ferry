import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "ferry-update-"));
process.env.FERRY_HOME = join(home, "client");
const { allPythons, restartLocalServer, serverIn } = await import("../lib/setup.mjs");
const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const posix = process.platform !== "win32";

test("every Python is found once, by its own path", () => {
	const all = allPythons({});
	assert.ok(all.length >= 1);
	assert.ok(all.every((p) => isAbsolute(p)));
	assert.equal(new Set(all.map((p) => p.toLowerCase())).size, all.length);
});

test("a normal server install is told apart from one run from a source folder", { skip: !posix }, () => {
	const fake = (file) => {
		const f = join(home, `py-${Math.random().toString(36).slice(2)}`);
		writeFileSync(f, `#!/bin/sh\necho 0.24.0\necho ${file}\n`);
		chmodSync(f, 0o755);
		return f;
	};
	assert.deepEqual(serverIn(fake("/usr/lib/python3.12/site-packages/ferry_server/__init__.py")), { version: "0.24.0", installed: true });
	assert.deepEqual(serverIn(fake("/home/me/ferry/server/ferry_server/__init__.py")), { version: "0.24.0", installed: false });
	assert.deepEqual(serverIn(join(home, "no-such-python")), { version: "", installed: false });
});

test("an older server still running is replaced by the new one", { timeout: 60000 }, async () => {
	// the old server: answers /health with an old version and stops when asked (as Ferry servers do)
	let stopped = false;
	const old = http.createServer((req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url === "/admin/api/stop" && req.method === "POST") {
			stopped = true;
			res.end('{"ok":true}');
			setTimeout(() => old.close(), 50);
			old.closeAllConnections?.();
			return;
		}
		res.end(JSON.stringify({ ok: true, version: "0.1.0" }));
	});
	await new Promise((r) => old.listen(0, "127.0.0.1", r));
	const port = old.address().port;
	process.env.FERRY_SERVER_HOME = join(home, "server");
	process.env.DEEPSEEK_API_KEY ??= "test-key";
	const py = allPythons({}).find((p) => serverIn(p).version === VERSION);
	assert.ok(py, `no Python here has Ferry server ${VERSION}`);
	const line = await restartLocalServer(VERSION, py, port);
	assert.ok(stopped, "the old server was not asked to stop");
	assert.equal(line, `restarted: 0.1.0 -> ${VERSION} on port ${port}`);
	// nothing running: nothing to say; already the new version: says so
	assert.match(await restartLocalServer(VERSION, py, port), /^running /);
	const key = readFileSync(join(process.env.FERRY_SERVER_HOME, "admin-key"), "utf8").trim();
	await fetch(`http://127.0.0.1:${port}/admin/api/stop`, { method: "POST", body: "{}",
		headers: { Cookie: `ferry_admin=${key}`, "X-Ferry-Admin": "1" } }).catch(() => {});
	for (let i = 0; i < 20 && await fetch(`http://127.0.0.1:${port}/health`).then(() => true, () => false); i++) {
		await new Promise((r) => setTimeout(r, 200));
	}
	assert.equal(await restartLocalServer(VERSION, py, port), "");
});
