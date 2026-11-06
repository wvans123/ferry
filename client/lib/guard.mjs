// The permission gate: every tool call passes through decide() (permissions.mjs) before it runs.
// Asking happens in the terminal; a subagent asks through the main window (opts.ui) and says who is asking.
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { findBash } from "./config.mjs";
import { resolve } from "node:path";
import { addRule, decide, hostOf, loadRules, MODE_LABEL, MODES, newSession, noteCreated, prefixRule, restoreSession } from "./permissions.mjs";

// One state per ferry process, shared by the main agent and its subagents
// extraDirs: more folders treated like the project; session: what this run made (deletable in bypass without asking)
const state = { mode: "default", queue: Promise.resolve(), extraDirs: [], session: newSession() };
const CREATES = new Set(["write", "office_create", "image_create"]);
const MADE = "ferry-made"; // saved with the conversation: when it started and what Ferry made, so a resumed one still knows

export function initialMode(cfg) {
	if (process.env.FERRY_AUTO_APPROVE === "1") return "bypass";
	if (MODES.includes(process.env.FERRY_PERMISSION_MODE)) return process.env.FERRY_PERMISSION_MODE;
	// run by Paperclip, nobody at a terminal to ask: file changes in the project go ahead; what would need asking is
	// refused with a reason (the member says so in its task)
	if (process.env.PAPERCLIP_RUN_ID && !["acceptEdits", "bypass"].includes(cfg.permissionMode)) return "acceptEdits";
	return MODES.includes(cfg.permissionMode) ? cfg.permissionMode : "default";
}

const short = (s, n = 300) => (s.length > n ? `${s.slice(0, n)}...` : s);

/** Ask the user. Returns { block, reason } or undefined (go ahead). */
async function ask(ui, verdict, event, cwd, who) {
	const tool = event.toolName;
	const input = event.input ?? {};
	const detail = short(String(input.command ?? input.path ?? input.url ?? JSON.stringify(input)));
	const head = verdict.danger ? `Careful: this ${verdict.danger}.\n\n` : verdict.outside ? "This is outside the project folder.\n\n"
		: "";
	const isShell = tool === "bash" || tool === "powershell";
	const isEdit = ["edit", "write", "office_edit", "office_create", "image_create"].includes(tool);
	const rules = isShell ? [...new Set((verdict.pending ?? verdict.segments ?? [input.command ?? ""]).map((s) => prefixRule(tool, s)))]
		: tool === "web_fetch" ? [`web_fetch(${hostOf(input.url)})`] // one site
		: [tool.startsWith("mcp__") ? `${tool.split("__").slice(0, 2).join("__")}__*` : tool]; // a whole MCP server
	const scope = tool === "web_fetch" ? "user" : "project"; // a site you trust, you trust everywhere
	const options = ["Allow once"];
	if (!verdict.danger && !verdict.outside) {
		if (isEdit) options.push("Allow all file changes from now on (auto-edit mode)");
		else options.push(scope === "user" ? `Always allow this site: ${hostOf(input.url)}` : `Always allow in this project: ${rules.join(", ")}`);
	}
	options.push("Deny", "Deny, and tell the agent what to do instead");
	// a subagent (who is set) asks through the main window, maybe while you look elsewhere: leave one line in the
	// conversation view with who asked, what, and why, and another with the answer (shown only, never sent to the model)
	const line = who ? short(detail.replace(/\s+/g, " "), 100) : "";
	if (who) ui.notify(`Subagent ${who} asks to run ${tool}: ${line}${verdict.danger ? ` (it ${verdict.danger})` : verdict.outside ? " (outside the project)" : ""}`, "warning");
	const answered = (text) => who && ui.notify(`Subagent ${who}: ${tool} ${line}: ${text}`, "info");
	const choice = await ui.select(`${who ? `Subagent ${who} wants to run:\n\n` : ""}${head}Allow ${tool}?\n\n  ${detail}`, options);
	if (choice === "Allow once") return answered("allowed once"), undefined;
	if (choice?.startsWith("Allow all file changes")) {
		state.mode = "acceptEdits";
		state.onModeChange?.();
		return answered("allowed, file changes now go ahead"), undefined;
	}
	if (choice?.startsWith("Always allow")) {
		for (const r of rules) addRule(cwd, "allow", r, scope);
		ui.notify(`Saved: ${rules.join(", ")} (/status shows the rule files)`, "info");
		return answered("always allowed"), undefined;
	}
	if (choice === "Deny, and tell the agent what to do instead") {
		const note = await ui.input("What should the agent do instead?", "");
		answered("denied");
		return { block: true, reason: `The user denied this. ${note ? `They said: ${note}` : ""}`.trim() };
	}
	answered("denied");
	return { block: true, reason: "The user denied this action" };
}

