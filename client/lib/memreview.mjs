// Memory review: Ferry proposes memories from your previous conversation, and tidies them when you ask; you confirm
// every change.
//   a new conversation (ferry, /new): the previous conversation in this folder, if you wrote at least three messages
//     in it and it was not looked at yet, goes as a compact transcript to the Ferry server, whose summary model
//     proposes up to three memories. Each is shown with Save / Skip once the agent is idle and the editor is empty.
//   /memory tidy: the user and project memories go to the server, which proposes merges, rewrites and deletions.
// The server keeps nothing (server/ferry_server/memreview.py). Pinned memories are never changed. Without a terminal
// (ferry -p, a team member) nothing is proposed. Which conversations were looked at: <FERRY_HOME>/memory/reviewed.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serverHeaders } from "./config.mjs";
import { MEMORY_ROOT, indexDescriptions, listMemories, loadIndex, readMemory, refreshGlobal, runMemory, scopeDir } from "./memory.mjs";

const REVIEWED = join(MEMORY_ROOT, "reviewed.json");
const SCOPES = ["user", "project"];
const MIN_USER_MESSAGES = 3;
const TRANSCRIPT_CHARS = 60_000;
const MEMORY_SEND_CHARS = 4000; // a longer memory is not sent, so the model cannot change it
const MEMORIES_CHARS = 40_000;
const START_DELAY_MS = 1000;
const PROPOSE_MS = 90_000;
const TIDY_MS = 180_000;
const SHOW_POLL_MS = 2000;
const SHOW_GIVE_UP_MS = 30 * 60_000;

const clip = (t, n) => (t.length > n ? `${t.slice(0, n)} ...` : t);
const textOf = (m) => (typeof m.content === "string" ? m.content
	: (Array.isArray(m.content) ? m.content : []).filter((b) => b?.type === "text").map((b) => b.text).join("\n"));
const today = () => new Date().toLocaleDateString("sv-SE");

/** The conversation as short text: what the user and the agent said; tool calls left out, tool results a line each. */
export function compactTranscript(entries, max = TRANSCRIPT_CHARS) {
	const out = [];
	for (const e of entries) {
		if (e.type === "compaction" && e.summary) out.push(`[Summary of the earlier part]\n${clip(e.summary, 4000)}`);
		if (e.type !== "message") continue;
		const m = e.message;
		if (m.role === "user") out.push(`[User]: ${clip(textOf(m).trim(), 4000)}`);
		else if (m.role === "assistant") {
			const t = textOf(m).trim();
			if (t) out.push(`[Assistant]: ${clip(t, 2000)}`);
		} else if (m.role === "toolResult") out.push(`  (${m.toolName} result: ${clip(textOf(m).replace(/\s+/g, " ").trim(), 200)})`);
	}
	let text = out.join("\n\n");
	if (text.length > max) {
		const head = Math.floor(max / 4);
		text = `${text.slice(0, head)}\n\n[... the middle is left out ...]\n\n${text.slice(-(max - head))}`;
	}
	return text;
}

const userMessages = (entries) => entries.filter((e) => e.type === "message" && e.message?.role === "user").length;

function loadReviewed() {
	try {
		return JSON.parse(readFileSync(REVIEWED, "utf8")) ?? {};
	} catch {
		return {};
	}
}

/** Remember that a conversation was looked at, and with how many user messages (it is looked at again once it grows). */
export function markReviewed(id, users) {
	const r = loadReviewed();
	delete r[id];
	r[id] = users;
	mkdirSync(MEMORY_ROOT, { recursive: true });
	writeFileSync(REVIEWED, JSON.stringify(Object.fromEntries(Object.entries(r).slice(-300))), "utf8");
}

export function needsReview(id, users) {
	const done = loadReviewed()[id];
	return users >= MIN_USER_MESSAGES && (done === undefined || users - done >= MIN_USER_MESSAGES);
}

/** The conversation before this one in this folder: the one /new left, or at startup the newest other one. */
export async function previousConversation(ctx, event) {
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const current = ctx.sessionManager?.getSessionFile?.();
	let path = event?.previousSessionFile;
	if (!path) {
		const all = await SessionManager.list(ctx.cwd ?? process.cwd());
		path = all.filter((s) => s.path !== current && s.messageCount > 0).sort((a, b) => b.modified - a.modified)[0]?.path;
	}
	if (!path || path === current || !existsSync(path)) return null;
	const prev = SessionManager.open(path);
	const entries = prev.getBranch();
	return { id: prev.getSessionId(), entries, users: userMessages(entries) };
}

