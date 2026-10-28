// Extra agent tools and context hygiene, all on this computer:
//   todo          a task list the model keeps up to date (like Claude Code's TodoWrite), shown above the input box
//   big outputs   a long command or search output is saved to a file; the model gets the start, the end and the
//                 path, and reads more when it needs to (like Cursor). Keeps every request small.
//   history_search  after the context was summarized, find exact details from earlier in this conversation in the
//                 full local record (pi keeps every message on disk), instead of redoing the work (like Cursor).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { FERRY_HOME } from "./config.mjs";

export const OUTPUTS_DIR = join(FERRY_HOME, "outputs");
const KEEP_DAYS = 7;
// Tools whose output is data the model asked for on purpose: never cut (read has its own paging)
const NEVER_CUT = new Set(["read", "edit", "write", "memory", "todo", "task", "history_search"]);

// ---------- todo ----------

const TodoParams = Type.Object({
	todos: Type.Array(Type.Object({
		content: Type.String({ description: "What to do, in a few words" }),
		status: StringEnum(["pending", "in_progress", "completed"]),
	}), { description: "The complete list. Send every item each time; at most one in_progress." }),
});

const MARK = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
const render = (todos) => todos.map((t) => `${MARK[t.status] ?? "[ ]"} ${t.content}`).join("\n");

export function createTodo() {
	return (pi) => {
		let todos = [];
		const show = (ctx) => {
			if (!ctx?.hasUI) return;
			const open = todos.filter((t) => t.status !== "completed").length;
			ctx.ui.setWidget("ferry-todo", todos.length && open ? [`Tasks (${todos.length - open}/${todos.length} done)`,
				...render(todos).split("\n").map((l) => `  ${l}`)] : undefined);
		};
		const restore = (_event, ctx) => {
			todos = [];
			for (const e of ctx.sessionManager.getBranch()) {
				if (e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "todo" && e.message.details?.todos) {
					todos = e.message.details.todos;
				}
			}
			show(ctx);
		};
		pi.on("session_start", restore);
		pi.on("session_tree", restore);
		pi.registerTool({
			name: "todo",
			label: "Tasks",
			description: "Keep a task list for work with several steps. Send the whole list every time. Mark an item " +
				"in_progress before starting it and completed as soon as it is done; keep exactly one in_progress while working. " +
				"Skip it for one-step requests.",
			promptSnippet: "Plan and track multi-step work as a task list the user can see",
			parameters: TodoParams,
			annotations: { readOnlyHint: true, openWorldHint: false },
			async execute(_id, params, _signal, _onUpdate, ctx) {
				todos = (params.todos ?? []).map((t) => ({ content: String(t.content), status: t.status }));
				show(ctx);
				return { content: [{ type: "text", text: todos.length ? render(todos) : "(task list cleared)" }], details: { todos } };
			},
		});
	};
}

// ---------- big outputs ----------

function cleanOld() {
	try {
		const cutoff = Date.now() - KEEP_DAYS * 86400_000;
		for (const day of readdirSync(OUTPUTS_DIR)) {
			const p = join(OUTPUTS_DIR, day);
			if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
		}
	} catch {
		// nothing saved yet
	}
}

function cutLines(lines, fromEnd, maxBytes) {
	const out = [];
	let bytes = 0;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[fromEnd ? lines.length - 1 - i : i];
		const s = l.length > 400 ? `${l.slice(0, 400)}...(line cut)` : l;
		bytes += Buffer.byteLength(s) + 1;
		if (bytes > maxBytes) break;
		out.push(s);
	}
	return fromEnd ? out.reverse() : out;
}

