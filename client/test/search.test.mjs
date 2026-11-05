import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-search-"));
const { createWeb, searchServer } = await import("../lib/web.mjs");
const { discoverAgents } = await import("../lib/subagent.mjs");

/** A fake Ferry server (search answers as told) and a fake Bing page. */
async function servers(answer) {
	const seen = [];
	const s = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => { body += c; });
		req.on("end", () => {
			seen.push({ url: req.url, body, auth: req.headers.authorization });
			if (req.url.startsWith("/search")) { // Bing's result page
				res.setHeader("content-type", "text/html");
				res.end('<li class="b_algo"><h2><a href="https://bing.example/r">From Bing</a></h2><p>bing snippet</p></li>');
				return;
			}
			const [status, out] = answer(JSON.parse(body || "{}"));
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(out));
		});
	});
	await new Promise((r) => s.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${s.address().port}`;
	process.env.FERRY_TEST_SEARCH_BASE = base;
	return { base, seen, close: () => s.close() };
}

function searchTool(cfg) {
	const tools = {};
	createWeb(cfg)({ on() {}, registerTool: (t) => { tools[t.name] = t; } });
	return tools.web_search;
}

test("web_search asks the server's search engine when it has one; only the query leaves", async () => {
	const srv = await servers((b) => [200, { engine: "tavily", results: [{ title: "Agent memory", url: "https://github.com/x/mem", snippet: `about ${b.query}`, date: "2026-10-01T00:00:00Z" }] }]);
	const cfg = { server: srv.base, token: "tok", features: ["search"] };
	const r = await searchTool(cfg).execute("1", { query: "agent memory", recent: "month" });
	assert.match(r.content[0].text, /Agent memory \(2026-10-01\)\n {3}https:\/\/github.com\/x\/mem\n {3}about agent memory/);
	assert.equal(r.details.engine, "tavily");
	assert.deepEqual(JSON.parse(srv.seen[0].body), { query: "agent memory", count: 8, recent: "month" });
	assert.equal(srv.seen[0].auth, "Bearer tok");
	srv.close();
});

test("without a search engine on the server, or when it fails, web_search reads Bing's page", async () => {
	const srv = await servers(() => [502, { error: "Tavily answered HTTP 432: out of credits" }]);
	let r = await searchTool({ server: srv.base, features: [] }).execute("1", { query: "q" });
	assert.match(r.content[0].text, /From Bing/);
	assert.equal(srv.seen.filter((x) => x.url === "/v1/ferry/search").length, 0); // not asked at all
	r = await searchTool({ server: srv.base, features: ["search"] }).execute("1", { query: "q", recent: "week" });
	assert.match(r.content[0].text, /From Bing[\s\S]*search engine failed \(Tavily answered HTTP 432: out of credits\)[\s\S]*last week/);
	assert.equal(await searchServer({ server: srv.base, features: [] }, "q"), null);
	srv.close();
});

test("a research subagent is built in; a short agent file only changes its model", () => {
	const r = discoverAgents(process.env.FERRY_HOME).find((a) => a.name === "research");
	assert.ok(r && r.tools.includes("web_search") && r.tools.includes("web_fetch") && !r.tools.includes("edit"));
	mkdirSync(join(process.env.FERRY_HOME, "agents"), { recursive: true });
	writeFileSync(join(process.env.FERRY_HOME, "agents", "research.md"), "---\nname: research\nmodel: deepseek-flash\n---\n");
	const mine = discoverAgents(process.env.FERRY_HOME).find((a) => a.name === "research");
	assert.equal(mine.model, "deepseek-flash");
	assert.equal(mine.prompt, r.prompt);
	assert.deepEqual(mine.tools, r.tools);
});
