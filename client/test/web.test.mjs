import assert from "node:assert/strict";
import { test } from "node:test";
import { gatewayPage, htmlToText, parseBing, searchServer, searchWeb } from "../lib/web.mjs";

test("html becomes readable text", () => {
	const { title, text } = htmlToText(
		"<html><head><title>T &amp; t</title><style>x{}</style></head><body><nav>menu</nav><h2>Install</h2>" +
		"<p>Run <code>npm ci</code> then <a href='/docs'>read the docs</a>.</p><pre>line1\n  line2</pre>" +
		"<ul><li>one</li><li>two</li></ul><script>alert(1)</script></body></html>", "https://example.com/a/");
	assert.equal(title, "T & t");
	assert.match(text, /## Install/);
	assert.match(text, /`npm ci`/);
	assert.match(text, /\[read the docs\]\(https:\/\/example.com\/docs\)/);
	assert.match(text, /line1\n {2}line2/);
	assert.match(text, /- one/);
	assert.doesNotMatch(text, /alert|menu|x\{\}/);
});

test("bing results, with redirect links unwrapped", () => {
	const r = parseBing('<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=x&amp;u=a1aHR0cHM6Ly9naXRodWIuY29tL0J1cm50U3VzaGkvcmlwZ3JlcA&amp;ntb=1">A <strong>title</strong></a></h2><div class="b_caption"><p>Snippet <b>here</b></p></div></li>');
	assert.deepEqual(r, [{ title: "A title", url: "https://github.com/BurntSushi/ripgrep", snippet: "Snippet here" }]);
});

test("company gateway warning pages are recognised", () => {
	assert.ok(gatewayPage("http://10.0.0.1/proxycontrolwarn?url=x"));
	assert.ok(gatewayPage("http://gw/x", "<html>访问提醒：您访问的网站未分类，点击继续访问</html>"));
	assert.ok(!gatewayPage("https://github.com/", "<html>normal page</html>"));
});

const cfg = { server: "http://ferry.test", token: "t", features: ["search"] };

async function withFetch(replies, run) {
	const real = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); const next = replies.length > 1 ? replies.shift() : replies[0]; return typeof next === "function" ? next() : next; };
	process.env.FERRY_SEARCH_RETRY_MS = "1";
	try { return await run(calls); } finally { globalThis.fetch = real; delete process.env.FERRY_SEARCH_RETRY_MS; }
}
const html502 = (headers = {}, body = "<html><head><title>502 Bad Gateway</title></head></html>") => () =>
	new Response(body, { status: 502, headers: { "content-type": "text/html", ...headers } });

test("a 502 that is not JSON says so and says Cloudflare sent it", async () => {
	await withFetch([html502({ "cf-ray": "abc123-HKG", server: "cloudflare" })], async (calls) => {
		await assert.rejects(searchServer(cfg, "6G"), (e) => e.nonJson && /HTTP 502 from Cloudflare \(cf-ray abc123-HKG\), not from the search engine/.test(e.message));
		assert.equal(calls.length, 2);  // asked once more first
	});
});

test("a non-JSON reply from something else shows the page title", async () => {
	await withFetch([html502()], async () => {
		await assert.rejects(searchServer(cfg, "6G"), (e) => /from a page titled "502 Bad Gateway", not from the search engine/.test(e.message));
	});
});

test("one retry on 502, and the second answer is used", async () => {
	const ok = new Response(JSON.stringify({ engine: "tavily", results: [{ title: "a", url: "https://a.test" }] }), { status: 200, headers: { "content-type": "application/json" } });
	await withFetch([html502(), ok], async (calls) => {
		const r = await searchServer(cfg, "6G");
		assert.equal(calls.length, 2);
		assert.equal(r.engine, "tavily");
		assert.equal(r.results.length, 1);
	});
});

test("an error the server wrote itself is not retried and keeps its text", async () => {
	const bad = new Response(JSON.stringify({ error: "tavily answered HTTP 401" }), { status: 401, headers: { "content-type": "application/json" } });
	await withFetch([bad], async (calls) => {
		await assert.rejects(searchServer(cfg, "6G"), /tavily answered HTTP 401/);
		assert.equal(calls.length, 1);
	});
});

test("Bing's page is asked with strict SafeSearch", async () => {
	await withFetch([new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })], async (calls) => {
		await searchWeb("6G IMS", 8, undefined, "http://bing.test");
		assert.match(calls[0].url, /[?&]adlt=strict(&|$)/);
		assert.match(calls[0].init.headers.Cookie, /SRCHHPGUSR=ADLT=STRICT/);
	});
});
