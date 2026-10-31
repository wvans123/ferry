// Talking to the agent while it works, like Claude Code and Codex.
//
//   Enter         while the agent works: your message waits and goes in at the next step (pi's own "steering")
//   Enter again   on an empty input line: interrupt now. What the agent is writing is stopped and tool calls it has not
//                 started are skipped; a tool that is already running (a build, the tests) is allowed to finish.
//                 Then your message goes in as a normal message, followed by a note to the agent: it was interrupted,
//                 what it was doing at that moment, and that your message is a change of course to re-plan around.
//   Alt+Enter     after the agent has finished
//   Alt+Up        take the waiting messages back into the input box
//   Esc           stop
//
// The input box is pi's (InteractiveMode, not exported), so it is patched by file like trim.mjs does.
import { currentTodo } from "./tools.mjs";

export const steerState = {
	pending: null,      // { text, doing, waitedFor } while an interruption is on its way
	redirecting: false, // true while the interrupted run is stopped and the new one starts (goal mode keeps going)
	running: 0,         // tools running now
	doing: "",          // what the agent is doing, for the note
	skipped: 0,         // tool calls not run because of the interruption
	waiter: null,
};

const ARGS = ["command", "path", "file_path", "pattern", "url", "query", "description", "agent"];

function describe(tool, args) {
	const a = ARGS.map((k) => args?.[k]).find((v) => typeof v === "string" && v.trim());
	return a ? `${tool} (${a.replace(/\s+/g, " ").slice(0, 100)})` : tool;
}

/** What the agent is told after your message (exported for tests). */
export function steerNote({ doing, waitedFor, partial }, skipped = 0, todo = currentTodo()) {
	const at = waitedFor ? `running ${waitedFor}; it was allowed to finish and its result is above`
		: doing ? doing : "working";
	return "[Ferry: the user's message just before this note interrupted you while you were working. " +
		`At that moment you were ${at}${todo ? `, on the to-do item "${todo}"` : ""}. ` +
		(partial ? `What you had written so far (stopped, so it is not in the conversation): "${partial}". ` : "") +
		(skipped ? `${skipped} tool call(s) you had started were not run. ` : "") +
		"Take the message as a change of course: where it conflicts with your earlier plan, it wins. " +
		"Before more tool calls, say in a sentence or two what you now understand the user wants and what you will do differently. " +
		"If the user says something you did was wrong, say what was wrong and which of your changes need undoing, then fix them. " +
		"Update the to-do list if the plan changed. If the message only adds a detail, take it into account and carry on.]";
}

const SKIPPED = "Not run: the user interrupted with new instructions (they follow).";

/** The extension: keeps track of what the agent is doing and holds back new tool calls while an interruption waits. */
export function createSteer() {
	const st = steerState;
	return (pi) => {
		pi.on("message_start", (e) => {
			if (e.message?.role === "assistant" && !st.running) st.doing = "writing your next step";
		});
		pi.on("tool_execution_start", (e) => {
			if (e.parentToolCallId) return;
			st.running++;
			st.doing = `running ${describe(e.toolName, e.args)}`;
		});
		pi.on("tool_execution_end", (e) => {
			if (!e.parentToolCallId) st.running = Math.max(0, st.running - 1);
		});
		pi.on("tool_call", () => {
			if (!st.pending) return undefined;
			st.skipped++;
			return { block: true, reason: SKIPPED };
		});
		pi.on("turn_end", () => {
			if (st.pending && st.waiter) st.waiter();
		});
		pi.on("agent_settled", () => {
			st.running = 0;
			if (st.pending && st.waiter) st.waiter(); // the run ended by itself meanwhile
		});
	};
}

