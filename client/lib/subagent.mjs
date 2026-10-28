// Subagents: the `task` tool hands a self-contained job to a fresh agent with its own, empty context
// (like Claude Code's Task tool and pi's subagent example). Only the subagent's final report comes back,
// so exploring a big codebase does not fill up the main conversation.
//
// A subagent runs inside this ferry process, talks to the same Ferry server (as its own conversation) and
// asks for approval in the main window, exactly like the main agent.
//
// Built in: explore (read-only search) and general (same tools as the main agent).
// Your own: Markdown files with a name/description/tools header in
//   <project>/.ferry/agents/, <project>/.claude/agents/ (Claude Code's format) or <FERRY_HOME>/agents/.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { AGENT_DIR, FERRY_HOME } from "./config.mjs";
import { createGuard } from "./guard.mjs";
import { createPrompt } from "./prompt.mjs";
import { createWeb } from "./web.mjs";
import { startSubagentJob, trackSubagent } from "./jobs.mjs";
import { createBigOutputs } from "./tools.mjs";

const MAX_REPORT_BYTES = 30 * 1024;
// no nesting; the task list, goal and background jobs belong to the main agent
const NOT_FOR_SUBAGENTS = new Set(["task", "todo", "goal_update", "job_start", "job_output", "job_stop"]);

const BUILTIN = [
	{
		name: "explore",
		description: "Read-only. Searches and reads code to answer a question or find where something is; returns a short " +
			"report with file paths and line numbers. Use it for open-ended searches across many files.",
		tools: ["read", "grep", "find", "ls", "web_fetch", "web_search"],
		prompt: `You are an explorer. Find what the task asks for by searching and reading files. You cannot change
anything. Search broadly first (grep, find), then read only the relevant parts of files.
Finish with a compact report for an agent who has not seen these files:
- the answer, in a few sentences;
- the key files, each with line ranges and one line on what is there;
- short code excerpts only where they matter.`,
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
	if (!head.name || !head.description) return null;
	const tools = head.tools ? head.tools.split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean)
		.map((t) => ({ glob: "find", bash: "bash", read: "read", edit: "edit", write: "write", grep: "grep", ls: "ls" })[t] ?? t) : null;
	return { name: head.name, description: head.description, tools, prompt: m[2].trim(), file };
}

/** Built-in agents plus the user's own (project ones win over user ones with the same name). */
export function discoverAgents(cwd) {
	const byName = new Map(BUILTIN.map((a) => [a.name, a]));
	for (const dir of [join(FERRY_HOME, "agents"), join(cwd, ".claude", "agents"), join(cwd, ".ferry", "agents")]) {
		if (!existsSync(dir)) continue;
		for (const f of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
			try {
				const a = parseAgentFile(join(dir, f));
				if (a) byName.set(a.name, a);
			} catch {
				// unreadable file: skip it
			}
		}
	}
	return [...byName.values()];
}

const Params = Type.Object({
	agent: Type.Optional(Type.String({ description: "Which agent: explore, general, or one listed in the description. Default general." })),
	description: Type.String({ description: "3 to 6 words saying what the subagent does (shown to the user)" }),
	prompt: Type.String({ description: "The complete task. The subagent sees nothing of this conversation, so include " +
		"every detail it needs and say exactly what to report back." }),
	background: Type.Optional(Type.Boolean({ description: "true: start it and return at once; you are told when it is " +
		"done (job_output shows the report). Use it for long side tasks while you go on with other work." })),
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
		if (cfg.subagents === false) return;
		const agents = discoverAgents(process.cwd());
		pi.registerTool({
			name: "task",
			label: "Subagent",
			description: "Hand a self-contained job to a subagent with its own fresh context; you get back only its final " +
				"report. Use it for wide searches (agent explore) or side tasks with many steps (agent general), so the " +
				"main conversation stays small. Several task calls in one reply run at the same time. Do not use it for a " +
				"single file read or a quick search you can do yourself.\nAgents:\n" +
				agents.map((a) => `- ${a.name}: ${a.description}`).join("\n"),
			promptSnippet: "Delegate searches and side tasks to subagents with fresh context",
			parameters: Params,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const cwd = ctx?.cwd ?? process.cwd();
				const agent = discoverAgents(cwd).find((a) => a.name === (params.agent || "general"));
				if (!agent) throw new Error(`No agent named "${params.agent}". Available: ${discoverAgents(cwd).map((a) => a.name).join(", ")}`);
				if (params.background) {
					const job = startSubagentJob(`${agent.name}: ${params.description}`, (sig) =>
						runSubagent({ cfg, deps, agent, params, signal: sig, onUpdate: undefined, ctx, cwd, pi })
							.then((r) => r.content[0].text));
					return { content: [{ type: "text", text: `Started background subagent ${job.id} (${job.name}). You will be told ` +
						"when it is done; job_output shows its report." }], details: { id: job.id } };
				}
				const t = trackSubagent(`${agent.name}: ${params.description}`); // shown in /tasks while it runs
				const stop = () => t.job.controller.abort();
				signal?.addEventListener("abort", stop, { once: true });
				try {
					const r = await runSubagent({ cfg, deps, agent, params, signal: t.job.controller.signal, onUpdate, ctx, cwd, pi });
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
	};
}

async function runSubagent({ cfg, deps, agent, params, signal, onUpdate, ctx, cwd, pi }) {
	const { createAgentSession, DefaultResourceLoader, SessionManager } = await import("@earendil-works/pi-coding-agent");
	const label = `${agent.name}: ${params.description}`;
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
			{ name: "ferry-prompt", factory: createPrompt() },
			{ name: "ferry-guard", factory: createGuard(cfg, { ui: ctx?.hasUI ? ctx.ui : undefined, label }) },
			{ name: "ferry-big-outputs", factory: createBigOutputs(cfg) },
			{ name: "ferry-web", factory: createWeb(cfg) },
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
		model: ctx?.model,
		tools,
	});
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
			steps.push(toolLine(ev.toolName, ev.args));
			progress();
		}
		if (ev.type === "message_end" && ev.message?.role === "assistant") {
			turns++;
			const u = ev.message.usage ?? {};
			for (const k of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) usage[k] += u[k] ?? 0;
		}
	});
	const stop = () => session.abort().catch(() => {});
	signal?.addEventListener("abort", stop, { once: true });
	progress();
	try {
		await session.prompt(params.prompt);
		if (signal?.aborted) throw new Error("Subagent stopped");
		let report = session.getLastAssistantText() ?? "";
		const last = [...session.messages].reverse().find((m) => m.role === "assistant");
		if (last?.stopReason === "error") throw new Error(`Subagent failed: ${last.errorMessage ?? "model error"}`);
		if (!report.trim()) report = "(the subagent finished without a report)";
		if (Buffer.byteLength(report) > MAX_REPORT_BYTES) report = `${report.slice(0, MAX_REPORT_BYTES)}\n...(report cut at 30 KB)`;
		return {
			content: [{ type: "text", text: `${report}\n\n[${agent.name} subagent: ${turns} model calls, ${steps.length} tool calls]` }],
			details: { agent: agent.name, description: params.description, steps: steps.length, turns, toolCalls: steps.slice(-50) },
			usage,
		};
	} finally {
		signal?.removeEventListener("abort", stop);
		unsubscribe();
		session.dispose();
	}
}
