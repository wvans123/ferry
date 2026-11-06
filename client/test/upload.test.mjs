import assert from "node:assert/strict";
import { test } from "node:test";
import { MIN_CHUNK, createUploader, findLimit, imageStats, promptWithRecovery, shrunk, suggestChunk, transientMessage } from "../lib/upload.mjs";

const json = (status = 200, body = { ok: true }) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html = (status, text = "<title>Proxy Notification</title>blocked") => new Response(text, { status, headers: { "content-type": "text/html" } });
const KB = 1024;

function setup(limitKb, chunk = 512 * KB) {
	const state = { chunk };
	const sent = []; // { path, size, ok }
	const logs = [];
	const said = [];
	const post = async (path, body) => {
		const ok = body.length <= limitKb * KB;
		sent.push({ path, size: body.length, ok });
		return ok ? json() : html(403);
	};
	const up = createUploader(state, { post, log: (...a) => logs.push(a), say: (t) => said.push(t), sleep: async () => {} });
	return { state, sent, logs, said, up };
}

test("a commit bigger than chunkBytes goes up in parts, and no request body is bigger than chunkBytes", async () => {
	const { up, sent } = setup(1000, 100 * KB);
	const res = await up.commit(Buffer.alloc(350 * KB, 97), new URLSearchParams({ conv: "c" }), undefined);
	assert.equal(res.status, 200);
	assert.ok(sent.every((s) => s.size <= 100 * KB), JSON.stringify(sent));
	assert.equal(sent.length, 5); // four parts and the small commit that names them
	assert.match(sent[0].path, /\/v1\/ferry\/upload\/[^/]+\/0$/);
	assert.match(sent[3].path, /\/3$/);
	assert.match(sent[4].path, /\/v1\/ferry\/commit\?.*upload=.*parts=4/);
});

test("a small commit goes in one request", async () => {
	const { up, sent } = setup(1000, 100 * KB);
	await up.commit(Buffer.alloc(10 * KB), new URLSearchParams({ conv: "c" }));
	assert.equal(sent.length, 1);
	assert.match(sent[0].path, /^\/v1\/ferry\/commit\?/);
});

test("a gateway 403 halves the part size, the upload still completes, and it is said once", async () => {
	const { up, sent, logs, said, state } = setup(64, 512 * KB);
	const q = new URLSearchParams({ conv: "c" });
	const res = await up.commit(Buffer.alloc(1000 * KB, 97), q);
	assert.equal(res.status, 200);
	assert.equal(state.chunk, 64 * KB);
	assert.ok(sent.filter((s) => s.ok).every((s) => s.size <= 64 * KB));
	assert.equal(said.length, 1);
	assert.match(said[0], /64 KB/);
	// every stopped request is in blocked.log with the size that was really sent
	assert.ok(logs.length >= 3);
	assert.ok(logs.every(([, size]) => size > 64 * KB));
	// the next commit starts with small parts at once
	sent.length = 0;
	await up.commit(Buffer.alloc(200 * KB, 97), q);
	assert.ok(sent.every((s) => s.ok));
	assert.equal(said.length, 1);
});

test("a request that is stopped again and again is sent at most four times, then the answer is returned", async () => {
	let n = 0;
	const up = createUploader({ chunk: 512 * KB }, { post: async () => (n++, html(403)), sleep: async () => {} });
	const res = await up.commit(Buffer.alloc(10 * KB), new URLSearchParams());
	assert.equal(res.status, 403);
	assert.equal(n, 4);
});

test("Cloudflare 502 and a dropped connection are sent again", async () => {
	let n = 0;
	const state = { chunk: 512 * KB };
	const waits = [];
	const up = createUploader(state, {
		post: async () => {
			n++;
			if (n === 1) return html(502, "bad gateway");
			if (n === 2) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
			return json();
		},
		sleep: async (ms) => waits.push(ms),
	});
	const res = await up.commit(Buffer.alloc(KB), new URLSearchParams());
	assert.equal(res.status, 200);
	assert.equal(n, 3);
	assert.deepEqual(waits, [500, 1000]); // a short wait that grows
	assert.equal(state.chunk, 512 * KB); // only a 403 makes the parts smaller
});

test("a network error that stays ends with its reason, not a bare 'fetch failed'", async () => {
	const up = createUploader({ chunk: 512 * KB }, {
		post: async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); },
		sleep: async () => {},
	});
	await assert.rejects(up.commit(Buffer.alloc(KB), new URLSearchParams()), /ECONNRESET\) after 4 tries/);
});

test("answers from the Ferry server (JSON, 401) and the gateway's confirmation page are not retried", async () => {
	let n = 0;
	const up = createUploader({ chunk: 512 * KB }, { post: async () => (n++, json(401, { error: "token" })), sleep: async () => {} });
	assert.equal((await up.commit(Buffer.alloc(KB), new URLSearchParams())).status, 401);
	assert.equal(n, 1);
	n = 0;
	const gw = createUploader({ chunk: 512 * KB }, { post: async () => (n++, html(403, "访问提醒")), sleep: async () => {},
		gatewayConfirm: (_r, text) => /访问提醒/.test(text) });
	assert.equal((await gw.commit(Buffer.alloc(KB), new URLSearchParams())).status, 403);
	assert.equal(n, 1);
});

