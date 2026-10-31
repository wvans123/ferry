// The terminal tab's title, like Cursor and Claude Code: what this conversation is about, the project, and whether the
// agent is working or waiting for you, so several ferry tabs can be told apart at a glance.
//
//   ⏳ fix the login bug · my-project · Ferry      the agent is working
//   ❓ fix the login bug · my-project · Ferry      it waits for your approval
//   fix the login bug · my-project · Ferry         idle
// The conversation's name is the one set with /name, otherwise the start of your first message.
import { basename } from "node:path";

export const titleState = { state: "idle" }; // idle | working | asking

const MARK = { working: "⏳ ", asking: "❓ ", idle: "" };

function firstMessage(sessionManager) {
	try {
		for (const e of sessionManager.getBranch()) {
			const m = e.type === "message" ? e.message : null;
			if (m?.role !== "user") continue;
			const text = typeof m.content === "string" ? m.content
				: (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
			const t = text.replace(/\s+/g, " ").trim();
			if (t) return t.length > 40 ? `${t.slice(0, 40)}…` : t;
		}
	} catch {
		// no session yet
	}
	return "";
}

/** The title for a session (exported for tests). */
export function ferryTitle({ name, first, cwd, state = titleState.state }) {
	return `${MARK[state] ?? ""}${[name || first || "new conversation", basename(cwd || process.cwd()), "Ferry"].join(" · ")}`;
}

const titleOf = (sm, state) => ferryTitle({ name: sm?.getSessionName?.(), first: firstMessage(sm), cwd: sm?.getCwd?.(), state });

/** pi's own title ("π - project") is replaced by Ferry's whenever pi sets it. */
export async function installTitle() {
	try {
		const index = import.meta.resolve("@earendil-works/pi-coding-agent");
		const { InteractiveMode } = await import(new URL("./modes/interactive/interactive-mode.js", index).href);
		InteractiveMode.prototype.updateTerminalTitle = function updateTerminalTitle() {
			this.ui.terminal.setTitle(titleOf(this.sessionManager));
		};
		return true;
	} catch {
		return false;
	}
}

/** The extension: updates the title as the agent starts, waits for approval, and finishes. */
export function createTitle(permState) {
	return (pi) => {
		let last = null;
		const set = (ctx, state) => {
			if (state) titleState.state = state;
			if (!ctx?.hasUI) return;
			last = ctx;
			ctx.ui.setTitle(titleOf(ctx.sessionManager));
		};
		pi.on("session_start", (_e, ctx) => set(ctx, "idle"));
		pi.on("agent_start", (_e, ctx) => set(ctx, "working"));
		pi.on("agent_settled", (_e, ctx) => set(ctx, "idle"));
		pi.on("session_info_changed", (_e, ctx) => set(ctx));
		pi.on("message_end", (e, ctx) => {
			if (e.message?.role === "user") set(ctx); // the first message names a new conversation
		});
		if (permState) { // the approval box: shown in the title too, so you see which tab needs you
			const ask = permState.onAsk;
			const answered = permState.onAnswered;
			permState.onAsk = (...a) => {
				set(last, "asking");
				return ask?.(...a);
			};
			permState.onAnswered = (...a) => {
				set(last, "working");
				return answered?.(...a);
			};
		}
	};
}