/**
 * opts.ui / opts.label: for a subagent, which has no terminal of its own: ask in the main window
 * and say which subagent is asking (label, e.g. "#3 research (check new contributions)").
 */
export function createGuard(cfg, opts = {}) {
	return (pi) => {
		if (!opts.ui) { // the main agent: its conversation keeps the record (subagents write to it through state.persist)
			state.persist = (data) => {
				try {
					pi.appendEntry(MADE, data);
				} catch {
					// the record is a convenience
				}
			};
			pi.on("session_start", (_e, ctx) => {
				let records = [];
				try {
					records = (ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch()).filter((e) => e.type === "custom" && e.customType === MADE).map((e) => e.data);
				} catch {
					// no session record to read
				}
				state.session = newSession();
				const back = restoreSession(records);
				if (back) {
					state.session.start = back.start;
					state.session.made = back.made;
				} else state.persist({ start: state.session.start });
			});
		}
		const readOnlyTool = (name) => pi.getAllTools().find((t) => t.name === name)?.annotations?.readOnlyHint === true;
		pi.on("tool_call", async (event, ctx) => {
			const cwd = ctx?.cwd ?? process.cwd();
			const ui = opts.ui ?? (ctx.hasUI ? ctx.ui : null);
			const run = async () => {
				// a background job is a shell command like any other
				const tool = event.toolName === "job_start" ? (findBash() ? "bash" : "powershell") : event.toolName;
				const verdict = decide({ tool, input: event.input, mode: state.mode, cwd, session: state.session,
					rules: loadRules(cwd), blockedPaths: cfg.blockedPaths ?? [], readOnlyTool, extraDirs: state.extraDirs });
				const made = (r) => {
					if (!r && CREATES.has(tool) && event.input?.path) {
						const added = noteCreated(state.session, resolve(cwd, String(event.input.path)));
						if (added.length) state.persist?.({ add: added });
					}
					return r;
				};
				if (verdict.action === "allow") return made(undefined);
				if (verdict.action === "deny") {
					if (verdict.blocked && ui) ui.notify(`Ferry blocked ${event.toolName} on a protected path (${verdict.blocked})`, "warning");
					return { block: true, reason: verdict.reason };
				}
				if (!ui) return { block: true, reason: verdict.always
					? `This needs the user's approval every time (it ${verdict.danger}) and no terminal is available. No rule or mode allows it.`
					: "This needs the user's approval and no terminal is available. Run ferry interactively, or allow it with a rule (ferry config) or mode." };
				state.onAsk?.(tool);
				try {
					return made(await ask(ui, verdict, { ...event, toolName: tool }, cwd, opts.label ?? ""));
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

// least to most permissive: leaving plan mode never ends above the mode the user had before it
const RANK = ["plan", "default", "acceptEdits", "bypass"];
const lower = (a, b) => (RANK.indexOf(a) < RANK.indexOf(b) ? a : b);

const SwitchParams = Type.Object({
	target: StringEnum(["plan", "back"], { description: "plan: switch to plan mode; back: leave plan mode and start" }),
	reason: Type.String({ description: "One line for the user: why plan first, or what the plan will do" }),
});

/** Modes, Shift+Tab, the footer and switch_mode: only for the main agent. */
export function createModes(cfg) {
	return (pi) => {
		state.mode = initialMode(cfg);
		let current = null;
		// the mode of the latest request outside plan mode, and the mode leaving plan mode returns to
		let used = state.mode === "plan" ? "default" : state.mode;
		let beforePlan = "default";
		const show = () => current?.ui?.setStatus("ferry-mode", `${MODE_LABEL[state.mode]} (shift+tab)`);
		state.onModeChange = show;
		const setMode = (m, ctx) => {
			// Shift+Tab reaches plan only from acceptEdits, often on the way from default: take the lower of the two
			if (m === "plan" && state.mode !== "plan") beforePlan = lower(used, state.mode);
			state.mode = m;
			show();
			ctx?.ui?.notify(`Mode: ${MODE_LABEL[m]}`, "info");
		};
		pi.on("session_start", (_e, ctx) => {
			if (ctx.hasUI) current = ctx;
			else pi.setActiveTools(pi.getActiveTools().filter((t) => t !== "switch_mode")); // nobody to ask
			show();
		});
		pi.on("before_agent_start", (event) => {
			if (state.mode !== "plan") used = state.mode;
			const s = event.systemPromptOptions.sections;
			if (state.mode === "plan") {
				s.ferry_mode = "Plan mode is on: you may only read and search (including read-only commands). " +
					`Investigate, then present a concise, concrete plan${current ? "; to start carrying it out, ask with " +
					"switch_mode (target back)" : " and stop"}. Do not try to change files.`;
			} else delete s.ferry_mode;
		});
		pi.registerShortcut("shift+tab", {
			description: "Cycle permission mode",
			handler: (ctx) => setMode(MODES[(MODES.indexOf(state.mode) + 1) % MODES.length], ctx),
		});
		const reply = (text, switched) => ({ content: [{ type: "text", text }], details: { switched, mode: state.mode } });
		pi.registerTool({
			name: "switch_mode",
			label: "Mode",
			description: "Ask the user to switch to plan mode (target plan) or to leave it (target back); the user decides. " +
				"Propose plan mode before a large or ambiguous task, or one with real trade-offs: you then only read and " +
				"present a plan. In plan mode, once the plan is presented, ask with back to start carrying it out.",
			promptSnippet: "Ask the user to enter or leave plan mode",
			parameters: SwitchParams,
			annotations: { readOnlyHint: true, openWorldHint: false },
			async execute(_id, params, _signal, _onUpdate, ctx) {
				if (!ctx?.hasUI) return reply("Only the user can switch modes, and nobody can be asked here. Carry on in the current mode.", false);
				const reason = String(params.reason ?? "").trim();
				const toPlan = params.target !== "back";
				if (toPlan && state.mode === "plan") return reply("Plan mode is already on.", false);
				if (!toPlan && state.mode !== "plan") return reply(`Plan mode is not on (mode: ${MODE_LABEL[state.mode]}); nothing to leave.`, false);
				const to = toPlan ? "plan" : beforePlan;
				const question = toPlan
					? `The agent suggests plan mode: it only reads and presents a plan before changing anything.\n\n  ${reason}\n\nSwitch to plan mode?`
					: `The agent asks to leave plan mode and start.\n\n  ${reason}\n\nSwitch to: ${MODE_LABEL[to]}?`;
				state.onAsk?.("switch_mode");
				let pick;
				try {
					pick = await ctx.ui.select(question, toPlan ? ["Yes, plan first", `No, carry on (${MODE_LABEL[state.mode]})`]
						: ["Yes, start", "No, keep planning"]);
				} finally {
					state.onAnswered?.();
				}
				if (!pick?.startsWith("Yes")) {
					return reply(toPlan ? `The user said no to plan mode. Carry on in the current mode (${MODE_LABEL[state.mode]}).`
						: "The user wants to stay in plan mode. Stop and wait for their feedback on the plan.", false);
				}
				setMode(to, ctx);
				return reply(toPlan ? "The user agreed: plan mode is on. Only reading and searching are allowed now. Investigate, " +
					"present a concise plan, then ask with switch_mode (target back) to start."
					: `The user agreed: plan mode is off, the mode is now ${MODE_LABEL[to]}. Carry out the plan.`, true);
			},
		});
	};
}

export { state as _state };
