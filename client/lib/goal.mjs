// /goal: keep working on one objective across many turns until it is done (like Codex's goal mode and Claude Code's
// /goal). The agent itself decides when the goal is met, but only with evidence, through the goal_update tool.
//
//   /goal <objective>          set the goal (or a path to a file that describes it) and start
//   /goal                      show the goal: state, time, tokens, turns, the last note
//   /goal pause | resume | clear
//   /goal budget <tokens>      e.g. 500k or 2m; 0 = no budget (default: goalBudget in ferry config)
//
// States: pursuing, paused, achieved, unmet (blocked; needs you), budget (token budget used up).
// While pursuing, every time the agent stops, Ferry sends it on ("continue toward the goal") unless it has reported
// the goal achieved or unmet, the budget is used up, or the turn limit is reached. Esc pauses the goal.
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const ENTRY = "ferry-goal";

export function parseTokens(s) {
	const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(String(s ?? "").trim());
	if (!m) return null;
	return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] ?? 1));
}

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const mins = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : ms < 3600000 ? `${Math.round(ms / 60000)}m` : `${(ms / 3600000).toFixed(1)}h`);

/** Tokens the conversation used since time t (inputs incl. cache, and outputs; subagents included). */
function tokensSince(entries, t) {
	let n = 0;
	for (const e of entries) {
		const m = e.type === "message" ? e.message : null;
		if (!m?.usage || (m.timestamp ?? 0) < t) continue;
		if (m.role === "assistant" || m.role === "toolResult") {
			n += (m.usage.input ?? 0) + (m.usage.output ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0);
		}
	}
	return n;
}

function guide(goal) {
	return `The user gave you a goal to pursue on your own, across as many turns as it takes:

${goal.objective}

How to work on it:
- Break it into concrete deliverables and keep them in the todo list; work through them one by one.
- Check each deliverable against real evidence: the file content, the command output, the test result. Do not
  count something as done because it looks plausible.
- When every part is done and checked, call goal_update with status "achieved", a short summary and the evidence.
- If you cannot go on without the user (a decision, access, missing information) or it turns out impossible, call
  goal_update with status "unmet" and say exactly what is needed.
- Otherwise keep going: you will be prompted to continue after each turn. Do not stop to ask whether to continue.`;
}

