// node --test client/test
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-tools-"));
const { createBigOutputs, denoise } = await import("../lib/tools.mjs");

const resultHandler = (cfg) => {
	let handler;
	createBigOutputs(cfg)({ on: (name, fn) => { if (name === "tool_result") handler = fn; } });
	return handler;
};

test("denoise strips colour codes and other escape sequences", () => {
	assert.equal(denoise("\x1b[31mERROR\x1b[0m done \x1b[1;32m✓\x1b[m"), "ERROR done ✓");
	assert.equal(denoise("\x1b]0;title\x07\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\ \x1b[2K\x1b[1Gok\x1b(B"), "link ok");
});

test("denoise keeps only the last redraw of a progress bar", () => {
	assert.equal(denoise("Downloading  10%\rDownloading  55%\rDownloading 100%\nDone"), "Downloading 100%\nDone");
	assert.equal(denoise("windows line\r\nnext\r\n"), "windows line\nnext\n");
	assert.equal(denoise("spinner |\r\r"), "spinner |");
});

test("denoise collapses runs of identical lines", () => {
	assert.equal(denoise("start\nwarn: x\nwarn: x\nwarn: x\nwarn: x\nend"), "start\nwarn: x\n(previous line repeated 3 times)\nend");
	assert.equal(denoise("a\na\nb\nb\nb"), "a\na\nb\n(previous line repeated 2 times)");
	assert.equal(denoise("plain\ntext\n"), "plain\ntext\n");
});

test("command results reach the model clean; reads and small unchanged outputs are left alone", () => {
	const on = resultHandler({ bigOutputBytes: 8192 });
	const noisy = [{ type: "text", text: "\x1b[32mok\x1b[0m\n0%\r100%" }];
	assert.deepEqual(on({ toolName: "bash", content: noisy }).content, [{ type: "text", text: "ok\n100%" }]);
	assert.equal(on({ toolName: "read", content: noisy }), undefined);
	assert.equal(on({ toolName: "office_read", content: noisy }), undefined);
	assert.equal(on({ toolName: "bash", content: [{ type: "text", text: "clean" }] }), undefined);
	assert.deepEqual(resultHandler({ bigOutputBytes: 0 })({ toolName: "powershell", content: noisy }).content[0].text, "ok\n100%");
});

test("a long noisy command output is denoised before the size check", () => {
	const on = resultHandler({ bigOutputBytes: 2048 });
	const text = Array.from({ length: 500 }, () => "\x1b[33mretrying...\x1b[0m").join("\n");
	assert.deepEqual(on({ toolName: "bash", toolCallId: "c1", content: [{ type: "text", text }] }).content,
		[{ type: "text", text: "retrying...\n(previous line repeated 499 times)" }]);
});
