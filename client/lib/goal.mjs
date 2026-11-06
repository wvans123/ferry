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
//
// "Done" is agreed first: unless the objective already says how to check it, the agent asks you once (ask_user) and
// records the completion criteria (goal_update status "criteria"); without a terminal it writes its own, marked as
// assumed. What you say while the goal runs is kept as a short list of changes. Criteria and changes ride in every
// continue message and in a note after a summary, so they survive compaction. An "achieved" report needs evidence for
// every criterion; it is sent back at most twice.
import { unwrap } from "./text.mjs";
import { steerState } from "./steer.mjs";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const ENTRY = "ferry-goal";
const MAX_CRITERIA = 10;
const MAX_CHANGES = 10;
const MAX_REJECTIONS = 2;
const cut = (s, n) => {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n)}…` : t;
};

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

/** The completion criteria as a numbered list with a heading, or "" when none are recorded (exported for tests). */
export function criteriaText(goal) {
	if (!goal?.criteria?.length) return "";
	return `Completion criteria${goal.criteriaAssumed ? " (assumed by you: nobody could be asked)" : ""}:\n` +
		goal.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
}

/** What the user said while the goal ran, newest last, or "" (exported for tests). */
export function changesText(goal) {
	if (!goal?.changes?.length) return "";
	return "Requirements the user changed since the start (newest last; where one conflicts with the objective or the " +
		`criteria, it wins):\n${goal.changes.map((c) => `- ${c.text}`).join("\n")}`;
}

function guide(goal, hasUI) {
	const criteria = criteriaText(goal);
	const first = criteria ? `${criteria}\n\n`
		: hasUI ? unwrap(`First agree on what "done" means. If the objective already says what must be true and how to
  check it, record that with goal_update status "criteria" without asking. Otherwise propose 2 to 5 checkable completion
  criteria and ask the user once with ask_user (one question; your proposal as the recommended option; they can type
  their own), then record the agreed list with goal_update status "criteria".`) + "\n\n"
		: unwrap(`Nobody can answer questions in this run. Before you start, write down 2 to 5 checkable completion
  criteria yourself, as your assumptions, and record them with goal_update status "criteria"; say in your final report
  that they were assumed.`) + "\n\n";
	return unwrap(`The user gave you a goal to pursue on your own, across as many turns as it takes:

${goal.objective}

`) + first + unwrap(`How to work on it:
- Break it into concrete deliverables and keep them in the todo list; work through them one by one.
- Check each deliverable against real evidence: the file content, the command output, the test result. Do not
  count something as done because it looks plausible.
- If you have the advisor tool, call it once before you report the goal achieved (with the work saved), and deal with what it finds.
- When every criterion is met and checked, call goal_update with status "achieved", a short summary and checks: one
  entry per criterion (its number) with the evidence.
- If you cannot go on without the user (a decision, access, missing information) or it turns out impossible, call
  goal_update with status "unmet" and say exactly what is needed.
