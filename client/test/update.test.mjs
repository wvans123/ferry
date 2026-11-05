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

// needs a Python with this version's server installed (CI and a developer's checkout with pip install -e server)
const serverPython = allPythons({}).find((p) => serverIn(p).version === VERSION);

test("an older server still running is replaced by the new one", { timeout: 60000,
	skip: serverPython ? false : `no Python here has Ferry server ${VERSION} (pip install -e server)` }, async () => {
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
	const py = serverPython;
	const line = await restartLocalServer(VERSION, py, port).finally(() => !stopped && old.close());
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

test("a small package takes the dependencies over from the installed version, by links", async () => {
	const { completeSmallPackage, linkTree } = await import("../lib/setup.mjs");
	const { existsSync, mkdirSync, readdirSync, statSync } = await import("node:fs");
	const deps = { version: "1.0.0", node: "n1", python: "p1", tools: "t1" };
	const make = (dir, files) => {
		for (const [f, text] of Object.entries(files)) {
			mkdirSync(join(dir, f, ".."), { recursive: true });
			writeFileSync(join(dir, f), text);
		}
	};
	const installed = join(home, "installed");
	make(installed, { "deps.json": JSON.stringify(deps), "node_modules/a/index.js": "a", "vendor/win32-x64/rg.exe": "rg",
		"wheels/fastapi-1.whl": "w", "wheels/ferry_server-1.0.0-py3-none-any.whl": "old" });
	const small = join(home, "small");
	make(small, { "deps.json": JSON.stringify({ ...deps, version: "1.0.1" }), "small-package.json": "{}",
		"client/bin/ferry.mjs": "", "wheels/ferry_server-1.0.1-py3-none-any.whl": "new" });
	assert.equal(completeSmallPackage(small, installed), true);
	assert.equal(statSync(join(small, "node_modules/a/index.js")).ino, statSync(join(installed, "node_modules/a/index.js")).ino);
	assert.ok(existsSync(join(small, "vendor/win32-x64/rg.exe")));
	assert.deepEqual(readdirSync(join(small, "wheels")).sort(), ["fastapi-1.whl", "ferry_server-1.0.1-py3-none-any.whl"]);
	assert.equal(existsSync(join(small, "small-package.json")), false);

	// other dependencies: refused, the full package is needed
	const other = join(home, "other");
	make(other, { "deps.json": JSON.stringify({ ...deps, node: "n2" }), "small-package.json": "{}" });
	assert.throws(() => completeSmallPackage(other, installed), /use the full ferry-windows zip/);
	// a full package is left as it is
	const full = join(home, "full");
	make(full, { "deps.json": JSON.stringify(deps), "node_modules/b.js": "b" });
	assert.equal(completeSmallPackage(full, installed), false);
	// linking twice is harmless
	linkTree(join(installed, "node_modules"), join(full, "node_modules"));
	assert.ok(existsSync(join(full, "node_modules/a/index.js")) && existsSync(join(full, "node_modules/b.js")));
});
