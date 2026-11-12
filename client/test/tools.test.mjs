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

// ---------- old outputs leave in batches; the agent's own long write / command texts leave too ----------

test("old long outputs and old long write / command texts are left out together, the latest stay", async () => {
	const { trimPlan, trimDrafts } = await import("../lib/tools.mjs");
	const long = "x".repeat(5000);
	const call = (id, name, args) => ({ type: "message", id, message: { role: "assistant", content: [
		{ type: "thinking", thinking: "plan", thinkingSignature: "sig" }, { type: "text", text: "next" },
		{ type: "toolCall", id: `c-${id}`, name, arguments: args }] } });
	const result = (id, toolName, text) => ({ type: "message", id, message: { role: "toolResult", toolName, content: [{ type: "text", text }] } });
	const entries = [
		{ type: "message", id: "u1", message: { role: "user", content: long } },
		call("a1", "write", { path: "notes.md", content: long }), result("r1", "write", "ok"),
		call("a2", "bash", { command: `python - <<'EOF'\n${long}\nEOF`, timeout: 30 }), result("r2", "bash", long),
		call("a3", "read", { path: "a.txt" }), result("r3", "read", long),
		call("a4", "edit", { path: "a.txt", edits: [{ oldText: long, newText: "y" }] }), result("r4", "edit", "ok"),
	];
	for (let i = 5; i <= 10; i++) entries.push(call(`a${i}`, "write", { path: `f${i}`, content: long }), result(`r${i}`, "read", long));
	const { drafts, saved } = trimPlan(entries);
	assert.deepEqual(drafts.map((d) => d.targetId), ["a1", "a2", "r2", "r3"]); // the user's message, edit calls and the latest 6 results stay
	assert.ok(saved > 4 * 4500 && saved < 4 * 5000);
	const a1 = drafts[0].replacement.content;
	assert.equal(a1[0].thinkingSignature, "sig"); // thinking and text are untouched
	assert.equal(a1[1].text, "next");
	assert.equal(a1[2].id, "c-a1");
	assert.equal(a1[2].arguments.path, "notes.md");
	assert.match(a1[2].arguments.content, /^\[Ferry note, not the file's content: the 5 KB written here were left out/);
	const a2 = drafts[1].replacement.content[2].arguments;
	assert.ok(a2.command.startsWith("python - <<'EOF'\nxxx") && a2.command.length < 500);
	assert.match(a2.command, /the rest of this command \(5 KB\) was left out/);
	assert.equal(a2.timeout, 30);
	assert.match(drafts[2].replacement.content[0].text, /this bash output \(5 KB\) was left out/);
	// what was replaced once is not replaced again
	const again = [...entries, ...drafts.map((d, i) => ({ ...d, id: `e${i}` }))];
	assert.deepEqual(trimDrafts(again), []);
	assert.equal(entries[1].message.content[2].arguments.content, long); // the session itself keeps the full text
});

test("old outputs are replaced a batch at a time, so the prompt cache is lost rarely", async () => {
	const { createTrimOldOutputs, TRIM_BATCH_CHARS } = await import("../lib/tools.mjs");
	const run = (cfg, entries, tokens) => {
		let handler;
		const status = [];
		createTrimOldOutputs(cfg)({ on: (name, fn) => { if (name === "turn_end") handler = fn; } });
		const out = handler?.({}, { getContextUsage: () => ({ tokens }), hasUI: true,
			sessionManager: { getBranch: () => [...(cfg.summarised ?? []), ...entries],
				buildSessionProjection: () => ({ entries: entries.map((sourceEntry) => ({ sourceEntry })) }) },
			ui: { setStatus: (_k, t) => status.push(t) } });
		return { out, status };
	};
	const result = (id, chars) => ({ type: "message", id, message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "x".repeat(chars) }] } });
	const few = [result("r0", 30_000), ...Array.from({ length: 6 }, (_, i) => result(`k${i}`, 3000))];
	assert.equal(run({}, few, 120_000).out, undefined); // 30k characters are not worth a cache miss yet
	const many = [result("r0", 30_000), result("r1", 30_000), result("r2", 30_000), ...few.slice(1)];
	assert.ok(90_000 > TRIM_BATCH_CHARS);
	const { out, status } = run({}, many, 120_000);
	assert.deepEqual(out.entries.map((e) => e.targetId), ["r0", "r1", "r2"]);
	assert.deepEqual(status, ["left out 3 old tool output(s)"]);
	assert.equal(run({}, many, 50_000).out, undefined); // below trimOldOutputs nothing happens
	assert.equal(run({ trimOldOutputs: "2k" }, few, 5000).out.entries.length, 1); // a small setting keeps a small batch
	assert.equal(run({ trimOldOutputs: "0" }, many, 500_000).out, undefined); // off
	// what a summary already took out of the context does not count towards the batch
	assert.equal(run({ summarised: [result("s0", 90_000)] }, few, 120_000).out, undefined);
	// several calls in one reply: when one of their results is kept, the reply that made them stays whole
	const { trimPlan } = await import("../lib/tools.mjs");
	const long = "x".repeat(5000);
	const both = { type: "message", id: "a", message: { role: "assistant", content: [
		{ type: "toolCall", id: "c1", name: "write", arguments: { path: "p", content: long } },
		{ type: "toolCall", id: "c2", name: "read", arguments: { path: "q" } }] } };
	const parallel = [result("old", 5000), both, result("p1", 5000), result("p2", 5000), ...Array.from({ length: 5 }, (_, i) => result(`k${i}`, 5000))];
	assert.deepEqual(trimPlan(parallel).drafts.map((d) => d.targetId), ["old"]); // p2 is kept, so the reply and p1 stay as well
});

