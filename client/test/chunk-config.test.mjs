import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-chunk-"));
after(() => rmSync(process.env.FERRY_HOME, { recursive: true, force: true }));
const { chunkSize, loadConfig, saveConfig, DEFAULT_CHUNK_BYTES, MAX_CHUNK_BYTES } = await import("../lib/config.mjs");

test("upload size defaults to gateway-safe 128 KiB and is bounded up to 512 KiB", () => {
	for (const value of [null, -1, 0, "bad"]) assert.equal(chunkSize(value), DEFAULT_CHUNK_BYTES);
	for (const value of [Infinity, 2 ** 30]) assert.equal(chunkSize(value), MAX_CHUNK_BYTES);
	assert.equal(DEFAULT_CHUNK_BYTES, 128 * 1024);
	assert.equal(chunkSize(64 * 1024), 64 * 1024);
	assert.equal(chunkSize(1), 8 * 1024);
	assert.equal(loadConfig().chunkBytes, DEFAULT_CHUNK_BYTES);
	const file = join(process.env.FERRY_HOME, "config.json");
	writeFileSync(file, JSON.stringify({ chunkBytes: 2 ** 30 }));
	assert.equal(loadConfig().chunkBytes, MAX_CHUNK_BYTES);
	saveConfig({ chunkBytes: 2 ** 30 });
	assert.equal(JSON.parse(readFileSync(file)).chunkBytes, MAX_CHUNK_BYTES);
});
