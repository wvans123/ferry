import assert from "node:assert/strict";
import { test } from "node:test";
import { gatewayPage, htmlToText, parseBing } from "../lib/web.mjs";

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