- Otherwise keep going: you will be prompted to continue after each turn. Do not stop to ask whether to continue.`);
}

/** Criteria and changes for the continue message and the note after a summary (exported for tests). */
export function goalState(goal) {
	return [criteriaText(goal) || 'You have not recorded completion criteria yet: do that first (goal_update status "criteria").',
		changesText(goal)].filter(Boolean).join("\n");
}

export function createGoal(cfg) {
	return (pi) => {
		let goal = null; // { objective, status, startedAt, budget, turns, note, reported, criteria, criteriaAssumed, changes, rejections }
		let nextBudget = null; // /goal budget before a goal is set
		let ui = null;
		const save = () => {
			if (goal) goal.endedAt = goal.status === "pursuing" ? undefined : goal.endedAt ?? Date.now();
			pi.appendEntry(ENTRY, goal);
		};

		const status = (ctx) => {
			if (!ui) return;
			// a goal that has ended is shown until you send your next message, then the line goes away (/goal still tells)
			if (!goal || (goal.status !== "pursuing" && goal.status !== "paused" && goal.quiet)) return ui.setStatus("ferry-goal", undefined);
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
				criteriaText(goal), changesText(goal),
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
			if (goal && goal.status !== "paused") goal.quiet = true; // an old, finished goal: no status line
			status(ctx);
		});

		// The section changes only when a goal starts, ends or gets its criteria: a changed system prompt is a new
		// first message for the server copy (sync.mjs). Changes the user makes go in recorded messages instead.
		pi.on("before_agent_start", (event, ctx) => {
			if (goal && (goal.status === "pursuing" || goal.status === "paused")) event.systemPromptOptions.sections.ferry_goal = guide(goal, !!ctx?.hasUI);
			else delete event.systemPromptOptions.sections.ferry_goal;
		});

		const reply = (text) => ({ content: [{ type: "text", text }], details: undefined });
		pi.registerTool({
			name: "goal_update",
			label: "Goal",
			description: "For the user's /goal: record the completion criteria (criteria), or report the outcome: achieved " +
				"(every criterion met and checked, with evidence for each in checks) or unmet (blocked: say what is needed). " +
				"Only when a goal is active.",
			promptSnippet: "Record the goal's completion criteria, or report the goal achieved (with evidence) or blocked",
			parameters: Type.Object({
				status: StringEnum(["criteria", "achieved", "unmet"]),
				summary: Type.Optional(Type.String({ description: "achieved / unmet: what was done, or what blocks it" })),
				criteria: Type.Optional(Type.Array(Type.String(), { description: "criteria: the complete list, each one checkable " +
					"(what must be true and how to check it); replaces the earlier list" })),
				checks: Type.Optional(Type.Array(Type.Object({
					criterion: Type.Number({ description: "The criterion's number, from 1" }),
					evidence: Type.String({ description: "How you checked it: file, command output, test result" }),
				}), { description: "achieved: one entry for every completion criterion" })),
				evidence: Type.Optional(Type.String({ description: "How you checked: files, command output, test results" })),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
			async execute(_id, params, _signal, _onUpdate, ctx) {
				if (!goal || goal.status !== "pursuing") return reply("There is no active goal.");
				const summary = String(params.summary ?? "");
				if (params.status === "criteria") {
					const list = (params.criteria ?? []).map((c) => cut(c, 300)).filter(Boolean).slice(0, MAX_CRITERIA);
					if (!list.length) return reply("Give the criteria: a list of 1 to 10 checkable statements.");
					goal.criteria = list;
					goal.criteriaAssumed = !ctx?.hasUI;
					save();
					ctx?.ui?.notify?.(criteriaText(goal), "info");
					return reply(`Recorded ${list.length} completion criteria. They come with every continue message; before you ` +
						'report the goal achieved, check each one and give its evidence in checks.');
				}
				const checks = (params.checks ?? []).filter((c) => String(c?.evidence ?? "").trim());
				const missing = params.status === "achieved"
					? (goal.criteria ?? []).map((_, i) => i + 1).filter((n) => !checks.some((c) => Number(c.criterion) === n)) : [];
				if (missing.length && (goal.rejections ?? 0) < MAX_REJECTIONS) {
					goal.rejections = (goal.rejections ?? 0) + 1;
					save();
					return reply(`Not accepted yet: no evidence for criteria ${missing.join(", ")}:\n` +
						missing.map((n) => `${n}. ${goal.criteria[n - 1]}`).join("\n") +
						"\nCheck each of them for real (read the file, run the command or test). Then call goal_update with status " +
						'"achieved" again, with checks for every criterion; or "unmet" if one cannot be met.');
				}
				goal.status = params.status;
				const proof = [...checks.map((c) => `${c.criterion}: ${c.evidence}`), ...(params.evidence ? [params.evidence] : [])].join("; ");
				goal.note = `${summary}${proof ? ` (evidence: ${proof})` : ""}${missing.length ? ` (no evidence for criteria ${missing.join(", ")})` : ""}`.slice(0, 1000);
				goal.reported = true;
				save();
				status(ctx);
				ctx?.ui?.notify?.(params.status === "achieved" ? `Goal achieved: ${summary}` : `Goal needs you: ${summary}`,
					params.status === "achieved" ? "info" : "warning");
				cfg.phone?.(params.status === "achieved" ? "Goal achieved" : "Goal needs you", summary.slice(0, 120),
					params.status === "achieved" ? "goal" : "approval");
				return reply(`Goal marked ${params.status}. Now give the user a short final report.`);
			},
		});

		pi.on("agent_before_settle", (event, ctx) => {
			if (!goal || goal.status !== "pursuing") return undefined;
			if (event.outcome === "aborted" && steerState.redirecting) return undefined; // interrupted with a new message: keep going
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
				text = `Continue working toward the goal (turn ${goal.turns}). Objective: ${goal.objective}\n${goalState(goal)}\n` +
					"Check what is done and verified and what remains, then take the next step. When every criterion is met and " +
					'checked, call goal_update with status "achieved" and checks; if you are blocked, call it with "unmet".';
			}
			save();
			status(ctx);
			return { continue: true, entries: [{ type: "custom_message", customType: "ferry-goal-continue", content: text, display: false }] };
		});

		// a summary keeps the gist only: give the agent the goal's criteria and the user's changes again, as a hidden
		// message kept in the conversation (uploads stay incremental), read at its next step
		pi.on("session_compact", () => {
			if (goal?.status !== "pursuing") return;
			pi.sendMessage({ customType: "ferry-goal-note", display: false, content: "The conversation was just summarised. " +
				`You are still working on the user's goal: ${goal.objective}\n${goalState(goal)}` }, { deliverAs: "steer" });
		});

		pi.on("agent_settled", (_e, ctx) => status(ctx));
		pi.on("input", (event, ctx) => {
			const text = String(event.text ?? "");
			if (goal && goal.status !== "pursuing" && goal.status !== "paused" && !goal.quiet && !text.startsWith("/goal")) {
				goal.quiet = true;
				status(ctx);
			}
			// a message sent by interrupting was noted when it was typed (steer.mjs sends it again)
			if (goal?.status === "pursuing" && event.source !== "extension" && !steerState.redirecting && text.trim() && !text.startsWith("/")) {
				goal.changes = [...(goal.changes ?? []), { at: Date.now(), text: cut(text, 300) }].slice(-MAX_CHANGES);
				save();
			}
			return { action: "continue" };
		});

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