// ---------- a run of single small look-ups is answered with one reminder ----------

test("replies that each make one small look-up are counted; the agent is reminded after four in a row", async () => {
	const { createBatchNudge, isSingleLookup, LOOKUP_NOTE } = await import("../lib/tools.mjs");
	const reply = (...calls) => ({ role: "assistant", content: [{ type: "text", text: "." },
		...calls.map(([name, args]) => ({ type: "toolCall", id: "c", name, arguments: args }))] });
	const peek = reply(["bash", { command: 'cd "/d/work dir" && F=a.txt; sed -n 1,40p $F' }]);
	assert.equal(isSingleLookup(peek), true);
	assert.equal(isSingleLookup(reply(["read", { path: "a.txt" }])), true);
	assert.equal(isSingleLookup(reply(["bash", { command: "sleep 30" }])), true);
	assert.equal(isSingleLookup(reply(["bash", { command: "python build.py" }])), false);
	assert.equal(isSingleLookup(reply(["bash", { command: "grep -rn foo . | head -20" }])), true);
	assert.equal(isSingleLookup(reply(["bash", { command: "grep -r foo .; echo ---; sed -n 1,20p a.txt" }])), false); // already batched
	assert.equal(isSingleLookup(reply(["bash", { command: "ls && rm -rf build" }])), false);
	assert.equal(isSingleLookup(reply(["bash", { command: "sed -i s/a/b/ main.py" }])), false);
	assert.equal(isSingleLookup(reply(["bash", { command: "find . -name '*.pyc' -delete" }])), false);
	assert.equal(isSingleLookup(reply(["bash", { command: "echo hi > a.txt" }])), false);
	assert.equal(isSingleLookup(reply(["bash", { command: "file-tool --run" }])), false);
	assert.equal(isSingleLookup(reply(["bash", { command: "cat > a.txt <<'EOF'\nhello\nEOF" }])), false); // it writes
	assert.equal(isSingleLookup(reply(["read", { path: "a" }], ["read", { path: "b" }])), false); // already together
	assert.equal(isSingleLookup(reply(["write", { path: "a", content: "b" }])), false);
	assert.equal(isSingleLookup(reply()), false);

	const sent = [];
	const on = {};
	createBatchNudge({})({ on: (name, fn) => { on[name] = fn; }, sendMessage: (m, o) => sent.push([m, o]) });
	for (let i = 0; i < 3; i++) on.turn_end({ message: peek });
	on.turn_end({ message: reply(["bash", { command: "python build.py" }]) }); // real work in between: the count starts again
	for (let i = 0; i < 3; i++) on.turn_end({ message: peek });
	assert.equal(sent.length, 0);
	on.turn_end({ message: peek });
	assert.equal(sent.length, 1);
	assert.equal(sent[0][0].content, LOOKUP_NOTE(4));
	assert.match(sent[0][0].content, /ask for all of it in your next reply/);
	assert.deepEqual([sent[0][0].display, sent[0][1].deliverAs], [false, "steer"]);
	for (let i = 0; i < 40; i++) on.turn_end({ message: peek });
	assert.equal(sent.length, 3); // at most three per request
	on.agent_settled();
	for (let i = 0; i < 4; i++) on.turn_end({ message: peek });
	assert.equal(sent.length, 4);

	const off = {};
	createBatchNudge({ batchNudge: 0 })({ on: (name, fn) => { off[name] = fn; } });
	assert.equal(off.turn_end, undefined);
});
