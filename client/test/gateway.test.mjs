import assert from "node:assert/strict";
import { test } from "node:test";

process.env.FERRY_NO_BROWSER = "1";
const { waitAtGateway, whoAnswered } = await import("../lib/gateway.mjs");

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

/** A fake clock: nap() moves it on at once. Records naps, checks, the status line and phone notices. */
function rig({ openAfterMs = Infinity, minutes } = {}) {
	let t = Date.UTC(2026, 10, 6, 17, 20);
	const seen = { naps: [], checks: 0, status: [], phone: [] };
	const cfg = { server: "http://ferry.test", gatewayWaitMinutes: minutes, onGateway: (s) => seen.status.push(s),
		phone: (title, body) => seen.phone.push(`${title}: ${body}`) };
	const start = t;
	const deps = {
		now: () => t,
		nap: async (ms) => { seen.naps.push(ms); t += ms; },
		check: async () => { seen.checks++; return t - start >= openAfterMs; },
		tellAfter: 180000,
		slow: 60000,
	};
	return { cfg, deps, seen };
}

test("waits through a long night, tells the phone once, clears the status when through", async () => {
	const { cfg, deps, seen } = rig({ openAfterMs: 5 * 3600000 });
	const stop = await waitAtGateway(cfg, "http://gw.test/proxycontrolwarn", undefined, deps);
	assert.equal(stop, "");
	assert.equal(seen.phone.length, 1);
	assert.match(seen.phone[0], /^Waiting for the gateway: Ferry has been paused since \d\d:\d\d: .*carries on by itself/);
	assert.doesNotMatch(seen.phone[0], /http/);
	assert.equal(seen.status.length, 2);
	assert.match(seen.status[0], /^Paused since \d\d:\d\d: the company gateway wants a confirmation in the browser; carries on by itself$/);
	assert.equal(seen.status[1], undefined);
	assert.ok(seen.naps.slice(0, 72).every((ms) => ms === 2500), "every 2.5 s for the first 3 minutes");
	assert.ok(seen.naps.slice(72).every((ms) => ms === 60000), "then once a minute");
	assert.ok(seen.checks < 72 + 5 * 60, `${seen.checks} checks`);
});

test("stops at gatewayWaitMinutes with a message saying what happened and how to go on", async () => {
	const { cfg, deps, seen } = rig({ minutes: 30 });
	const stop = await waitAtGateway(cfg, "http://gw.test/proxycontrolwarn", undefined, deps);
	assert.match(stop, /gateway has wanted a confirmation since \d\d:\d\d.*within 30 minutes \(gatewayWaitMinutes\).*ferry -c/);
	assert.equal(seen.naps.reduce((a, b) => a + b, 0), 30 * 60000);
	assert.equal(seen.phone.length, 1);
	assert.equal(seen.status.at(-1), undefined);
	const now = await waitAtGateway({ ...cfg, gatewayWaitMinutes: 0 }, "http://gw.test/x", undefined, deps);
	assert.match(now, /within 0 minutes/);
	assert.match((await waitAtGateway({ ...cfg, gatewayWaitMinutes: undefined }, "x", undefined, rig().deps)), /within 12 hours/);
});

test("Esc stops the wait at once, without a phone notice", async () => {
	const { cfg, deps, seen } = rig();
	const ac = new AbortController();
	const stop = await waitAtGateway(cfg, "http://gw.test/x", ac.signal, { ...deps, nap: async (ms) => { seen.naps.push(ms); ac.abort(); } });
	assert.equal(stop, "");
	assert.equal(seen.naps.length, 1);
	assert.equal(seen.checks, 0);
	assert.equal(seen.phone.length, 0);
	assert.equal(seen.status.at(-1), undefined);
});

test("several requests waiting together share one status line and one phone notice", async () => {
	const { cfg, deps, seen } = rig({ openAfterMs: 3600000 });
	let t = deps.now();
	const shared = { ...deps, now: () => t, nap: async (ms) => { await new Promise((r) => setImmediate(r)); t += ms / 3; },
		check: async () => { seen.checks++; return t - Date.UTC(2026, 10, 6, 17, 20) >= 3600000; } };
	const all = await Promise.all([1, 2, 3].map(() => waitAtGateway(cfg, "http://gw.test/x", undefined, shared)));
	assert.deepEqual(all, ["", "", ""]);
	assert.equal(seen.phone.length, 1);
	assert.equal(seen.status.filter(Boolean).length, 1);
	assert.equal(seen.status.at(-1), undefined);
});