/** Enter on an empty line while the agent works: send the waiting message(s) now. Returns false when there is nothing to do. */
async function steerNow(mode) {
	const st = steerState;
	const session = mode.session;
	if (st.pending || !session.isStreaming || session.isCompacting) return false;
	if (!session.getSteeringMessages().length) return false;
	const { steering, followUp } = mode.clearAllQueues();
	for (const t of followUp) await session.followUp(t); // "after it finishes" messages stay where they were
	const p = { text: steering.join("\n\n"), doing: st.doing, waitedFor: st.running ? st.doing.replace(/^running /, "") : "" };
	st.pending = p;
	st.skipped = 0;
	mode.updatePendingMessagesDisplay();
	mode.ui.requestRender();
	if (st.running) await new Promise((done) => (st.waiter = done)); // a tool is running: let it finish
	st.waiter = null;
	if (st.pending !== p) return true; // cancelled with Esc
	st.redirecting = true;
	try {
		await session.abort();
		// a reply stopped half-way is left out of what the model sees; tell it the gist, so "no, not that" makes sense
		const last = session.messages?.at(-1);
		if (last?.role === "assistant" && last.stopReason === "aborted") {
			const text = (last.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ").replace(/\s+/g, " ").trim();
			if (text) p.partial = text.length > 600 ? `…${text.slice(-600)}` : text;
		}
		await session.sendCustomMessage({ customType: "ferry-steer", content: steerNote(p, st.skipped), display: false },
			{ deliverAs: "nextTurn" });
		st.pending = null;
		mode.updatePendingMessagesDisplay();
		await mode.ferrySubmit(p.text);
	} finally {
		st.pending = null;
		st.redirecting = false;
		mode.updatePendingMessagesDisplay();
		mode.ui.requestRender();
	}
	return true;
}

/** Patch pi's input box: Enter on an empty line interrupts, and the waiting list says so. */
export async function installSteerKeys() {
	const index = import.meta.resolve("@earendil-works/pi-coding-agent");
	try {
		const { InteractiveMode } = await import(new URL("./modes/interactive/interactive-mode.js", index).href);
		const { theme } = await import(new URL("./modes/interactive/theme/theme.js", index).href);
		const { Spacer, TruncatedText } = await import("@earendil-works/pi-tui");
		const P = InteractiveMode.prototype;
		if (P.ferrySteer) return true;
		P.ferrySteer = true;

		const setup = P.setupEditorSubmitHandler;
		P.setupEditorSubmitHandler = function setupEditorSubmitHandler(...a) {
			const r = setup.apply(this, a);
			const submit = this.defaultEditor.onSubmit;
			this.ferrySubmit = (text) => submit(text);
			this.defaultEditor.onSubmit = async (text) => {
				if (!String(text ?? "").trim() && this.session.isStreaming) {
					await steerNow(this).catch((e) => this.showError?.(`Could not interrupt: ${e.message}`));
					return;
				}
				return submit(text);
			};
			return r;
		};

		const show = P.updatePendingMessagesDisplay;
		P.updatePendingMessagesDisplay = function updatePendingMessagesDisplay(...a) {
			const r = show.apply(this, a);
			const c = this.pendingMessagesContainer;
			const p = steerState.pending;
			if (p) {
				if (!c.children.length) c.addChild(new Spacer(1));
				const when = steerState.running || p.waitedFor ? " (when the running tool finishes)" : "";
				c.addChild(new TruncatedText(theme.fg("warning", `Interrupting${when}: ${p.text}`), 1, 0));
			} else if (this.session.getSteeringMessages().length && this.session.isStreaming) {
				c.addChild(new TruncatedText(theme.fg("dim", "↳ Enter on an empty line to interrupt now"), 1, 0));
			}
			return r;
		};

		// Esc while an interruption waits: the message goes back into the input box, like other waiting messages
		const restore = P.restoreQueuedMessagesToEditor;
		P.restoreQueuedMessagesToEditor = function restoreQueuedMessagesToEditor(options, ...a) {
			const p = steerState.pending;
			if (p && !steerState.redirecting) {
				steerState.pending = null;
				steerState.waiter?.();
				const text = [p.text, options?.currentText ?? this.editor.getText()].filter((t) => t?.trim()).join("\n\n");
				this.editor.setText(text); // pi leaves the box alone when nothing else is waiting
				options = { ...options, currentText: text };
			}
			return restore.call(this, options, ...a);
		};
		return true;
	} catch {
		return false; // a pi laid out differently: pi's own Enter / Alt+Enter behaviour stays
	}
}