test("an abort is not retried", async () => {
	const ac = new AbortController();
	ac.abort();
	const up = createUploader({ chunk: 512 * KB }, { post: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }, sleep: async () => {} });
	await assert.rejects(up.commit(Buffer.alloc(KB), new URLSearchParams(), ac.signal), /aborted/);
});

test("the part size never goes below 8 KB", () => {
	assert.equal(shrunk(512 * KB), 256 * KB);
	assert.equal(shrunk(512 * KB, 60 * KB), 30 * KB);
	assert.equal(shrunk(10 * KB), MIN_CHUNK);
});

test("blocked.log numbers: pictures in an upload are counted, base64 bytes included", () => {
	const png = { role: "user", content: [{ type: "text", text: "see" }, { type: "image", data: "A".repeat(1000), mimeType: "image/png" }] };
	const anth = { role: "user", content: [{ type: "image", source: { type: "base64", data: "B".repeat(500) } }] };
	const url = `data:image/png;base64,${"C".repeat(200)}`;
	const oai = { role: "user", content: [{ type: "image_url", image_url: { url } }] };
	const blob = JSON.stringify({ append: [JSON.stringify(png), JSON.stringify(anth), JSON.stringify(oai), { ref: "x" }], tools: null });
	const s = imageStats(blob);
	assert.equal(s.count, 3);
	assert.equal(s.bytes, 1000 + 500 + url.length);
	assert.deepEqual(imageStats("nonsense"), { count: 0, bytes: 0 });
});

test("the parts of a commit with pictures log how much of it was pictures", async () => {
	const { up, logs } = setup(30, 100 * KB);
	await up.commit(Buffer.alloc(200 * KB), new URLSearchParams(), undefined, () => ({ count: 2, bytes: 150 * KB }));
	assert.ok(logs.length > 0);
	const extra = logs[0][4];
	assert.deepEqual(extra.images, { count: 2, bytes: 150 * KB });
	assert.equal(extra.part, "1");
	assert.equal(extra.total, 200 * KB);
});

test("doctor --upload: the limit is found between the last size that passed and the first that failed", async () => {
	const asked = [];
	const limit = 83; // KB
	const found = await findLimit(async (kb) => (asked.push(kb), kb <= limit), 64, 256, 8);
	assert.ok(found <= limit && limit - found < 8, `found ${found}`);
	assert.ok(asked.length <= 6);
	assert.equal(await findLimit(async () => false, 0, 16, 8), 0);
	assert.ok((await findLimit(async () => true, 0, 16, 8)) >= 8);
});

test("doctor suggests a part size a bit under the largest size that passed", () => {
	assert.equal(suggestChunk(80), 64 * KB);
	assert.equal(suggestChunk(64), 48 * KB);
	assert.equal(suggestChunk(8), 8 * KB);
	assert.equal(suggestChunk(0), 8 * KB);
});

test("which error texts a second try may fix", () => {
	for (const t of ["fetch failed", "The Ferry server did not get this request: Cloudflare answered HTTP 502 (ray 1)",
		"Ferry could not reach its server: x", "terminated", "read ECONNRESET"]) {
		assert.equal(transientMessage(t), true, t);
	}
	for (const t of ["Ferry token rejected by the server. Run: ferry login", "HTTP 401 unauthorized",
		"The company network gateway wants a confirmation again", ""]) {
		assert.equal(transientMessage(t), false, t);
	}
});

function fakeSession(answers) {
	const messages = [];
	const prompts = [];
	return { messages, prompts, async prompt(p) {
		prompts.push(p);
		const a = answers.shift();
		messages.push({ role: "assistant", ...(a.error ? { stopReason: "error", errorMessage: a.error } : { stopReason: "stop" }) });
	} };
}

test("a subagent carries on after a stopped request", async () => {
	const s = fakeSession([{ error: "fetch failed" }, { error: "The Ferry server did not get this request: Cloudflare answered HTTP 502" }, {}]);
	const left = await promptWithRecovery(s, "do it", { sleep: async () => {} });
	assert.equal(left, "");
	assert.equal(s.prompts.length, 3);
	assert.match(s.prompts[1], /Carry on from where you stopped/);
});

test("a subagent that keeps failing says what was left; a login error is not retried", async () => {
	const s = fakeSession([{ error: "fetch failed" }, { error: "fetch failed" }, { error: "fetch failed" }]);
	assert.equal(await promptWithRecovery(s, "x", { sleep: async () => {} }), "fetch failed");
	assert.equal(s.prompts.length, 3);
	const t = fakeSession([{ error: "Ferry token rejected by the server. Run: ferry login" }]);
	assert.match(await promptWithRecovery(t, "x", { sleep: async () => {} }), /token rejected/);
	assert.equal(t.prompts.length, 1);
});