/** Replace a long text with its start and end plus where the full text is. Exported for tests. */
export function shrinkOutput(text, toolName, callId, limit) {
	const day = new Date().toISOString().slice(0, 10);
	const dir = join(OUTPUTS_DIR, day);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${toolName}-${String(callId).replace(/[^\w-]+/g, "_").slice(-40)}.txt`);
	writeFileSync(file, text, "utf8");
	const lines = text.split(/\r?\n/);
	const budget = Math.max(1024, Math.floor(limit / 2));
	const head = cutLines(lines, false, Math.floor(budget * 0.4));
	const tail = cutLines(lines.slice(head.length), true, Math.floor(budget * 0.6));
	const skipped = lines.length - head.length - tail.length;
	return [
		`[Long output: ${lines.length} lines, ${Math.round(Buffer.byteLength(text) / 1024)} KB. Full text saved to ${file}`,
		` Shown: first ${head.length} and last ${tail.length} lines. To see more, use read on that file with offset/limit, or grep it.]`,
		...head,
		...(skipped > 0 ? [`... ${skipped} lines not shown ...`] : []),
		...tail,
	].join("\n");
}

export function createBigOutputs(cfg) {
	const limit = Number(cfg.bigOutputBytes ?? 8192);
	return (pi) => {
		if (!(limit > 0)) return;
		pi.on("session_start", () => cleanOld());
		pi.on("tool_result", (event) => {
			if (NEVER_CUT.has(event.toolName)) return undefined;
			const texts = (event.content ?? []).filter((c) => c.type === "text");
			let full = texts.map((c) => c.text).join("\n");
			if (Buffer.byteLength(full) <= limit) return undefined;
			// pi already cut a very long command output and kept the whole of it in a temp file: start from that
			const whole = event.details?.fullOutputPath;
			if (typeof whole === "string" && existsSync(whole)) {
				try {
					full = readFileSync(whole, "utf8");
				} catch {
					// keep what pi showed
				}
			}
			const short = shrinkOutput(full, event.toolName, event.toolCallId, limit);
			const others = (event.content ?? []).filter((c) => c.type !== "text");
			return { content: [{ type: "text", text: short }, ...others], structuredContent: undefined };
		});
	};
}

// ---------- history_search ----------

const HistoryParams = Type.Object({
	query: Type.String({ description: "Words to look for (all must appear), or /regex/ for a regular expression" }),
	max_results: Type.Optional(Type.Number({ description: "Default 8" })),
});

function entryText(m) {
	const parts = [];
	const content = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
	for (const c of content) {
		if (c.type === "text") parts.push(c.text);
		if (c.type === "toolCall") parts.push(`${c.name} ${JSON.stringify(c.arguments ?? {})}`);
	}
	return parts.join("\n");
}

/** Search messages of the active branch, including the ones a summary replaced. Exported for tests. */
export function searchHistory(entries, query, max = 8) {
	const rx = /^\/(.+)\/([a-z]*)$/.exec(query.trim());
	const words = rx ? [] : query.toLowerCase().split(/\s+/).filter(Boolean);
	const re = rx ? new RegExp(rx[1], rx[2].includes("i") ? rx[2] : `${rx[2]}i`) : null;
	const hits = [];
	let n = 0;
	for (const e of entries) {
		if (e.type !== "message") continue;
		n++;
		const m = e.message;
		const text = entryText(m);
		const low = text.toLowerCase();
		const at = re ? text.search(re) : words.every((w) => low.includes(w)) ? low.indexOf(words[0]) : -1;
		if (at < 0) continue;
		const who = m.role === "toolResult" ? `result of ${m.toolName}` : m.role;
		hits.push(`#${n} ${who}:\n${text.slice(Math.max(0, at - 300), at + 900)}`);
	}
	if (!hits.length) return `Nothing in this conversation matches "${query}".`;
	const shown = hits.slice(-max); // the latest matches are usually the relevant ones
	return `${hits.length} match(es), showing the last ${shown.length}:\n\n${shown.join("\n\n---\n\n")}`.slice(0, 12000);
}

export function createHistorySearch() {
	return (pi) => {
		pi.registerTool({
			name: "history_search",
			label: "History",
			description: "Search the full record of this conversation, including the parts that were replaced by a summary " +
				"when the context got long. Use it to recover exact details (an error message, a file's content, a command's " +
				"output) from earlier instead of running things again.",
			promptSnippet: "Search the full earlier conversation, including summarized parts",
			parameters: HistoryParams,
			annotations: { readOnlyHint: true, openWorldHint: false },
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const text = searchHistory(ctx.sessionManager.getBranch(), String(params.query ?? ""), Number(params.max_results) || 8);
				return { content: [{ type: "text", text }], details: undefined };
			},
		});
	};
}