/** The memories the model may change (not pinned, not too long), and their keys "scope/name". */
export function editableMemories(cwd) {
	const memories = [];
	let used = 0;
	for (const scope of SCOPES) {
		for (const m of listMemories(scope, cwd)) {
			if (m.pinned || m.body.length > MEMORY_SEND_CHARS || used + m.body.length > MEMORIES_CHARS) continue;
			memories.push({ scope, name: m.name, description: m.description, content: m.body, updated: m.updated });
			used += m.body.length;
		}
	}
	return { memories, editable: new Set(memories.map((m) => `${m.scope}/${m.name}`)) };
}

async function askServer(cfg, body, timeoutMs) {
	const res = await fetch(`${cfg.server}/v1/ferry/memory-review`, {
		method: "POST", headers: serverHeaders(cfg, { "Content-Type": "application/json" }), body: JSON.stringify(body),
		redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
	});
	const json = res.headers.get("content-type")?.includes("json") ? await res.json().catch(() => null) : null;
	if (!res.ok || !json) throw new Error(json?.error ?? `the Ferry server answered HTTP ${res.status}`);
	return json;
}

/** Proposals the user can accept: right scope, an update only of a memory the model saw, an add never over an existing one. */
export function checkCandidates(list, cwd, editable) {
	const out = [];
	for (const c of Array.isArray(list) ? list : []) {
		if (!SCOPES.includes(c?.scope) || !c.name || !String(c.content ?? "").trim()) continue;
		const dir = scopeDir(c.scope, cwd);
		let { action, name } = c;
		if (readMemory(dir, name)) {
			if (action === "update" && !editable.has(`${c.scope}/${name}`)) continue;
			if (action !== "update") {
				let i = 2;
				while (readMemory(dir, `${c.name}-${i}`)) i++;
				name = `${c.name}-${i}`;
			}
		} else action = "add";
		out.push({ ...c, action, name });
	}
	return out;
}

function save(cwd, scope, name, description, content) {
	const old = indexDescriptions(scopeDir(scope, cwd))[name] ?? "";
	return runMemory({ action: "save", scope, name, description: description || old, content, replace: true }, cwd);
}

/** Ask about each proposal; write the accepted ones. */
export async function confirmCandidates(ctx, list, cwd) {
	let saved = 0;
	for (const [i, c] of list.entries()) {
		const title = [`Remember this? (from your last conversation here, ${i + 1} of ${list.length})`,
			`${c.action === "update" ? "Update" : "New"} ${c.scope} memory "${c.name}"${c.description ? `: ${c.description}` : ""}`,
			"", c.content.trim(), ...(c.reason ? ["", `Why: ${c.reason}`] : [])].join("\n");
		const pick = await ctx.ui.select(title, ["Save", "Skip", "Skip the rest"]);
		if (pick === "Save") {
			try {
				save(cwd, c.scope, c.name, c.description, c.content);
				saved++;
			} catch (e) {
				ctx.ui.notify(`Could not save memory "${c.name}": ${e.message}`, "warning");
			}
		} else if (pick !== "Skip") break;
	}
	if (saved) ctx.ui.notify(`Saved ${saved} memor${saved === 1 ? "y" : "ies"} from your last conversation (/memory shows them).`, "info");
}

async function propose(cfg, ctx, event) {
	if ((ctx.sessionManager?.getBranch?.() ?? []).some((e) => e.type === "message")) return null; // a resumed conversation
	const prev = await previousConversation(ctx, event);
	if (!prev || !needsReview(prev.id, prev.users)) return null;
	const cwd = ctx.cwd ?? process.cwd();
	const { memories, editable } = editableMemories(cwd);
	const g = await refreshGlobal(cfg);
	const r = await askServer(cfg, {
		kind: "propose", model: ctx.model?.id ?? "", today: today(), transcript: compactTranscript(prev.entries), memories,
		indexes: { user: loadIndex(scopeDir("user", cwd)), project: loadIndex(scopeDir("project", cwd)), ...(g.enabled ? { global: g.index } : {}) },
	}, PROPOSE_MS);
	return { ...prev, cwd, list: checkCandidates(r.candidates, cwd, editable) };
}

// ---------- /memory tidy ----------

/** Operations that touch only memories the model saw, in one scope. */
export function checkOperations(list, editable) {
	const ok = (scope, name) => editable.has(`${scope}/${name}`);
	return (Array.isArray(list) ? list : []).filter((o) => SCOPES.includes(o?.scope) && o.name && (
		o.op === "merge" ? o.sources?.length >= 2 && o.sources.every((n) => ok(o.scope, n)) && String(o.content ?? "").trim()
			: o.op === "rewrite" ? ok(o.scope, o.name) && String(o.content ?? "").trim()
				: o.op === "delete" && ok(o.scope, o.name)));
}

