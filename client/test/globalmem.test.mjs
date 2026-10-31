import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-gmem-"));
const { _runGlobal, refreshGlobal, memorySection } = await import("../lib/memory.mjs");

test("global memory goes to the Ferry server and shows in the prompt", async () => {
	const store = new Map();
	let enabled = false;
	const srv = http.createServer((req, res) => {
		let body = "";
		req.on("data", (d) => { body += d; });
		req.on("end", () => {
			res.setHeader("content-type", "application/json");
			const name = decodeURIComponent(req.url.split("/").pop());
			if (!enabled && req.url !== "/v1/ferry/memory") { res.statusCode = 403; return res.end(JSON.stringify({ error: { message: "off" } })); }
			if (req.url === "/v1/ferry/memory") {
				return res.end(JSON.stringify({ enabled, index: [...store].map(([n, v]) => `- [${n}](${n}.md): ${v.description}`).join("\n") }));
			}
			if (req.method === "PUT") { store.set(name, JSON.parse(body)); return res.end(JSON.stringify({ ok: true, name })); }
			if (req.method === "GET") return res.end(JSON.stringify({ name, content: store.get(name)?.content }));
			if (req.method === "DELETE") { store.delete(name); return res.end(JSON.stringify({ ok: true })); }
		});
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const cfg = { server: `http://127.0.0.1:${srv.address().port}`, token: "t" };

	await assert.rejects(_runGlobal(cfg, { action: "save", name: "x", content: "y" }), /Global memory is off/);
	assert.doesNotMatch(memorySection(process.cwd()), /Global memory index/);

	enabled = true;
	const r = await _runGlobal(cfg, { action: "save", name: "Reply in Chinese", description: "language", content: "Always reply in Chinese." });
	assert.match(r.content[0].text, /Saved global memory "reply-in-chinese"/);
	const g = await refreshGlobal(cfg);
	assert.ok(g.enabled);
	assert.match(memorySection(process.cwd()), /Global memory index[^\n]*\n- \[reply-in-chinese\]/);
	assert.equal((await _runGlobal(cfg, { action: "read", name: "reply-in-chinese" })).content[0].text, "Always reply in Chinese.");
	await _runGlobal(cfg, { action: "delete", name: "reply-in-chinese" });
	assert.equal(store.size, 0);
	srv.close();
});
