// Summarising the conversation (compaction) while the agent works.
// The threshold itself is pi's: it checks before every request to the model, also between the steps of one request.
// config.mjs sets pi's margin so that check lands on compactAt / compactLimit (compactReserves). This module adds:
//   - a circuit breaker: two failed automatic summaries in a row stop the automatic ones until the next prompt
//   - one short note after a summary: files changed and skills loaded before it (paths only), so the agent reads again
//     instead of guessing, and the task list as it is now. pi's summary entry already lists the files; this reuses it.

export const MAX_FAILURES = 2;
const MAX_PATHS = 15;

/** The note given to the agent after a summary, or "" when there is nothing to list. */
export function afterSummaryNote(details, tasks = "") {
	const skills = [...new Set((details?.readFiles ?? []).filter((p) => /[\\/]SKILL\.md$/i.test(p)))];
	const changed = [...new Set(details?.modifiedFiles ?? [])];
	if (!skills.length && !changed.length && !tasks) return "";
	const list = (a) => a.slice(-MAX_PATHS).map((p) => `- ${p}`).join("\n") + (a.length > MAX_PATHS ? `\n- (and ${a.length - MAX_PATHS} earlier ones)` : "");
	return "The conversation was just summarised. What you knew about files comes from the summary only: read a file again before " +
		"you edit it or rely on its contents." +
		(changed.length ? `\nFiles you created or changed earlier:\n${list(changed)}` : "") +
		(tasks ? `\nYour task list now:\n${tasks}` : "") +
		(skills.length ? `\nSkills you had loaded (read the SKILL.md again if you still need it):\n${list(skills)}` : "");
}

export function createCompact(cfg, deps = {}) {
	return (pi) => {
		let failures = 0;
		let stopped = false;
		let note = "";

		const reset = () => {
			failures = 0;
			stopped = false;
		};
		// a new prompt from the user (not Ferry's own continuation) starts counting again
		pi.on("input", (e, ctx) => {
			if (e?.source !== "extension") {
				reset();
				if (ctx?.hasUI) ctx.ui.setStatus("ferry-compact", undefined);
			}
			return { action: "continue" };
		});

		pi.on("session_before_compact", (e) => (stopped && e.reason === "threshold" ? { cancel: true } : undefined));

		pi.on("session_compact_failed", (e, ctx) => {
			if (e.aborted || e.reason === "manual") return;
			failures++;
			if (failures < MAX_FAILURES || stopped) return;
			stopped = true;
			const why = String(e.errorMessage ?? "").slice(0, 160);
			if (ctx?.hasUI) {
				ctx.ui.setStatus("ferry-compact", "automatic summaries are off for this request: two failed in a row");
				ctx.ui.notify(`Summarising the conversation failed twice${why ? ` (${why})` : ""}. Automatic summaries stop until your next ` +
					"message. /compact tries by hand; /context sets a smaller size.", "warning");
			}
			cfg.phone?.("Summary failed twice", "the context keeps growing; the request goes on without summaries", "compact");
		});

		pi.on("session_compact", (e) => {
			if (e.reason !== "manual") failures = 0;
			// the task list as it is now: the system prompt has it only as it was when the request began
			const tasks = String(deps.todoText?.() ?? "");
			note = afterSummaryNote(e.compactionEntry?.details, /^\[[ >]\]/m.test(tasks) ? tasks : "");
		});

		// the first request after a summary carries the note, at the end of the conversation
		pi.on("context", (e) => {
			if (!note) return undefined;
			const text = note;
			note = "";
			return { messages: [...e.messages, { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] };
		});
	};
}
