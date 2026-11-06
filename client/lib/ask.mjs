// ask_user: the agent asks you one to four questions, each with options to pick from (one, or several), a
// recommended answer marked, and "Other" to type your own. Like Claude Code's AskUserQuestion.
// Without a terminal (ferry -p, a team member run by Paperclip) nobody can answer: the agent is told to go on with
// its recommended choices and to say which it took. With remote answers on, the questions can also be answered on the
// phone (remote.mjs).
import { basename } from "node:path";
import { Type } from "typebox";
import { openRemote, race } from "./remote.mjs";

const OTHER = "Other (type your own)";
const DONE = "Done";

const Option = Type.Object({
	label: Type.String({ description: "The choice, a few words" }),
	description: Type.Optional(Type.String({ description: "What picking it leads to, one short line" })),
});
const Question = Type.Object({
	question: Type.String({ description: "The full question, ending with a question mark" }),
	options: Type.Array(Option, { minItems: 2, maxItems: 6, description: "2 to 6 choices; an \"Other\" choice is added by itself" }),
	recommended: Type.Optional(Type.Array(Type.String(), { description: "Label(s) of the option(s) you recommend" })),
	multiSelect: Type.Optional(Type.Boolean({ description: "true: several options may be picked" })),
});
const Params = Type.Object({
	questions: Type.Array(Question, { minItems: 1, maxItems: 4 }),
});

const labelOf = (o, rec) => `${o.label}${rec.has(o.label) ? " (recommended)" : ""}${o.description ? ` - ${o.description}` : ""}`;

/** One question in the terminal. Returns the answer as text, or undefined when the user pressed Esc (or signal closed it). */
export async function askOne(ui, q, signal) {
	const rec = new Set(q.recommended ?? []);
	// the recommended options first, so Enter on the first line takes the recommendation
	const opts = [...q.options.filter((o) => rec.has(o.label)), ...q.options.filter((o) => !rec.has(o.label))];
	if (!q.multiSelect) {
		const pick = await ui.select(q.question, [...opts.map((o) => labelOf(o, rec)), OTHER], { signal });
		if (pick === undefined || signal?.aborted) return undefined;
		if (pick === OTHER) return (await ui.input(q.question, "your answer", { signal }))?.trim() || undefined;
		return opts.find((o) => labelOf(o, rec) === pick)?.label;
	}
	const chosen = new Set(q.options.filter((o) => rec.has(o.label)).map((o) => o.label));
	let other = "";
	for (;;) {
		const lines = opts.map((o) => `${chosen.has(o.label) ? "[x]" : "[ ]"} ${labelOf(o, rec)}`);
		const otherLine = `${other ? "[x]" : "[ ]"} ${other ? `Other: ${other}` : OTHER}`;
		const pick = await ui.select(`${q.question}\n(several can be picked: Enter ticks or unticks one; "${DONE}" when finished)`,
			[`${DONE} (${chosen.size + (other ? 1 : 0)} picked)`, ...lines, otherLine], { signal });
		if (pick === undefined || signal?.aborted) return undefined;
		if (pick.startsWith(DONE)) break;
		if (pick === otherLine) {
			other = other ? "" : ((await ui.input(q.question, "your answer", { signal }))?.trim() ?? "");
			if (signal?.aborted) return undefined;
			continue;
		}
		const o = opts[lines.indexOf(pick)];
		if (o) chosen.has(o.label) ? chosen.delete(o.label) : chosen.add(o.label);
	}
	const all = [...q.options.filter((o) => chosen.has(o.label)).map((o) => o.label), ...(other ? [other] : [])];
	return all.length ? all.join("; ") : "(nothing picked)";
}

/** Every question in the terminal, or on the phone, whichever answers first. */
export async function askAll(cfg, ui, qs, cwd) {
	const remote = openRemote(cfg, { kind: "ask", who: "", project: basename(cwd), questions: qs });
	const { value, phone } = await race(remote, async (signal) => {
		const answers = [];
		for (const q of qs) {
			const a = await askOne(ui, q, signal);
			if (a === undefined) return { answers, closed: true };
			answers.push(`${q.question} -> ${a}`);
		}
		return { answers };
	});
	if (!phone) return value;
	ui.notify("Answered on the phone", "info");
	return { answers: qs.map((q, i) => `${q.question} -> ${phone.answers[i]}`) };
}

export function createAsk(cfg = {}) {
	return (pi) => {
		pi.registerTool({
			name: "ask_user",
			label: "Ask",
			description: "Ask the user 1 to 4 questions, each with 2 to 6 options to pick from (one, or several with " +
				"multiSelect), your recommended option(s) marked with recommended, and an \"Other\" choice where they type " +
				"their own answer. Use it only when the answer changes what you do and you cannot find it out yourself: " +
				"a choice between real alternatives, a preference, missing information. Not to ask whether to continue.",
			promptSnippet: "Ask the user questions with options to pick from",
			parameters: Params,
			annotations: { readOnlyHint: true, openWorldHint: false },
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const qs = params.questions ?? [];
				if (!ctx?.hasUI) {
					const recs = qs.map((q) => `${q.question} -> ${(q.recommended ?? []).join("; ") || "(no recommendation)"}`).join("\n");
					return { content: [{ type: "text", text: "Nobody can answer here (no terminal). Go on with your recommended " +
						`choices and say in your result which you took:\n${recs}` }], details: { answered: false } };
				}
				const { answers, closed } = await askAll(cfg, ctx.ui, qs, ctx.cwd ?? process.cwd());
				if (closed) {
					return { content: [{ type: "text", text: `The user closed the question without answering${answers.length
						? ` (answers so far:\n${answers.join("\n")})` : ""}. Do not guess: say what you need and stop.` }],
					details: { answered: false } };
				}
				return { content: [{ type: "text", text: `The user answered:\n${answers.join("\n")}` }], details: { answered: true } };
			},
		});
	};
}
