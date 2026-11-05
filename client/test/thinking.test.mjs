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
