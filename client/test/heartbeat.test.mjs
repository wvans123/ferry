import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { BEAT_MS, createHeartbeat } from "../lib/heartbeat.mjs";

function load(cfg) {
	const sent = [];
	const handlers = {};
	createHeartbeat(cfg, { every: BEAT_MS, post: async (body) => sent.push(body) })({ on: (ev, fn) => { handlers[ev] = fn; } });
	return { sent, handlers };
}

const ctx = { sessionManager: { getSessionId: () => "s1" } };

test("a beat when the run starts, one every 5 minutes while it works, and an end", async () => {
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const { sent, handlers } = load({ server: "http://x" });
		handlers.agent_start({}, ctx);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].id, "s1");
		assert.ok(sent[0].project && !("end" in sent[0]));
		mock.timers.tick(BEAT_MS - 1);
		assert.equal(sent.length, 1);
		mock.timers.tick(1);
		assert.equal(sent.length, 2);
		mock.timers.tick(4 * BEAT_MS); // a 20-minute build
		assert.equal(sent.length, 6);
		await handlers.agent_settled({});
		assert.deepEqual(sent.at(-1), { id: "s1", project: sent[0].project, end: true });
		mock.timers.tick(10 * BEAT_MS);
		assert.equal(sent.length, 7, "no beats between runs");
		await handlers.session_shutdown({});
		assert.equal(sent.length, 7, "no second end");
	} finally {
		mock.timers.reset();
	}
});

test("off with the phone notices, or without a server", () => {
	assert.deepEqual(load({ server: "http://x", phoneNotify: false }).handlers, {});
	assert.deepEqual(load({}).handlers, {});
});
