// Subagents: the `task` tool hands a self-contained job to a fresh agent with its own, empty context
// (like Claude Code's Task tool and pi's subagent example). Only the subagent's final report comes back,
// so exploring a big codebase does not fill up the main conversation.
//
// A subagent runs inside this ferry process, talks to the same Ferry server (as its own conversation) and
// asks for approval in the main window, exactly like the main agent. Its whole process is written to
// <FERRY_HOME>/subagents/<day>/ (/tasks shows the latest part); files there go after 7 days.
//
// Built in: explore (read-only search), research (the web), review (checks a finished deliverable against the request)
// and general (same tools as the main agent).
// Your own: Markdown files with a name/description/tools header in
//   <project>/.ferry/agents/, <project>/.claude/agents/ (Claude Code's format) or <FERRY_HOME>/agents/.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { AGENT_DIR, cleanOldFiles, FERRY_HOME, findFerryModel } from "./config.mjs";
import { createGuard } from "./guard.mjs";
import { createPrompt } from "./prompt.mjs";
import { createWeb } from "./web.mjs";
import { listJobs, redrawJobs, startSubagentJob, trackSubagent } from "./jobs.mjs";
import { createBigOutputs } from "./tools.mjs";
import { createOffice } from "./office.mjs";
import { promptWithRecovery, transientMessage } from "./upload.mjs";

const MAX_REPORT_BYTES = 30 * 1024;
const KEEP = 5; // finished subagents kept for a follow-up (task with resume)
export const SUBAGENTS_DIR = join(FERRY_HOME, "subagents");
const TRANSCRIPT_RESULT_BYTES = 4 * 1024;
const TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;
// no nesting; the task list, goal and background jobs belong to the main agent
const NOT_FOR_SUBAGENTS = new Set(["task", "task_batch", "todo", "ask_user", "switch_mode", "goal_update", "job_start", "job_output", "job_stop"]);

// At most cfg.maxParallel subagents run at once (task, background task, task_batch); the others wait for a slot, so a
// big batch does not flood the Ferry server or the model provider.
const slots = { running: 0, waiting: [] };
export async function withSlot(limit, fn, onWait) {
	if (slots.running >= limit) {
		onWait?.(slots.waiting.length + 1);
		await new Promise((r) => slots.waiting.push(r));
	}
	slots.running++;
	try {
		return await fn();
	} finally {
		slots.running--;
		slots.waiting.shift()?.();
	}
}

