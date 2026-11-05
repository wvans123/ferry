import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-providers-"));
const { AGENT_DIR, FERRY_PROVIDERS, ensureAgentDir, findFerryModel } = await import("../lib/config.mjs");
const { createSyncProvider } = await import("../lib/sync.mjs");

const MODELS = [
	{ id: "auto", model: "deepseek-flash", api: "openai", provider: "ferry" },
	{ id: "claude-opus-5.5", model: "claude-opus-5.5", api: "anthropic", provider: "kiro" },
	{ id: "claude-opus-5-5", model: "claude-opus-5-5", api: "anthropic", provider: "kiro-fuli" },
	{ id: "old", model: "deepseek-chat", api: "openai" }, // a server before 0.32 sends no provider
];

test("each provider's models are shown under its own name, not all under ferry", () => {
	const got = new Map();
	createSyncProvider({ server: "http://127.0.0.1:1", token: "t" }, MODELS)({ registerProvider: (name, c) => got.set(name, c) });
	assert.deepEqual([...got.keys()].sort(), ["ferry", "kiro", "kiro-fuli"]);
	assert.deepEqual(got.get("kiro").models.map((m) => [m.id, m.name]), [["claude-opus-5.5", "claude-opus-5.5"]]);
	assert.deepEqual(got.get("ferry").models.map((m) => m.id), ["auto", "old"]);
	assert.ok(FERRY_PROVIDERS.has("kiro-fuli"));
	const reg = { find: (p, id) => got.get(p)?.models.find((m) => m.id === id) };
	assert.equal(findFerryModel(reg, "claude-opus-5-5")?.name, "claude-opus-5-5");
	assert.equal(findFerryModel(reg, "nope"), undefined);
});

test("a default model saved as ferry/x moves to the provider it is shown under now", () => {
	mkdirSync(AGENT_DIR, { recursive: true });
	const file = join(AGENT_DIR, "settings.json");
	const saved = () => JSON.parse(readFileSync(file, "utf8"));
	writeFileSync(file, JSON.stringify({ defaultProvider: "ferry", defaultModel: "claude-opus-5.5" }));
	ensureAgentDir("auto", MODELS);
	assert.deepEqual([saved().defaultProvider, saved().defaultModel], ["kiro", "claude-opus-5.5"]);
	// gone from the server: back to the first model, under its provider
	writeFileSync(file, JSON.stringify({ defaultProvider: "kiro", defaultModel: "removed" }));
	ensureAgentDir("auto", MODELS);
	assert.deepEqual([saved().defaultProvider, saved().defaultModel], ["ferry", "auto"]);
	// a provider that is not Ferry's is left alone
	writeFileSync(file, JSON.stringify({ defaultProvider: "elsewhere", defaultModel: "x" }));
	ensureAgentDir("auto", MODELS);
	assert.deepEqual([saved().defaultProvider, saved().defaultModel], ["elsewhere", "x"]);
});