export function describeOperation(o) {
	const what = o.op === "merge" ? `Merge ${o.scope} memories ${o.sources.map((n) => `"${n}"`).join(" + ")} into "${o.name}"`
		: `${o.op === "rewrite" ? "Rewrite" : "Delete"} ${o.scope} memory "${o.name}"`;
	return [what, ...(o.reason ? [`Why: ${o.reason}`] : []), ...(o.op === "delete" ? [] : ["", o.content.trim()])].join("\n");
}

export function applyOperation(o, cwd) {
	const dir = scopeDir(o.scope, cwd);
	const gone = (o.op === "merge" ? o.sources : [o.name]).filter((n) => !readMemory(dir, n));
	if (gone.length) throw new Error(`${gone.join(", ")} no longer there`);
	if (o.op === "delete") return runMemory({ action: "delete", scope: o.scope, name: o.name }, cwd);
	save(cwd, o.scope, o.name, o.description, o.content);
	for (const n of o.op === "merge" ? o.sources.filter((s) => s !== o.name) : []) runMemory({ action: "delete", scope: o.scope, name: n }, cwd);
}

async function tidy(cfg, ctx) {
	const cwd = ctx.cwd ?? process.cwd();
	const say = (t, level = "info") => (ctx.hasUI ? ctx.ui.notify(t, level) : process.stdout.write(`${t}\n`));
	const { memories, editable } = editableMemories(cwd);
	if (memories.length < 2) return say("Nothing to tidy: fewer than two memories that may change (pinned and very long ones are left alone).");
	let ops;
	if (ctx.hasUI) ctx.ui.setStatus("ferry-tidy", `memory: asking the server how to tidy ${memories.length} memories...`);
	try {
		ops = checkOperations((await askServer(cfg, { kind: "tidy", model: ctx.model?.id ?? "", today: today(), memories }, TIDY_MS)).operations, editable);
	} catch (e) {
		return say(`/memory tidy failed: ${e.message}`, "warning");
	} finally {
		if (ctx.hasUI) ctx.ui.setStatus("ferry-tidy", undefined);
	}
	if (!ops.length) return say("Your memories look tidy: nothing to change.");
	if (!ctx.hasUI) return say(`${ops.map(describeOperation).join("\n\n")}\n\nRun /memory tidy in the terminal to apply these.`);
	let applied = 0;
	for (const [i, o] of ops.entries()) {
		const pick = await ctx.ui.select(`Tidy memory (${i + 1} of ${ops.length})\n${describeOperation(o)}`, ["Apply", "Skip", "Stop"]);
		if (pick === "Skip") continue;
		if (pick !== "Apply") break;
		try {
			applyOperation(o, cwd);
			applied++;
		} catch (e) {
			ctx.ui.notify(`Skipped: ${e.message}`, "warning");
		}
	}
	say(`Tidy: applied ${applied} of ${ops.length} change${ops.length === 1 ? "" : "s"}.`);
}

export function createMemoryReview(cfg) {
	if (cfg.memory !== false && cfg.server) cfg.memoryTidy = (ctx) => tidy(cfg, ctx);
	return (pi) => {
		if (cfg.memory === false || cfg.memoryReview === false || !cfg.server) return;
		let run = 0; // which conversation a proposal belongs to: a newer one drops it
		pi.on("session_start", (event, ctx) => {
			const mine = ++run;
			if (!ctx.hasUI || !["startup", "new"].includes(event?.reason)) return;
			const ready = () => ctx.isIdle() && !ctx.ui.getEditorText?.()?.trim();
			setTimeout(async () => {
				let found;
				try {
					found = await propose(cfg, ctx, event);
				} catch {
					return; // the server is old, busy or unreachable: try again next time
				}
				if (!found || mine !== run) return;
				if (!found.list.length) return markReviewed(found.id, found.users);
				const until = Date.now() + SHOW_GIVE_UP_MS;
				const tick = () => {
					try {
						if (mine !== run || Date.now() > until) return clearInterval(timer);
						if (!ready()) return;
						clearInterval(timer);
						markReviewed(found.id, found.users);
						void confirmCandidates(ctx, found.list, found.cwd).catch(() => {});
					} catch {
						clearInterval(timer); // this conversation's context is gone
					}
				};
				const timer = setInterval(tick, SHOW_POLL_MS);
				timer.unref?.();
				tick();
			}, START_DELAY_MS).unref?.();
		});
	};
}
