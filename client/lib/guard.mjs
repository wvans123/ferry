// The permission gate: every tool call passes through decide() (permissions.mjs) before it runs.
// Asking happens in the terminal; a subagent asks through the main window (opts.ui) and says who is asking.
import { addRule, decide, hostOf, loadRules, MODE_LABEL, MODES, prefixRule, removeRule, ruleFiles } from "./permissions.mjs";

// One state per ferry process, shared by the main agent and its subagents
const state = { mode: "default", queue: Promise.resolve() };

export function initialMode(cfg) {
	if (process.env.FERRY_AUTO_APPROVE === "1") return "bypass";
	return MODES.includes(cfg.permissionMode) ? cfg.permissionMode : "default";
}

const short = (s, n = 300) => (s.length > n ? `${s.slice(0, n)}...` : s);

/** Ask the user. Returns { block, reason } or undefined (go ahead). */
async function ask(ui, verdict, event, cwd, who) {
	const tool = event.toolName;
	const input = event.input ?? {};
	const detail = short(String(input.command ?? input.path ?? input.url ?? JSON.stringify(input)));
	const head = verdict.danger ? `Careful: this ${verdict.danger}.\n\n` : verdict.outside ? "This is outside the project folder.\n\n" : "";
	const isShell = tool === "bash" || tool === "powershell";
	const isEdit = tool === "edit" || tool === "write";
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
	const choice = await ui.select(`${head}Allow ${tool}${who}?\n\n  ${detail}`, options);
	if (choice === "Allow once") return undefined;
	if (choice?.startsWith("Allow all file changes")) {
		state.mode = "acceptEdits";
		state.onModeChange?.();
		return undefined;
	}
	if (choice?.startsWith("Always allow")) {
		for (const r of rules) addRule(cwd, "allow", r, scope);
		ui.notify(`Saved: ${rules.join(", ")} (see /permissions)`, "info");
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
				const verdict = decide({ tool: event.toolName, input: event.input, mode: state.mode, cwd,
					rules: loadRules(cwd), blockedPaths: cfg.blockedPaths ?? [], readOnlyTool });
				if (verdict.action === "allow") return undefined;
				if (verdict.action === "deny") {
					if (verdict.blocked && ui) ui.notify(`Ferry blocked ${event.toolName} on a protected path (${verdict.blocked})`, "warning");
					return { block: true, reason: verdict.reason };
				}
				if (!ui) return { block: true, reason: "This needs the user's approval and no terminal is available. " +
					"Run ferry interactively, or allow it with a rule (ferry config) or mode." };
				return ask(ui, verdict, event, cwd, opts.label ? ` (${opts.label})` : "");
			};
			// one question at a time: parallel tool calls wait, and see rules saved by the previous answer
			const result = state.queue.then(run, run);
			state.queue = result.catch(() => {});
			return result;
		});
	};
}

/** Modes, Shift+Tab, the footer, /mode and /permissions: only for the main agent. */
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
		pi.registerCommand("plan", {
			description: "Switch to read-only plan mode and plan a task (Shift+Tab switches back to carry it out)",
			handler: async (args, ctx) => {
				setMode("plan", ctx);
				const task = String(args ?? "").trim();
				if (task) {
					pi.sendUserMessage(`Make a plan for this task: ${task}\n\nLook at the relevant code first. Then give a ` +
						"short, concrete plan: the steps, the files each step touches, how to verify the result, and any open " +
						"questions for me. Do not change anything yet.");
				}
			},
		});
		pi.registerCommand("mode", {
			description: "Permission mode: default, acceptEdits, plan, bypass",
			handler: async (args, ctx) => {
				const want = String(args ?? "").trim();
				if (MODES.includes(want)) return setMode(want, ctx);
				const pick = await ctx.ui.select("Permission mode", MODES.map((m) => `${m}: ${MODE_LABEL[m]}`));
				if (pick) setMode(pick.split(":")[0], ctx);
			},
		});
		pi.registerCommand("permissions", {
			description: "Show and remove permission rules",
			handler: async (_args, ctx) => {
				const cwd = ctx.cwd ?? process.cwd();
				for (;;) {
					const r = loadRules(cwd);
					const items = [...r.allow.map((x) => `allow  ${x}`), ...r.ask.map((x) => `ask    ${x}`), ...r.deny.map((x) => `deny   ${x}`)];
					const f = ruleFiles(cwd);
					const pick = await ctx.ui.select(`Mode: ${MODE_LABEL[state.mode]}\nRules (pick one to remove it). Files:\n  ${f.user}\n  ${f.project}\n  ${f.team} (team, read only here)`,
						[...items, "Done"]);
					if (!pick || pick === "Done") return;
					const [list, ...rest] = pick.split(/\s+/);
					const rule = rest.join(" ");
					if (!removeRule(cwd, list, rule)) ctx.ui.notify("That rule is in the team file: edit it there", "warning");
				}
			},
		});
	};
}

export { state as _state };
