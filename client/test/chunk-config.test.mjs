import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-chunk-"));
after(() => rmSync(process.env.FERRY_HOME, { recursive: true, force: true }));
const { chunkSize, loadConfig, saveConfig, MAX_CHUNK_BYTES } = await import("../lib/config.mjs");

test("upload size is bounded when reading hand-edited config and when saving settings", () => {
	for (const value of [null, -1, 0, "bad", Infinity, 2 ** 30]) assert.equal(chunkSize(value), MAX_CHUNK_BYTES);
	assert.equal(chunkSize(64 * 1024), 64 * 1024);
	assert.equal(chunkSize(1), 8 * 1024);
	const file = join(process.env.FERRY_HOME, "config.json");
	writeFileSync(file, JSON.stringify({ chunkBytes: 2 ** 30 }));
	assert.equal(loadConfig().chunkBytes, MAX_CHUNK_BYTES);
	saveConfig({ chunkBytes: 2 ** 30 });
	assert.equal(JSON.parse(readFileSync(file)).chunkBytes, MAX_CHUNK_BYTES);
});
