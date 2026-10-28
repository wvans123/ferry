import assert from "node:assert/strict";
import { test } from "node:test";
import { whoAnswered } from "../lib/gateway.mjs";

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
