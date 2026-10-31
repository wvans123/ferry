// The permission gate: every tool call passes through decide() (permissions.mjs) before it runs.
// Asking happens in the terminal; a subagent asks through the main window (opts.ui) and says who is asking.
import { randomBytes } from "node:crypto";
import { findBash } from "./config.mjs";
import { addRule, decide, hostOf, loadRules, MODE_LABEL, MODES, prefixRule } from "./permissions.mjs";

// One state per ferry process, shared by the main agent and its subagents
const state = { mode: "default", queue: Promise.resolve(), extraDirs: [] }; // extraDirs: more folders treated like the project

export function initialMode(cfg) {
	if (process.env.FERRY_AUTO_APPROVE === "1") return "bypass";
	if (MODES.includes(process.env.FERRY_PERMISSION_MODE)) return process.env.FERRY_PERMISSION_MODE;
	// run by Paperclip, nobody at a terminal to ask: a model judges what the rules cannot decide, the rest is refused
	if (process.env.PAPERCLIP_RUN_ID && !["acceptEdits", "auto", "bypass"].includes(cfg.permissionMode)) return "auto";
	return MODES.includes(cfg.permissionMode) ? cfg.permissionMode : "default";
}

const short = (s, n = 300) => (s.length > n ? `${s.slice(0, n)}...` : s);

/** Ask the user. Returns { block, reason } or undefined (go ahead). */
async function ask(ui, verdict, event, cwd, who) {
	const tool = event.toolName;
	const input = event.input ?? {};
	const detail = short(String(input.command ?? input.path ?? input.url ?? JSON.stringify(input)));
	const head = verdict.danger ? `Careful: this ${verdict.danger}.\n\n` : verdict.outside ? "This is outside the project folder.\n\n"
		: verdict.judged ? `Auto mode is not sure: ${verdict.judged}\n\n` : "";
	const isShell = tool === "bash" || tool === "powershell";
	const isEdit = ["edit", "write", "office_edit", "office_create"].includes(tool);
	const rules = isShell ? [...new Set((verdict.pending ?? verdict.segments ?? [input.command ?? ""]).map((s) => prefixRule(tool, s)))]
		: tool === "web_fetch" || tool === "web_render" ? [`web_fetch(${hostOf(input.url)})`] // one site (covers both)
		: [tool.startsWith("mcp__") ? `${tool.split("__").slice(0, 2).join("__")}__*` : tool]; // a whole MCP server
	const scope = tool === "web_fetch" || tool === "web_render" ? "user" : "project"; // a site you trust, you trust everywhere
	const options = ["Allow once"];
	if (!verdict.danger && !verdict.outside) {
		if (isEdit) options.push("Allow all file changes from now on (auto-edit mode)");
		else options.push(scope === "user" ? `Always allow this site: ${hostOf(input.url)}` : `Always allow in this project: ${rules.join(", ")}`);
	}
	options.push("Deny", "Deny, and tell the agent what to do instead");
	// the phone console may answer instead (remote.mjs): it closes this question with its own answer
	const remote = new AbortController();
	let fromPhone = null;
	state.pendingAsk = {
		id: randomBytes(4).toString("hex"), tool, detail: short(detail, 300),
		danger: verdict.danger || (verdict.outside ? "outside the project folder" : ""),
		answer: (action, note) => {
			if (fromPhone) return;
			fromPhone = { action, note };
			remote.abort();
		},
	};
	state.onPending?.();
	let choice;
	try {
		choice = await ui.select(`${head}Allow ${tool}${who}?\n\n  ${detail}`, options, { signal: remote.signal });
	} finally {
		state.pendingAsk = null;
		state.onPending?.();
	}
	if (fromPhone?.action === "approve") {
		ui.notify(`Allowed from the phone: ${tool}`, "info");
		return undefined;
	}
	if (fromPhone) {
		ui.notify(`Denied from the phone: ${tool}`, "warning");
		return { block: true, reason: fromPhone.note || "The user denied this action from their phone" };
	}
	if (choice === "Allow once") return undefined;
	if (choice?.startsWith("Allow all file changes")) {
		state.mode = "acceptEdits";
		state.onModeChange?.();
		return undefined;
	}
	if (choice?.startsWith("Always allow")) {
		for (const r of rules) addRule(cwd, "allow", r, scope);
		ui.notify(`Saved: ${rules.join(", ")} (/status shows the rule files)`, "info");
		return undefined;
	}
	if (choice === "Deny, and tell the agent what to do instead") {
		const note = await ui.input("What should the agent do instead?", "");
		return { block: true, reason: `The user denied this. ${note ? `They said: ${note}` : ""}`.trim() };
	}
	return { block: true, reason: "The user denied this action" };
}

