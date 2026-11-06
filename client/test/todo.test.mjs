// The to-do list: a list that stops moving while the agent keeps working gets one hidden reminder per 12 tool calls.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-todo-"));
const { createTodo, staleTodoNote, TODO_STALE_CALLS } = await import("../lib/tools.mjs");

function load() {
	const on = {};
	const pi = { sent: [], on: (n, f) => (on[n] = f), fire: (n, e, c) => on[n]?.(e, c),
		registerTool: (t) => { pi.tool = t; }, sendMessage: (...a) => pi.sent.push(a) };
	createTodo()(pi);
	const ctx = { hasUI: false, sessionManager: { getBranch: () => [] } };
	pi.fire("session_start", {}, ctx);
	const todo = (todos) => {
		pi.tool.execute("1", { todos }, undefined, undefined, ctx);
		pi.fire("tool_execution_end", { toolName: "todo" });
	};
	const calls = (n, extra = {}) => { for (let i = 0; i < n; i++) pi.fire("tool_execution_end", { toolName: "bash", ...extra }); };
	return { pi, todo, calls };
}

const LIST = [{ content: "read the spec", status: "completed" }, { content: "write the CR", status: "in_progress" },
	{ content: "review", status: "pending" }];

test("after 12 tool calls without a todo update, one hidden reminder names the item in progress", () => {
	assert.equal(TODO_STALE_CALLS, 12);
	const t = load();
	t.todo(LIST);
	t.calls(11);
	assert.equal(t.pi.sent.length, 0);
	t.calls(1);
	assert.equal(t.pi.sent.length, 1);
	const [msg, opts] = t.pi.sent[0];
	assert.equal(msg.customType, "ferry-todo-stale");
	assert.equal(msg.display, false);
	assert.equal(opts.deliverAs, "steer");
	assert.match(msg.content, /not been updated in the last 12 tool calls/);
	assert.match(msg.content, /"write the CR" as in progress, with 2 item\(s\) open/);
	t.calls(11);
	assert.equal(t.pi.sent.length, 1, "at most one reminder per 12 calls");
	t.calls(1);
	assert.equal(t.pi.sent.length, 2);
});

test("a todo update, a finished list, a settled request and subagent calls do not count", () => {
	const t = load();
	t.todo(LIST);
	t.calls(10);
	t.todo(LIST);
	t.calls(11);
	assert.equal(t.pi.sent.length, 0, "the update started the count again");
	t.pi.fire("agent_settled", {});
	t.calls(11);
	assert.equal(t.pi.sent.length, 0, "a new request starts the count again");
	t.calls(30, { parentToolCallId: "task-1" });
	assert.equal(t.pi.sent.length, 0, "calls inside a subagent are not the main agent's");
	t.todo(LIST.map((x) => ({ ...x, status: "completed" })));
	t.calls(30);
	assert.equal(t.pi.sent.length, 0, "nothing open: no reminder");
	t.todo([]);
	t.calls(30);
	assert.equal(t.pi.sent.length, 0, "no list: no reminder");
});

test("the note says so when no item is in progress", () => {
	assert.match(staleTodoNote([{ content: "a", status: "pending" }], 12), /No item is marked in progress, with 1 item\(s\) open/);
});
