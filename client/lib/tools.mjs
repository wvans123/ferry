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
import { FERRY_HOME, parseTokens } from "./config.mjs";

export const OUTPUTS_DIR = join(FERRY_HOME, "outputs");
const KEEP_DAYS = 7;
// Tools whose output is data the model asked for on purpose: never cut (read has its own paging)
const NEVER_CUT = new Set(["read", "edit", "write", "memory", "todo", "task", "history_search", "past_conversations"]);

// ---------- todo ----------

const TodoParams = Type.Object({
	todos: Type.Array(Type.Object({
		content: Type.String({ description: "What to do, in a few words" }),
		status: StringEnum(["pending", "in_progress", "completed"]),
	}), { description: "The complete list. Send every item each time; at most one in_progress." }),
});

const MARK = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
const render = (todos) => todos.map((t) => `${MARK[t.status] ?? "[ ]"} ${t.content}`).join("\n");

let shared = []; // the main agent's to-do list, for /tasks

/** The to-do list as text, or "" when there is none. */
export const todoText = () => (shared.length ? render(shared) : "");

export function createTodo() {
	return (pi) => {
		let todos = [];
		const show = (ctx) => {
			if (!ctx?.hasUI) return;
			shared = todos;
			const open = todos.filter((t) => t.status !== "completed").length;
			ctx.ui.setWidget("ferry-todo", todos.length && open ? [`To-do (${todos.length - open}/${todos.length} done)`,
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

// ---------- past_conversations ----------

const PastParams = Type.Object({
	action: StringEnum(["list", "search", "read"], { description: "list: recent conversations; search: find the ones " +
		"that mention something; read: one conversation's messages (with query: only the parts that match)" }),
	query: Type.Optional(Type.String({ description: "search / read: words that must all appear, or /regex/" })),
	conversation: Type.Optional(Type.String({ description: "read: the number or id from list / search" })),
	all_projects: Type.Optional(Type.Boolean({ description: "Also conversations started in other folders (default: this folder only)" })),
	max_results: Type.Optional(Type.Number({ description: "Default 15" })),
});

const day = (d) => new Date(d).toLocaleString("sv-SE", { hour12: false }).slice(0, 16);

/** A conversation as plain text: what the user and the agent said, tool calls in one line, tool results cut short. */
export function transcript(entries, maxBytes = 40000) {
	const out = [];
	for (const e of entries) {
		if (e.type === "compaction" && e.summary) out.push(`[summary of the earlier part]\n${e.summary}`);
		if (e.type !== "message") continue;
		const m = e.message;
		if (m.role === "user") out.push(`USER: ${entryText(m)}`);
		else if (m.role === "assistant") {
			const text = entryText(m).trim();
			if (text) out.push(`AGENT: ${text}`);
		} else if (m.role === "toolResult") {
			const t = entryText(m);
			out.push(`  (${m.toolName} result: ${t.length > 400 ? `${t.slice(0, 400)}...` : t})`);
		}
	}
	let text = out.join("\n\n");
	if (Buffer.byteLength(text) > maxBytes) text = `...(earlier part cut; ask with a query to find it)\n\n${text.slice(-maxBytes)}`;
	return text;
}

export function createPastConversations() {
	return (pi) => {
		let lastList = [];
		pi.registerTool({
			name: "past_conversations",
			label: "Past conversations",
			description: "Look through the user's earlier Ferry conversations (stored on this computer): list the recent ones, " +
				"search them for a topic, or read one. Use it when the user refers to another or an earlier conversation " +
				"(\"what did we decide last time\", \"continue the work from yesterday's session\", \"read my other conversation " +
				"about X\"). Start with list or search, then read the one that fits.",
			promptSnippet: "List, search and read the user's earlier conversations",
			parameters: PastParams,
			annotations: { readOnlyHint: true, openWorldHint: false },
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const { SessionManager } = await import("@earendil-works/pi-coding-agent");
				const cwd = ctx?.cwd ?? process.cwd();
				const current = ctx?.sessionManager?.getSessionFile?.();
				const all = (params.all_projects ? await SessionManager.listAll() : await SessionManager.list(cwd))
					.filter((s) => s.path !== current && s.messageCount > 0)
					.sort((a, b) => new Date(b.modified) - new Date(a.modified));
				const max = Number(params.max_results) || 15;
				const line = (s, i) => `${i + 1}. [${s.id.slice(0, 8)}] ${day(s.modified)}  ${s.name ? `"${s.name}"  ` : ""}` +
					`${s.messageCount} messages${params.all_projects ? `  (${s.cwd || "?"})` : ""}\n   first: ${String(s.firstMessage ?? "").replace(/\s+/g, " ").slice(0, 120)}`;
				const text = (t) => ({ content: [{ type: "text", text: t }], details: undefined });
				if (params.action === "list") {
					lastList = all.slice(0, max);
					return text(lastList.length ? `${all.length} earlier conversation(s)${params.all_projects ? "" : " in this folder"}, newest first:\n\n` +
						lastList.map(line).join("\n") : "No earlier conversations here. Try all_projects: true.");
				}
				if (params.action === "search") {
					const q = String(params.query ?? "").trim();
					if (!q) throw new Error("search needs a query");
					const rx = /^\/(.+)\/([a-z]*)$/.exec(q);
					const re = rx ? new RegExp(rx[1], rx[2].includes("i") ? rx[2] : `${rx[2]}i`) : null;
					const words = rx ? [] : q.toLowerCase().split(/\s+/);
					const hits = all.filter((s) => {
						const t = `${s.name ?? ""}\n${s.allMessagesText ?? ""}`;
						return re ? re.test(t) : words.every((w) => t.toLowerCase().includes(w));
					}).slice(0, max);
					lastList = hits;
					if (!hits.length) return text(`No earlier conversation mentions "${q}"${params.all_projects ? "" : " in this folder (try all_projects: true)"}.`);
					return text(hits.map((s, i) => {
						const t = s.allMessagesText ?? "";
						const at = re ? t.search(re) : t.toLowerCase().indexOf(words[0]);
						return `${line(s, i)}\n   ...${t.slice(Math.max(0, at - 150), at + 250).replace(/\s+/g, " ")}...`;
					}).join("\n\n"));
				}
				const want = String(params.conversation ?? "").trim();
				if (!want) throw new Error("read needs conversation: a number or id from list / search");
				const pool = [...lastList, ...all];
				const s = /^\d{1,3}$/.test(want) && lastList[Number(want) - 1] ? lastList[Number(want) - 1]
					: pool.find((x) => x.id.startsWith(want) || x.name === want);
				if (!s) throw new Error(`No conversation "${want}". Use list or search first.`);
				const branch = SessionManager.open(s.path).getBranch();
				const head = `Conversation [${s.id.slice(0, 8)}] ${s.name ? `"${s.name}" ` : ""}from ${day(s.created)} to ${day(s.modified)}\n\n`;
				return text(head + (params.query ? searchHistory(branch, String(params.query), Number(params.max_results) || 8) : transcript(branch)));
			},
		});
	};
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

// ---------- leave old tool outputs out ----------
//
// The longest part of a long conversation is usually tool output the agent has long finished with (a file it read
// twenty steps ago, a long command output). Once the context passes trimOldOutputs tokens, Ferry replaces old,
// long tool results with a one-line note, all at once (so the cached prefix changes rarely), keeping the latest few.
// The replacement is stored in the session (pi's context edits), so it stays the same after /resume.
// Your messages and the agent's answers are never touched; history_search still finds the full text.

const TRIM_KEEP = 6; // the latest tool results always stay
const TRIM_MIN_CHARS = 2000;
const TRIM_TOOLS = new Set(["read", "bash", "powershell", "grep", "find", "ls", "web_fetch", "web_search", "job_output",
	"office_read", "history_search", "past_conversations"]);

/** Context-edit drafts for the old, long tool results of a branch (exported for tests). */
export function trimDrafts(entries, keep = TRIM_KEEP, minChars = TRIM_MIN_CHARS) {
	const edited = new Set(entries.filter((e) => e.type === "context_edit").map((e) => e.targetId));
	const results = entries.filter((e) => e.type === "message" && e.message?.role === "toolResult");
	const old = results.slice(0, Math.max(0, results.length - keep));
	const drafts = [];
	for (const e of old) {
		const m = e.message;
		if (edited.has(e.id) || !TRIM_TOOLS.has(m.toolName)) continue;
		const text = (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
		if (text.length < minChars) continue;
		const kb = Math.max(1, Math.round(Buffer.byteLength(text) / 1024));
		drafts.push({ type: "context_edit", targetId: e.id, replacement: { content: [{ type: "text",
			text: `[Ferry: this ${m.toolName} output (${kb} KB) was left out to keep the context small; the agent saw it ` +
				"earlier. Run the tool again, or use history_search, if you need it.]" }] } });
	}
	return drafts;
}

export function createTrimOldOutputs(cfg) {
	return (pi) => {
		const at = parseTokens(cfg.trimOldOutputs ?? "80k");
		if (!at) return; // off
		pi.on("turn_end", (_event, ctx) => {
			const used = ctx.getContextUsage?.()?.tokens ?? 0;
			if (used < at) return undefined;
			const drafts = trimDrafts(ctx.sessionManager.getBranch());
			if (!drafts.length) return undefined;
			if (ctx.hasUI) ctx.ui.setStatus("ferry-trim", `left out ${drafts.length} old tool output(s)`);
			return { entries: drafts };
		});
	};
}