export function createGoal(cfg) {
	return (pi) => {
		let goal = null; // { objective, status, startedAt, budget, turns, note, reported }
		let nextBudget = null; // /goal budget before a goal is set
		let ui = null;
		const save = () => {
			if (goal) goal.endedAt = goal.status === "pursuing" ? undefined : goal.endedAt ?? Date.now();
			pi.appendEntry(ENTRY, goal);
		};

		const status = (ctx) => {
			if (!ui) return;
			if (!goal) return ui.setStatus("ferry-goal", undefined);
			const used = tokensSince(ctx.sessionManager.getBranch(), goal.startedAt);
			const icon = { pursuing: "◎", paused: "‖", achieved: "✓", unmet: "!", budget: "$" }[goal.status] ?? "◎";
			ui.setStatus("ferry-goal", `${icon} goal ${goal.status} · ${mins((goal.status === "pursuing" ? Date.now() : goal.endedAt ?? Date.now()) - goal.startedAt)} · ` +
				`${fmt(used)}${goal.budget ? `/${fmt(goal.budget)}` : ""} tokens · ${goal.turns} turns`);
		};
		const describe = (ctx) => {
			if (!goal) return "No goal. Set one with: /goal <what should be true when it is done>";
			const used = tokensSince(ctx.sessionManager.getBranch(), goal.startedAt);
			return [`Goal (${goal.status}): ${goal.objective}`,
				`Time ${mins((goal.endedAt ?? Date.now()) - goal.startedAt)} · tokens ${fmt(used)}${goal.budget ? ` of ${fmt(goal.budget)}` : ""} · turns ${goal.turns}`,
				goal.note ? `Last note: ${goal.note}` : "",
				"/goal pause | resume | clear | budget <tokens>"].filter(Boolean).join("\n");
		};

		pi.on("session_start", (_e, ctx) => {
			if (ctx.hasUI) ui = ctx.ui;
			goal = null;
			for (const e of ctx.sessionManager.getBranch()) {
				if (e.type === "custom" && e.customType === ENTRY) goal = e.data ?? null;
			}
			if (goal?.status === "pursuing") goal.status = "paused"; // a resumed conversation does not run off by itself
			status(ctx);
		});

		pi.on("before_agent_start", (event) => {
			if (goal && (goal.status === "pursuing" || goal.status === "paused")) event.systemPromptOptions.sections.ferry_goal = guide(goal);
			else delete event.systemPromptOptions.sections.ferry_goal;
		});

		pi.registerTool({
			name: "goal_update",
			label: "Goal",
			description: "Report the outcome of the user's /goal: achieved (everything done and checked, with evidence) or " +
				"unmet (blocked: say what is needed). Only when a goal is active.",
			promptSnippet: "Report that the user's goal is achieved (with evidence) or blocked",
			parameters: Type.Object({
				status: StringEnum(["achieved", "unmet"]),
				summary: Type.String({ description: "What was done, or what blocks it" }),
				evidence: Type.Optional(Type.String({ description: "How you checked: files, command output, test results" })),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
			async execute(_id, params, _signal, _onUpdate, ctx) {
				if (!goal || goal.status !== "pursuing") return { content: [{ type: "text", text: "There is no active goal." }], details: undefined };
				goal.status = params.status;
				goal.note = `${params.summary}${params.evidence ? ` (evidence: ${params.evidence})` : ""}`.slice(0, 600);
				goal.reported = true;
				save();
				status(ctx);
				ctx?.ui?.notify?.(params.status === "achieved" ? `Goal achieved: ${params.summary}` : `Goal needs you: ${params.summary}`,
					params.status === "achieved" ? "info" : "warning");
				cfg.phone?.(params.status === "achieved" ? "Goal achieved" : "Goal needs you", String(params.summary ?? "").slice(0, 120),
					params.status === "achieved" ? "goal" : "approval");
				return { content: [{ type: "text", text: `Goal marked ${params.status}. Now give the user a short final report.` }], details: undefined };
			},
		});

		pi.on("agent_before_settle", (event, ctx) => {
			if (!goal || goal.status !== "pursuing") return undefined;
			if (event.outcome === "aborted") { // Esc
				goal.status = "paused";
				save();
				status(ctx);
				return undefined;
			}
			if (event.outcome === "error") return undefined; // a model or network error: keep the goal, let the user retry
			goal.turns++;
			const used = tokensSince(ctx.sessionManager.getBranch(), goal.startedAt);
			const maxTurns = cfg.goalMaxTurns ?? 100;
			let text;
			if ((goal.budget && used >= goal.budget) || goal.turns >= maxTurns) {
				goal.status = "budget";
				goal.note = goal.budget && used >= goal.budget ? `token budget used (${fmt(used)})` : `turn limit reached (${maxTurns})`;
				cfg.phone?.("Goal stopped", goal.note, "goal");
				text = `The ${goal.note.startsWith("token") ? "token budget" : "turn limit"} for the goal is used up. Do not start new work. ` +
					"Write a short progress report: what is done and checked, what remains, and what you would do next.";
			} else {
				text = `Continue working toward the goal (turn ${goal.turns}). Objective: ${goal.objective}\n` +
					"Check what is done and verified and what remains, then take the next step. When everything is done and " +
					'checked, call goal_update with status "achieved"; if you are blocked, call it with "unmet".';
			}
			save();
			status(ctx);
			return { continue: true, entries: [{ type: "custom_message", customType: "ferry-goal-continue", content: text, display: false }] };
		});

		pi.on("agent_settled", (_e, ctx) => status(ctx));

		pi.registerCommand("goal", {
			description: "Work on an objective until it is done: /goal <objective> | pause | resume | clear | budget <tokens>",
			handler: async (args, ctx) => {
				const a = String(args ?? "").trim();
				const word = a.toLowerCase();
				if (!a) return ctx.ui.notify(describe(ctx), "info");
				if (word === "pause" || word === "resume" || word === "clear") {
					if (!goal) return ctx.ui.notify("No goal set.", "warning");
					if (word === "clear") {
						goal = null;
						pi.appendEntry(ENTRY, null);
						status(ctx);
						return ctx.ui.notify("Goal cleared.", "info");
					}
					goal.status = word === "pause" ? "paused" : "pursuing";
					save();
					status(ctx);
					if (word === "resume") {
						pi.sendUserMessage(`Resume work on the goal: ${goal.objective}`);
						if (!ctx.hasUI) {
							await new Promise((r) => setTimeout(r, 50));
							await ctx.waitForIdle();
						}
					}
					return ctx.ui.notify(`Goal ${goal.status}.`, "info");
				}
				if (word.startsWith("budget")) {
					const n = parseTokens(a.slice(6));
					if (n === null) return ctx.ui.notify("Usage: /goal budget 500k (0 = no budget)", "warning");
					if (!goal) nextBudget = n;
					if (goal) {
						goal.budget = n;
						if (goal.status === "budget") goal.status = "paused";
						save();
						status(ctx);
					}
					return ctx.ui.notify(`Goal budget: ${n ? `${fmt(n)} tokens` : "none"}${goal ? "" : " (applies to the next goal)"}`, "info");
				}
				// a long brief can live in a file: /goal plan.md
				let objective = a;
				const file = resolve(ctx.cwd ?? process.cwd(), a.replace(/^@/, ""));
				if (!/\s/.test(a) && existsSync(file) && statSync(file).isFile()) objective = `${readFileSync(file, "utf8").trim()}\n(from ${a})`;
				goal = { objective, status: "pursuing", startedAt: Date.now(), budget: nextBudget ?? parseTokens(cfg.goalBudget ?? "0") ?? 0, turns: 0, note: "" };
				save();
				status(ctx);
				pi.sendUserMessage(`My goal: ${objective}\n\nWork on it until it is done.`);
				// print mode (ferry -p "/goal ..."): stay in the command until the goal run is over
				if (!ctx.hasUI) {
					await new Promise((r) => setTimeout(r, 50));
					await ctx.waitForIdle();
				}
			},
		});
	};
}
