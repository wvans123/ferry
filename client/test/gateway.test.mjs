import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchGateway, whoAnswered } from "../lib/gateway.mjs";

test("says who answered instead of the Ferry server", () => {
	const cf = whoAnswered({ status: 403, headers: { server: "cloudflare", "cf-ray": "8a1", "cf-mitigated": "challenge" },
		body: "<html><title>Just a moment...</title></html>" });
	assert.match(cf, /Cloudflare's bot protection/);
	assert.match(cf, /Bot Fight Mode/);
	const cfOther = whoAnswered({ status: 403, headers: new Headers({ server: "cloudflare", "cf-ray": "9b2" }), body: "<title>Forbidden</title>" });
	assert.match(cfOther, /Cloudflare answered HTTP 403.*ray 9b2/);
	const gw = whoAnswered({ status: 403, headers: {}, body: "<title>访问提醒</title>该网站被限制，继续访问" });
	assert.match(gw, /company network gateway answered HTTP 403.*访问提醒/);
	const proxy = whoAnswered({ status: 403, headers: { via: "1.1 corp-proxy" }, body: "<title>Access Denied</title>" });
	assert.match(proxy, /corp-proxy.*Access Denied.*company proxy/);
});

test("while ferry is open, an expired gateway confirmation is opened at once and the note clears when done", async () => {
	let confirmed = false;
	const srv = createServer((req, res) => {
		if (!confirmed) {
			res.writeHead(302, { location: "http://gw.example/proxycontrolwarn?url=ferry" });
			return res.end();
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end('{"ok": true}');
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const opened = join(mkdtempSync(join(tmpdir(), "ferry-gw-")), "opened.txt");
	process.env.FERRY_TEST_OPENED_FILE = opened;
	const states = [];
	const stop = watchGateway({ server: `http://127.0.0.1:${srv.address().port}` }, {
		everyMs: 60000, onState: (t) => {
			states.push(t);
			if (t) setTimeout(() => { confirmed = true; }, 500); // the user confirms in the browser
		} });
	for (let i = 0; i < 40 && states.length < 2; i++) await new Promise((r) => setTimeout(r, 250));
	stop();
	srv.close();
	delete process.env.FERRY_TEST_OPENED_FILE;
	assert.match(readFileSync(opened, "utf8"), /proxycontrolwarn/);
	assert.match(states[0], /gateway wants a confirmation/);
	assert.equal(states[1], undefined);
});
