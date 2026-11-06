import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { restrictModelRuntime } from "../lib/server-models.mjs";
import { createSyncProvider } from "../lib/sync.mjs";

test("real Pi runtime exposes exactly the server list despite official credentials and stale models", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ferry-model-isolation-"));
	const previous = process.env.ANTHROPIC_API_KEY;
	const previousFerry = process.env.FERRY_TOKEN;
	process.env.FERRY_TOKEN = "dummy-token";
	process.env.ANTHROPIC_API_KEY = "dummy-never-use-this-key";
	try {
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "dummy-key" } }));
		writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: {
			ferry: { baseUrl: "https://must-not-contact.invalid", apiKey: "dummy", models: [{ id: "stale-model" }] },
			anthropic: { apiKey: "dummy", models: [{ id: "official-extra" }] },
		} }));
		const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
		const offered = [{ id: "owned-a", model: "owned-a", api: "openai" }, { id: "owned-b", model: "owned-b", api: "anthropic", provider: "kiro" }];
		restrictModelRuntime(ModelRuntime, offered);
		const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
		createSyncProvider({ server: "http://127.0.0.1:1", token: "dummy-token" }, offered)({ registerProvider: (...args) => runtime.registerProvider(...args) });
		await runtime.refresh({ allowNetwork: false });
		assert.deepEqual(runtime.getModels().map((m) => `${m.provider}/${m.id}`).sort(), ["ferry/owned-a", "kiro/owned-b"]);
		assert.deepEqual(runtime.getAvailableSnapshot().map((m) => m.id).sort(), ["owned-a", "owned-b"]);
		assert.equal(runtime.getProvider("anthropic"), undefined);
		assert.equal(runtime.getModel("ferry", "stale-model"), undefined);
		assert.throws(() => runtime.stream({ provider: "ferry", id: "owned-b" }, { messages: [] }), /approved model list/);
		assert.throws(() => runtime.stream({ provider: "anthropic", id: "claude-opus-5-5" }, { messages: [] }), /approved model list/);
		assert.throws(() => runtime.stream({ provider: "ferry", id: "stale-model" }, { messages: [] }), /approved model list/);
	} finally {
		if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous;
		if (previousFerry === undefined) delete process.env.FERRY_TOKEN; else process.env.FERRY_TOKEN = previousFerry;
		rmSync(dir, { recursive: true, force: true });
	}
});