/** <FERRY_HOME>/subagents/<day>/<id>-<agent>-<slug>.md */
export function transcriptPath(id, agent, description) {
	const slug = String(description ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
	return join(SUBAGENTS_DIR, new Date().toISOString().slice(0, 10), `${id}-${agent}-${slug}.md`);
}

const textOf = (content) => typeof content === "string" ? content
	: (Array.isArray(content) ? content : []).map((c) => c.type === "text" ? c.text : c.type === "image" ? "[an image]" : "").filter(Boolean).join("\n");

function cutBytes(s, max) {
	const n = Buffer.byteLength(s);
	return n <= max ? s : `${Buffer.from(s).subarray(0, max).toString("utf8")}\n...(cut here: ${n} bytes in all)`;
}

/**
 * A subagent's whole process as Markdown, so the user can see what it read and did. Past maxBytes only tasks and
 * reports are added. A follow-up (resume) appends to the same file.
 */
export function createTranscript(file, title, { maxBytes = TRANSCRIPT_MAX_BYTES, resultBytes = TRANSCRIPT_RESULT_BYTES } = {}) {
	let size = 0;
	try {
		size = statSync(file).size;
	} catch {
		// a new file
	}
	let full = size >= maxBytes;
	const put = (text) => {
		try {
			mkdirSync(dirname(file), { recursive: true });
			appendFileSync(file, text, "utf8");
			size += Buffer.byteLength(text);
		} catch {
			// the transcript is a convenience
		}
	};
	const detail = (text) => {
		if (full) return;
		if (size + Buffer.byteLength(text) > maxBytes) {
			full = true;
			return put(`\n...(transcript reached ${Math.round(maxBytes / 1024)} KB: from here on only tasks and reports are written)\n`);
		}
		put(text);
	};
	const time = () => new Date().toTimeString().slice(0, 8);
	if (!size) put(`# ${title}\n`);
	return {
		file,
		task: (prompt) => put(`\n## Task (${time()})\n\n${prompt}\n`),
		assistant: (text) => text.trim() && detail(`\n### Assistant\n\n${text.trim()}\n`),
		toolCall: (name, args) => detail(`\n### Tool call: ${name}\n\n\`\`\`json\n${JSON.stringify(args ?? {})}\n\`\`\`\n`),
		toolResult: (name, text, isError) => detail(`\n${isError ? "Error" : "Result"} (${name}):\n\n\`\`\`\`\n${cutBytes(text, resultBytes)}\n\`\`\`\`\n`),
		report: (text) => put(`\n## Report (${time()})\n\n${text}\n`),
		error: (text) => put(`\n## Failed (${time()})\n\n${text}\n`),
	};
}

/**
 * Finished subagents (session and its Ferry provider), so the main agent can send one a follow-up (task with resume)
 * and it goes on with its whole context, uploading only what is new. Only in this ferry window, the latest `max`;
 * a stopped one is not kept.
 */
export function createKeeper(max = KEEP) {
	const kept = new Map(); // id -> { session, agent, transcript }, oldest first
	const busy = new Set(); // ids working on a follow-up now
	return {
		/** The kept subagent `id`, taken out while its follow-up runs; done() puts it back. */
		take(id) {
			if (busy.has(id)) throw new Error(`Subagent ${id} is still working on a follow-up; wait for its report, then resume it.`);
			const entry = kept.get(id);
			if (!entry) {
				if (listJobs().some((j) => j.id === id && j.status === "running")) {
					throw new Error(`Subagent ${id} is still running; wait for its report, then resume it.`);
				}
				throw new Error(`Subagent ${id} is gone (only the latest ${max} finished subagents of this ferry window are ` +
					"kept, and stopped ones are not). Start a fresh task with the full prompt.");
			}
			kept.delete(id);
			busy.add(id);
			return entry;
		},
		/** A run of subagent `id` ended: keep it as the newest, or let it go when it was stopped. */
		done(id, entry, stopped) {
			busy.delete(id);
			if (!entry) return;
			if (stopped) return entry.session.dispose();
			kept.delete(id);
			kept.set(id, entry);
			for (const [old, e] of kept) {
				if (kept.size <= max) break;
				kept.delete(old);
				e.session.dispose();
			}
		},
		ids: () => [...kept.keys()],
		clear() {
			for (const e of kept.values()) e.session.dispose();
			kept.clear();
		},
	};
}

// the review skill: your own (FERRY_HOME/skills/review) if you have one, else Ferry's
const REVIEW_SKILL = [join(FERRY_HOME, "skills", "review", "SKILL.md"), fileURLToPath(new URL("../skills/review/SKILL.md", import.meta.url))].find(existsSync) ?? "";

const BUILTIN = [
	{
		name: "explore",
		description: "Read-only. Searches and reads code to answer a question or find where something is; returns a short " +
			"report with file paths and line numbers. Use it for open-ended searches across many files.",
		tools: ["read", "grep", "find", "ls", "office_read", "web_fetch", "web_search"],
		prompt: `You are an explorer. Find what the task asks for by searching and reading files. You cannot change
anything. Search broadly first (grep, find), then read only the relevant parts of files.
Finish with a compact report for an agent who has not seen these files:
- the answer, in a few sentences;
- the key files, each with line ranges and one line on what is there;
- short code excerpts only where they matter.`,
	},
	{
		name: "research",
		description: "Finds something out on the web: searches several ways, reads the sources, follows them to the " +
			"primary ones, checks dates, and returns the findings with their addresses. Give it one question (or one part " +
			"of a bigger one); start several with task_batch for independent parts.",
		tools: ["web_search", "web_fetch", "read", "grep", "find", "ls", "office_read", "bash"],
		prompt: `You are a researcher answering one question from the web, in a fresh context. Nobody sees the pages you
read; only your report goes back.
- Plan two or three different searches before the first one (other words, the other language, the official name,
  allowed_domains for the source that would know). For anything that changes over time, put the current year in
  the query or use recent.
- Open the most promising results with web_fetch; snippets are not evidence. Give it a prompt saying what you need
  from the page (only the answer comes back, so you can read many pages); leave the prompt out to see the page's own
  text and links. Follow links to the primary source.
- A page that reads empty is built by JavaScript: open it with agent-browser if the browser skill is there. If the
  search results stay off-topic, search in the browser instead (open the search engine's address, then read it).
- Note the date and version of what you read. Look for a second source on the key facts.
- Use bash only to read (agent-browser, curl to look at something); do not download into the project unless the
  task says so.
- Stop when the question is answered, or after about 15 pages if it cannot be.
Finish with a report for an agent who has read nothing:
- the answer, in a few sentences;
- the findings, each with the address it comes from (and its date when it matters);
- where sources disagree, and what is still unknown.
Keep facts and your own conclusions apart.`,
	},
	{
		name: "review",
		description: "Read-only. Checks a finished deliverable (a document, a deck, a report, code) against the user's original " +
			"request, as someone who did not make it. Give it the request and the file paths; it lists concrete problems with " +
			"their locations and does not rewrite anything. Use it before delivering important work.",
		tools: ["read", "grep", "find", "ls", "office_read", "web_fetch", "web_search"],
		prompt: `You are a reviewer. You did not make the work you are given; check it against the request, as a careful
colleague would before it goes to the customer. You cannot change anything.
- First read the review checklist ${REVIEW_SKILL} and follow the parts that fit this deliverable (documents, 3GPP CRs).
- Open the deliverable itself (office_read for Word, Excel, PowerPoint and PDF; read for text and code) and read all of it.
- Compare it with the request point by point: is everything asked for there, in the form asked for, at the length and
  for the reader the request names?
- Check facts, numbers, names and dates against the sources named in the task; recompute any arithmetic. Check that
  parts agree with each other (figures, terms, section references, the summary against the body).
- Look for thin or generic passages, empty or placeholder text, broken layout you can see in the text, and claims
  nothing supports.
Finish with a short list of concrete problems, most serious first, each with where it is (file, page or slide, section)
and what is wrong. Do not rewrite the work and do not list what is fine; if you find nothing wrong, say what you
checked in one or two lines.`,
	},
	{
		name: "general",
		description: "Does a self-contained piece of work with the same tools as you (reading, editing, running commands; " +
			"the user approves changes as usual). Use it for multi-step side tasks whose details the main conversation does not need.",
		tools: null, // the main agent's tools
		prompt: `You are a worker agent handling one delegated task in a fresh context. Work autonomously until the task
is done. Finish with a short report: what you did, which files you changed, anything the main agent must know.`,
	},
];

function parseAgentFile(file) {
	const text = readFileSync(file, "utf8");
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!m) return null;
	const head = Object.fromEntries(m[1].split(/\r?\n/).map((l) => /^(\w+)\s*:\s*(.*)$/.exec(l)).filter(Boolean)
		.map(([, k, v]) => [k.toLowerCase(), v.trim().replace(/^["']|["']$/g, "")]));
	if (!head.name) return null;
	const tools = head.tools ? head.tools.split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean)
		.map((t) => ({ glob: "find", bash: "bash", read: "read", edit: "edit", write: "write", grep: "grep", ls: "ls" })[t] ?? t) : null;
	// model: a model id the Ferry server lists (e.g. a thinking model for research); empty = the main agent's model
	return { name: head.name, description: head.description, tools, model: head.model || "", prompt: m[2].trim(), file };
}

/** Built-in agents plus the user's own (project ones win over user ones with the same name). */
export function discoverAgents(cwd) {
	const byName = new Map(BUILTIN.map((a) => [a.name, a]));
	for (const dir of [join(FERRY_HOME, "agents"), join(cwd, ".claude", "agents"), join(cwd, ".ferry", "agents")]) {
		if (!existsSync(dir)) continue;
		for (const f of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
			try {
				const a = parseAgentFile(join(dir, f));
				const had = a && byName.get(a.name);
				// a file named like a built-in agent with no text of its own only changes its model (or tools)
				if (had && !a.prompt) byName.set(a.name, { ...had, model: a.model || had.model, tools: a.tools ?? had.tools, file: a.file });
				else if (a?.description) byName.set(a.name, a);
			} catch {
				// unreadable file: skip it
			}
		}
	}
	return [...byName.values()];
}

const Params = Type.Object({
	agent: Type.Optional(Type.String({ description: "Which agent: explore, research, review, general, or one listed in the description. Default general." })),
	description: Type.String({ description: "3 to 6 words saying what the subagent does (shown to the user)" }),
	prompt: Type.String({ description: "The complete task. The subagent sees nothing of this conversation, so include " +
		"every detail it needs and say exactly what to report back." }),
	background: Type.Optional(Type.Boolean({ description: "true: start it and return at once; you are told when it is " +
		"done (job_output shows the report). Use it for long side tasks while you go on with other work." })),
	resume: Type.Optional(Type.Number({ description: "The id of a finished subagent (its report names it) to send prompt " +
		"to as a follow-up: it goes on with everything it already read. agent is then ignored." })),
});

const short = (v) => {
	const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
	return s.length > 70 ? `${s.slice(0, 70)}...` : s;
};

function toolLine(name, args) {
	const a = args ?? {};
	return `${name} ${short(a.command ?? a.path ?? a.pattern ?? a)}`;
}

/**
 * deps.makeSync(): a fresh Ferry model provider for the subagent's conversation.
 * The main agent's model (ctx.model) is used, so the server decides the actual model as usual.
 */
export function createSubagents(cfg, deps) {
	return (pi) => {
		cleanOldFiles(SUBAGENTS_DIR);
		cleanOldFiles(join(FERRY_HOME, "batches"));
		if (cfg.subagents === false) return;
		const agents = discoverAgents(process.cwd());
		const keeper = createKeeper();
		pi.on("session_shutdown", () => keeper.clear());
		pi.registerTool({
			name: "task",
			label: "Subagent",
			description: "Hand a self-contained job to a subagent with its own fresh context; you get back only its final " +
				"report. Use it for independent pieces of work that can run side by side, wide searches across many files or " +
				"pages (agent explore or research), or side tasks with many steps (agent general), so this conversation keeps " +
				"the conclusion and not the material. Several task calls in one reply run at the same time.\n" +
				"A subagent costs more than it looks: it knows only what you write in prompt, details get lost on the way there " +
				"and back, and several at once spend many tokens. A few reads, or a search whose target you know, do yourself.\n" +
				"Write prompt as for a capable colleague who has seen nothing: the goal, what you already know or have ruled " +
				"out, which files, pages or folders to look at, how far to go, and what to report.\n" +
				"Once you hand something off, do not also do it yourself. The user does not see the report: tell them what " +
				"matters in it. Never guess a result that has not come back; if the user asks, say it is still running.\n" +
				"To ask a finished subagent more, pass resume with its id instead of starting a new one.\nAgents:\n" +
				agents.map((a) => `- ${a.name}: ${a.description}`).join("\n"),
			promptSnippet: "Delegate searches and side tasks to subagents with fresh context",
			parameters: Params,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const cwd = ctx?.cwd ?? process.cwd();
				const rid = params.resume === undefined ? undefined : Number(params.resume);
				const prev = rid === undefined ? undefined : keeper.take(rid);
				const agent = prev?.agent ?? discoverAgents(cwd).find((a) => a.name === (params.agent || "general"));
				if (!agent) throw new Error(`No agent named "${params.agent}". Available: ${discoverAgents(cwd).map((a) => a.name).join(", ")}`);
				const limit = Math.max(1, Number(cfg.maxParallel) || 3);
				const name = `${agent.name}: ${params.description}${prev ? ` (follow-up to subagent ${rid})` : ""}`;
				// a subagent's id is the job id of its first run; a follow-up continues the kept session
				const go = async (id, sig, update, job) => {
					let entry = prev;
					try {
						entry ??= { agent, session: await openSession({ cfg, deps, agent, label: `#${id} ${agent.name} (${params.description})`, ctx, cwd, pi }),
							transcript: createTranscript(transcriptPath(id, agent.name, params.description), `Subagent ${id}: ${agent.name}: ${params.description}`) };
						Object.assign(job, { agent: agent.name, transcript: entry.transcript.file });
						return await runSubagent({ session: entry.session, agent, id, params, signal: sig, onUpdate: update, job, transcript: entry.transcript });
					} finally {
						keeper.done(id, entry, sig.aborted);
					}
				};
				if (params.background) {
					const job = startSubagentJob(name, (sig, j) => withSlot(limit, () => go(rid ?? j.id, sig, undefined, j)).then((r) => r.content[0].text));
					return { content: [{ type: "text", text: (prev ? `Sent the follow-up to subagent ${rid}; it works in the background as job ${job.id}.`
						: `Started background subagent ${job.id} (${job.name}).`) + " You will be told when it is done; job_output shows its report." }],
					details: { id: job.id } };
				}
				const t = trackSubagent(name); // shown in /tasks while it runs
				const stop = () => t.job.controller.abort();
				signal?.addEventListener("abort", stop, { once: true });
				try {
					const r = await withSlot(limit, () => go(rid ?? t.job.id, t.job.controller.signal, onUpdate, t.job),
						(n) => onUpdate?.({ content: [{ type: "text", text: `${agent.name}: ${params.description}\n  (waiting: ${limit} subagents already running, ${n} in line)` }], details: {} }));
					t.end(r.content[0].text);
					return r;
				} catch (e) {
					t.end(undefined, String(e?.message ?? e));
					throw e;
				} finally {
					signal?.removeEventListener("abort", stop);
				}
			},
		});

		// One instruction for every item of a list (files, documents, rows): a subagent per item, at most maxParallel at
		// a time, all reports collected in one Markdown file (like Codex's spawn_agents_on_csv).
		pi.registerTool({
			name: "task_batch",
			label: "Batch",
			description: "Do the same job for every item of a list (e.g. review each of 40 documents, summarise each file in a " +
				"folder): a fresh subagent per item, a few at a time, and one results file with every report. Give the items, " +
				"or a text file with one item per line (a CSV: its first column). The prompt says what to do with {item}. " +
				"Use it for 4 or more similar, independent items; use task for one or two.",
			promptSnippet: "Run the same subagent job over many items and collect the reports",
			parameters: Type.Object({
				description: Type.String({ description: "3 to 6 words for the whole batch" }),
				prompt: Type.String({ description: "The job for one item; {item} is replaced by the item. Say what to report, briefly." }),
				items: Type.Optional(Type.Array(Type.String(), { description: "The items (file paths, names, IDs)" })),
				items_file: Type.Optional(Type.String({ description: "Or: a file with one item per line (CSV: first column)" })),
				agent: Type.Optional(Type.String({ description: "Which agent, default general (explore for read-only work)" })),
			}),
			async execute(_id, params, signal, onUpdate, ctx) {
				const cwd = ctx?.cwd ?? process.cwd();
				let items = params.items ?? [];
				if (!items.length && params.items_file) {
					items = readFileSync(join(cwd, params.items_file), "utf8").split(/\r?\n/)
						.map((l) => l.split(",")[0].replace(/^"|"$/g, "").trim()).filter(Boolean);
				}
				items = [...new Set(items)];
				if (!items.length) throw new Error("No items: give items or items_file");
				if (items.length > 200) throw new Error(`${items.length} items: at most 200 per batch; split the list`);
				const agent = discoverAgents(cwd).find((a) => a.name === (params.agent || "general"));
				if (!agent) throw new Error(`No agent named "${params.agent}"`);
				const limit = Math.max(1, Number(cfg.maxParallel) || 3);
				const results = new Array(items.length);
				let done = 0;
				const show = () => onUpdate?.({ content: [{ type: "text", text: `${params.description}: ${done}/${items.length} done ` +
					`(${Math.min(limit, items.length - done)} at a time)` }], details: { done, total: items.length } });
				show();
				const t = trackSubagent(`batch: ${params.description} (${items.length} items)`);
				await Promise.all(items.map((item, i) => withSlot(limit, async () => {
					if (signal?.aborted) {
						results[i] = { item, error: "stopped" };
						return;
					}
					const one = { ...params, description: `${params.description} #${i + 1}`, prompt: params.prompt.replaceAll("{item}", item) };
					const sub = `${t.job.id}.${i + 1}`;
					try {
						const session = await openSession({ cfg, deps, agent, label: `#${sub} ${agent.name} (${one.description})`, ctx, cwd, pi });
						const transcript = createTranscript(transcriptPath(sub, agent.name, params.description), `Subagent ${sub}: ${agent.name}: ${one.description}`);
						Object.assign(t.job, { agent: agent.name, transcript: transcript.file });
						const r = await runSubagent({ session, agent, params: one, signal, onUpdate: undefined, job: t.job, transcript })
							.finally(() => session.dispose());
						results[i] = { item, report: r.content[0].text.replace(/\n\n\[[^\]]*subagent:[^\]]*\]$/, "") };
					} catch (e) {
						results[i] = { item, error: String(e?.message ?? e) };
					}
					done++;
					show();
				})));
				const failed = results.filter((r) => r.error).length;
				mkdirSync(join(FERRY_HOME, "batches"), { recursive: true });
				const file = join(FERRY_HOME, "batches", `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`);
				const body = [`# ${params.description}`, "", `Job: ${params.prompt}`, "",
					...results.flatMap((r, i) => [`## ${i + 1}. ${r.item}`, "", r.error ? `FAILED: ${r.error}` : r.report, ""])].join("\n");
				writeFileSync(file, body, "utf8");
				t.end(`${items.length - failed} done, ${failed} failed: ${file}`);
				const short = results.map((r, i) => `${i + 1}. ${r.item}: ${(r.error ? `FAILED: ${r.error}` : r.report).replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
				return { content: [{ type: "text", text: `${items.length - failed} of ${items.length} done${failed ? `, ${failed} failed` : ""}. ` +
					`Every full report is in ${file} (read it for details).\n\n${short.slice(0, 20000)}` }],
				details: { file, total: items.length, failed } };
			},
		});
	};
}

/** The agent file's model if the server offers it, else the main agent's. */
function pickModel(agent, ctx) {
	if (!agent.model) return ctx?.model;
	const reg = ctx?.modelRegistry;
	return findFerryModel(reg, String(agent.model).replace(/^[^/]*\//, "")) ?? ctx?.model; // "kiro/x" or "x"
}

/** A fresh session for the subagent, with its own Ferry provider (its own server conversation). */
async function openSession({ cfg, deps, agent, label, ctx, cwd, pi }) {
	const { createAgentSession, DefaultResourceLoader, SessionManager } = await import("@earendil-works/pi-coding-agent");
	const parentTools = pi.getActiveTools().filter((t) => !NOT_FOR_SUBAGENTS.has(t));
	const tools = (agent.tools ?? parentTools).filter((t) => !NOT_FOR_SUBAGENTS.has(t));
	const role = agent.prompt;
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: AGENT_DIR,
		noExtensions: true, // only Ferry's own extensions below: predictable, and no nested task tool
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [
			{ name: "ferry-sync", factory: deps.makeSync() },
			{ name: "ferry-prompt", factory: createPrompt(cfg, { subagent: true }) },
			{ name: "ferry-guard", factory: createGuard(cfg, { ui: ctx?.hasUI ? ctx.ui : undefined, label }) },
			{ name: "ferry-big-outputs", factory: createBigOutputs(cfg) },
			{ name: "ferry-web", factory: createWeb(cfg) },
			{ name: "ferry-office", factory: createOffice(cfg) },
			{
				name: "ferry-subagent-role",
				factory: (p) => p.on("before_agent_start", (e) => {
					e.systemPromptOptions.sections.ferry_subagent = role;
				}),
			},
		],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir: AGENT_DIR,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd),
		model: pickModel(agent, ctx),
		// it thinks as much as the main conversation does (pi clamps the level to what the model can do)
		thinkingLevel: pi.getThinkingLevel?.(),
		tools,
	});
	return session;
}

/** One prompt in the subagent's session; the caller disposes of the session or keeps it (id: for a follow-up). */
async function runSubagent({ session, agent, id, params, signal, onUpdate, job, transcript }) {
	const label = `${agent.name}: ${params.description}`;
	transcript?.task(params.prompt);
	const steps = [];
	let turns = 0;
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const progress = () => onUpdate?.({
		content: [{ type: "text", text: `${label}\n${steps.slice(-6).map((s) => `  ${s}`).join("\n") || "  (thinking...)"}` }],
		details: { agent: agent.name, description: params.description, steps: steps.length, turns },
	});
	const unsubscribe = session.subscribe((ev) => {
		if (ev.type === "tool_execution_start") {
			const line = toolLine(ev.toolName, ev.args);
			steps.push(line);
			transcript?.toolCall(ev.toolName, ev.args);
			if (job) {
				(job.steps ??= []).push(line);
				redrawJobs();
			}
			progress();
		}
		if (ev.type === "tool_execution_end") transcript?.toolResult(ev.toolName, textOf(ev.result?.content), ev.isError);
		if (ev.type === "message_end" && ev.message?.role === "assistant") {
			transcript?.assistant(textOf(ev.message.content));
			turns++;
			const u = ev.message.usage ?? {};
			for (const k of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) usage[k] += u[k] ?? 0;
		}
	});
	const stop = () => session.abort().catch(() => {});
	signal?.addEventListener("abort", stop, { once: true });
	progress();
	try {
		// a request stopped on the network (gateway, Cloudflare, dropped connection) is sent again, and the agent told to
		// carry on; only when that fails too does the subagent end
		const left = await promptWithRecovery(session, params.prompt, { aborted: () => signal?.aborted });
		if (signal?.aborted) throw new Error("Subagent stopped");
		let report = session.getLastAssistantText() ?? "";
		if (left) {
			const done = steps.slice(-5).map((s) => `  ${s}`).join("\n") || "  (nothing yet)";
			throw new Error(`Subagent failed: ${left}` + (transientMessage(left)
				? `\nThe network stopped its requests, also after trying again. Its last steps:\n${done}\n` +
					(id === undefined ? "Files it already wrote are kept. To continue, run the task again and say what is done and what is left."
						: `Files it already wrote are kept. To continue, send it a follow-up with task resume: ${id}.`)
				: ""));
		}
		if (!report.trim()) report = "(the subagent finished without a report)";
		if (Buffer.byteLength(report) > MAX_REPORT_BYTES) report = `${report.slice(0, MAX_REPORT_BYTES)}\n...(report cut at 30 KB)`;
		const tag = id === undefined ? `${agent.name} subagent` : `${agent.name} subagent ${id}`;
		const more = (id === undefined ? "" : `; task with resume: ${id} sends it a follow-up`) +
			(transcript ? `; transcript: ${transcript.file}` : "");
		transcript?.report(report);
		return {
			content: [{ type: "text", text: `${report}\n\n[${tag}: ${turns} model calls, ${steps.length} tool calls${more}]` }],
			details: { agent: agent.name, description: params.description, steps: steps.length, turns, toolCalls: steps.slice(-50), id },
			usage,
		};
	} catch (e) {
		transcript?.error(String(e?.message ?? e));
		throw e;
	} finally {
		signal?.removeEventListener("abort", stop);
		unsubscribe();
	}
}
