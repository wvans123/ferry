import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { modelDef } from "../lib/sync.mjs";

// pi's Anthropic request builder, as pi itself uses it
const { streamSimple } = await import(new URL("./api/anthropic-messages.js", import.meta.resolve("@earendil-works/pi-ai")).href);

test("the thinking effort chosen in ferry is the one Claude's request carries at the top (#9)", async () => {
	let body = null;
	const s = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => { raw += c; });
		req.on("end", () => {
			body = JSON.parse(raw);
			res.writeHead(400, { "content-type": "application/json" }).end('{"type":"error","error":{"type":"invalid_request_error","message":"test"}}');
		});
	});
	await new Promise((r) => s.listen(0, "127.0.0.1", r));
	try {
		const def = modelDef({ id: "opus", model: "claude-opus-5-5", api: "anthropic", contextWindow: 1000000, vision: true }, {});
		const model = { ...def, api: "anthropic-messages", provider: "ferry", baseUrl: `http://127.0.0.1:${s.address().port}` };
		for await (const _e of streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ reasoning: "high", apiKey: "k", maxRetries: 0 })) {
			// drain
		}
		assert.equal(body.output_config?.effort, "high");
		assert.equal(body.thinking?.type, "adaptive");
		assert.ok(!body.messages.some((m) => m.role === "system"), "no effort markers inside the conversation");
	} finally {
		s.close();
	}
});

// pi's Chat Completions request builder
const completions = await import(new URL("./api/openai-completions.js", import.meta.resolve("@earendil-works/pi-ai")).href);

async function askGpt(entry, level) {
	let body = null;
	const s = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => { raw += c; });
		req.on("end", () => {
			body = JSON.parse(raw);
			res.writeHead(400, { "content-type": "application/json" }).end('{"error":{"message":"test"}}');
		});
	});
	await new Promise((r) => s.listen(0, "127.0.0.1", r));
	try {
		const def = modelDef(entry, {});
		const model = { ...def, api: "openai-completions", provider: "ferry", baseUrl: `http://127.0.0.1:${s.address().port}/v1` };
		for await (const _e of completions.streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ reasoning: level, apiKey: "k", maxRetries: 0 })) {
			// drain
		}
		return body;
	} finally {
		s.close();
	}
}

test("a model the client does not list still thinks once the server names its model, at the nearest level it has", async () => {
	const listed = { id: "gpt", model: "gpt-6.1-sol", api: "openai", contextWindow: 400000 };
	const high = await askGpt(listed, "high");
	assert.equal(high.reasoning_effort, "high");
	// what the client used to build for an unlisted model: no upstream name, so no thinking
	assert.equal((await askGpt({ id: "gpt", api: "openai", contextWindow: 400000 }, "high")).reasoning_effort, undefined);
	// a level the model does not have (Claude's "xhigh" or "minimal") moves to the nearest one instead of dropping thinking
	const top = await askGpt(listed, "xhigh");
	assert.ok(typeof top.reasoning_effort === "string" && top.reasoning_effort.length > 0, JSON.stringify(top.reasoning_effort));
});
