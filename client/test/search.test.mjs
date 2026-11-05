import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
	assert.deepEqual(JSON.parse(srv.seen[0].body), { query: "agent memory", count: 8, recent: "month", allowed_domains: [], blocked_domains: [] });
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
	writeFileSync(join(process.env.FERRY_HOME, "agents", "research.md"), "---\nname: research\nmodel: deepseek-think\n---\n");
	const mine = discoverAgents(process.env.FERRY_HOME).find((a) => a.name === "research");
	assert.equal(mine.model, "deepseek-think");
	assert.equal(mine.prompt, r.prompt);
	assert.deepEqual(mine.tools, r.tools);
});

test("web_search limits results to sites: through the server, or written into Bing's query", async () => {
	const srv = await servers(() => [200, { engine: "tavily", results: [] }]);
	try {
		await searchTool({ server: srv.base, features: ["search"] }).execute("1", { query: "TS 38.300", allowed_domains: ["https://www.3gpp.org/", "bad domain"] });
		assert.deepEqual(JSON.parse(srv.seen[0].body).allowed_domains, ["www.3gpp.org"]);
		await searchTool({ server: srv.base, features: [] }).execute("1", { query: "x", blocked_domains: ["reddit.com", "zhihu.com"] });
		assert.equal(decodeURIComponent(srv.seen.at(-1).url).replace(/\+/g, " "), "/search?q=x -site:reddit.com -site:zhihu.com&setlang=zh-Hans");
	} finally {
		srv.close();
	}
});

/** A site with a long page, a PDF and a counter; plus the Ferry server's /v1/ferry/extract. */
async function site(extract) {
	const hits = {};
	const s = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => { body += c; });
		req.on("end", () => {
			hits[req.url] = (hits[req.url] ?? 0) + 1;
			if (req.url === "/v1/ferry/extract") {
				const [status, out] = extract(JSON.parse(body));
				res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(out));
			} else if (req.url === "/spec.pdf") {
				res.writeHead(200, { "content-type": "application/pdf" }).end("%PDF-1.4 fake");
			} else {
				res.writeHead(200, { "content-type": "text/html" }).end(`<html><title>Spec</title><body><h1>Clause 5.1</h1><p>${"word ".repeat(30000)}</p><p>The value is 42.</p></body></html>`);
			}
		});
	});
	await new Promise((r) => s.listen(0, "127.0.0.1", r));
	return { base: `http://127.0.0.1:${s.address().port}`, hits, close: () => s.close() };
}

function fetchTool(cfg) {
	const tools = {};
	createWeb(cfg)({ on() {}, registerTool: (t) => { tools[t.name] = t; } });
	return tools.web_fetch;
}

test("web_fetch with a question: the server reads the page and only the answer comes back; pages are cached", async () => {
	let sent = null;
	const s = await site((b) => { sent = b; return [200, { answer: "Clause 5.1 sets the value to 42.", model: "deepseek-flash", chars: b.text.length }]; });
	try {
		const tool = fetchTool({ server: s.base, features: ["extract"] });
		const r = await tool.execute("1", { url: `${s.base}/page.html?a`, prompt: "What value does clause 5.1 set?" });
		const text = r.content[0].text;
		assert.match(text, /^# Spec\n.*\n\nClause 5.1 sets the value to 42\.\n\n\[Answered from the page by deepseek-flash\. Only the first 100000 of its \d+ characters were read\./);
		assert.ok(text.length < 600, "the page itself is not in the answer");
		assert.equal(sent.prompt, "What value does clause 5.1 set?");
		assert.equal(sent.title, "Spec");
		assert.equal(sent.text.length, 100000);
		// read again (now without a question): not fetched a second time, the page's own text in parts
		const again = await tool.execute("2", { url: `${s.base}/page.html?a` });
		assert.equal(s.hits["/page.html?a"], 1);
		assert.match(again.content[0].text, /Page continues: \d+ more characters/);
	} finally {
		s.close();
	}
});

test("web_fetch with a question but no reading on the server: the page's text, with a note", async () => {
	const s = await site(() => [502, { error: "no model could read the page" }]);
	try {
		let r = await fetchTool({ server: s.base, features: [] }).execute("1", { url: `${s.base}/p1`, prompt: "q" });
		assert.match(r.content[0].text, /cannot read pages for you, so this is the page's text[\s\S]*Clause 5\.1/);
		r = await fetchTool({ server: s.base, features: ["extract"] }).execute("1", { url: `${s.base}/p2`, prompt: "q" });
		assert.match(r.content[0].text, /Reading the page on the Ferry server failed \(no model could read the page\)/);
	} finally {
		s.close();
	}
});

test("web_fetch saves a PDF into the downloads folder for office_read", async () => {
	const s = await site(() => [500, {}]);
	const cwd = mkdtempSync(join(tmpdir(), "ferry-dl-"));
	try {
		const r = await fetchTool({ server: s.base }).execute("1", { url: `${s.base}/spec.pdf` }, undefined, undefined, { cwd });
		assert.equal(r.details.path, join(cwd, "downloads", "spec.pdf"));
		assert.equal(readFileSync(r.details.path, "utf8"), "%PDF-1.4 fake");
		assert.match(r.content[0].text, /read it with office_read/);
	} finally {
		s.close();
	}
});

test("intranet and private addresses stay on this computer; public pages go to the server", async () => {
	const { localSite, readByServer } = await import("../lib/web.mjs");
	for (const u of ["http://wiki/page", "https://10.1.2.3/x", "http://192.168.1.10", "https://jira.corp/x", "http://intranet.local/a",
		"https://wiki.mycompany.com/x"]) {
		assert.equal(localSite(u, { localSites: ["mycompany.com"] }), true, u);
	}
	for (const u of ["https://www.3gpp.org/ftp/", "https://github.com/x"]) assert.equal(localSite(u, {}), false, u);

	let asked = null;
	const s = http.createServer((req, res) => {
		let b = "";
		req.on("data", (c) => { b += c; });
		req.on("end", () => {
			asked = JSON.parse(b);
			const out = asked.url.endsWith(".pdf") ? [415, { file: "application/pdf" }] : asked.url.includes("nowhere")
				? [422, { unreachable: "nowhere.example does not resolve from the Ferry server" }]
				: [200, { url: asked.url, title: "Spec", answer: "It is 42.", model: "deepseek-flash", chars: 900 }];
			res.writeHead(out[0], { "content-type": "application/json" }).end(JSON.stringify(out[1]));
		});
	});
	await new Promise((r) => s.listen(0, "127.0.0.1", r));
	const cfg = { server: `http://127.0.0.1:${s.address().port}`, features: ["read"] };
	try {
		const r = await fetchTool(cfg).execute("1", { url: "https://spec.example/38300", prompt: "What value?" });
		assert.match(r.content[0].text, /^# Spec\nhttps:\/\/spec.example\/38300\n\nIt is 42\.\n\n\[Answered from the page by deepseek-flash/);
		assert.deepEqual(asked, { url: "https://spec.example/38300", prompt: "What value?", offset: 0 });
		assert.equal(r.details.readBy, "server");
		assert.deepEqual(await readByServer(cfg, "https://x.example/a.pdf", "", 0), { fallback: "file" });
		assert.deepEqual(await readByServer(cfg, "https://nowhere.example/", "", 0), { fallback: "nowhere.example does not resolve from the Ferry server" });
		assert.equal(await readByServer({ ...cfg, features: [] }, "https://x.example", "", 0), null);
	} finally {
		s.close();
	}
});