/**
 * opts.ui / opts.label: for a subagent, which has no terminal of its own: ask in the main window
 * and say which subagent is asking.
 */
export function createGuard(cfg, opts = {}) {
	return (pi) => {
		const readOnlyTool = (name) => pi.getAllTools().find((t) => t.name === name)?.annotations?.readOnlyHint === true;
		pi.on("tool_call", async (event, ctx) => {
			const cwd = ctx?.cwd ?? process.cwd();
			const ui = opts.ui ?? (ctx.hasUI ? ctx.ui : null);
			const run = async () => {
				// a background job is a shell command like any other
				const tool = event.toolName === "job_start" ? (findBash() ? "bash" : "powershell") : event.toolName;
				const verdict = decide({ tool, input: event.input, mode: state.mode, cwd,
					rules: loadRules(cwd), blockedPaths: cfg.blockedPaths ?? [], readOnlyTool, extraDirs: state.extraDirs });
				if (verdict.action === "allow") return undefined;
				if (verdict.action === "deny") {
					if (verdict.blocked && ui) ui.notify(`Ferry blocked ${event.toolName} on a protected path (${verdict.blocked})`, "warning");
					return { block: true, reason: verdict.reason };
				}
				// auto mode: what the rules could not decide goes to a model on the server; anything but a clear yes asks
				if (state.mode === "auto" && !verdict.danger && !verdict.outside && cfg.judge) {
					const j = await cfg.judge({ tool, input: event.input, cwd }).catch(() => null);
					if (j?.verdict === "allow") {
						ui?.setStatus?.("ferry-auto", `auto: allowed ${tool} (${String(j.reason ?? "").slice(0, 60)})`);
						return undefined;
					}
					verdict.judged = j?.reason || "the judge did not answer";
				}
				if (!ui) return { block: true, reason: "This needs the user's approval and no terminal is available. " +
					"Run ferry interactively, or allow it with a rule (ferry config) or mode." };
				state.onAsk?.(tool);
				try {
					return await ask(ui, verdict, { ...event, toolName: tool }, cwd, opts.label ? ` (${opts.label})` : "");
				} finally {
					state.onAnswered?.();
				}
			};
			// one question at a time: parallel tool calls wait, and see rules saved by the previous answer
			const result = state.queue.then(run, run);
			state.queue = result.catch(() => {});
			return result;
		});
	};
}

/** Modes, Shift+Tab and the footer: only for the main agent. */
export function createModes(cfg) {
	return (pi) => {
		state.mode = initialMode(cfg);
		let current = null;
		const show = () => current?.ui?.setStatus("ferry-mode", `${MODE_LABEL[state.mode]} (shift+tab)`);
		state.onModeChange = show;
		const setMode = (m, ctx) => {
			state.mode = m;
			show();
			ctx?.ui?.notify(`Mode: ${MODE_LABEL[m]}`, "info");
		};
		pi.on("session_start", (_e, ctx) => {
			if (ctx.hasUI) current = ctx;
			show();
		});
		pi.on("before_agent_start", (event) => {
			const s = event.systemPromptOptions.sections;
			if (state.mode === "plan") {
				s.ferry_mode = "Plan mode is on: you may only read and search (including read-only commands). " +
					"Investigate, then present a concise, concrete plan and stop. Do not try to change files.";
			} else delete s.ferry_mode;
		});
		pi.registerShortcut("shift+tab", {
			description: "Cycle permission mode",
			handler: (ctx) => setMode(MODES[(MODES.indexOf(state.mode) + 1) % MODES.length], ctx),
		});
	};
}

export { state as _state };
