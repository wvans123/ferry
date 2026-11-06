// Side questions to the Ferry server about the current conversation, without changing it:
//   advisor tool   a stronger model reviews the work so far; the review is the tool result
//   /btw <q>       a quick question while the agent works (or after); the answer is shown, not added to the conversation
//   recap          one or two sentences on what the work is and what comes next, for the phone and the status line
// All three use POST /v1/ferry/side (server/ferry_server/side.py). The request names the server's copy of the
// conversation the way chat requests do (sync.mjs keeps it in cfg.side) and sends only the newest assistant text the
// server has not got yet, so it stays tiny.
import { Type } from "typebox";
import { serverHeaders } from "./config.mjs";

const TAIL_CHARS = 6000;
const RECAP_MS = 15000;

/** The assistant's newest text when it is newer than the server's copy (the server has not seen it yet). */
export function tailOf(ctx, since) {
	let branch = [];
	try {
		branch = ctx?.sessionManager?.getBranch?.() ?? [];
	} catch {
		return "";
	}
	for (let i = branch.length - 1; i >= 0; i--) {
		const m = branch[i]?.type === "message" ? branch[i].message : null;
		if (m?.role !== "assistant") continue;
		if (since && Number(m.timestamp) <= since) return "";
		const text = (Array.isArray(m.content) ? m.content : []).filter((b) => b?.type === "text").map((b) => b.text).join("\n").trim();
		return text.slice(-TAIL_CHARS);
	}
	return "";
}

/** Ask the server one side question. Returns the text; throws an Error with a readable reason. */
export async function askSide(cfg, ctx, kind, question = "", { signal, timeoutMs = 120000 } = {}) {
	if (!cfg.server || !cfg.token) throw new Error("Ferry is not set up");
	let ref = cfg.side?.ref() ?? null;
	for (let attempt = 0; attempt < 2; attempt++) {
		const body = JSON.stringify({ kind, question: String(question ?? "").slice(0, 2000), model: ctx?.model?.id ?? "",
			ferry: ref ? { conv: ref.conv, count: ref.count, hash: ref.hash } : null, tail: tailOf(ctx, ref?.at) });
		const res = await fetch(`${cfg.server}/v1/ferry/side`, {
			method: "POST", headers: serverHeaders(cfg, { "Content-Type": "application/json" }), body, redirect: "manual",
			signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]),
		});
		if (res.status === 409 && attempt === 0 && cfg.side) { // the server lost its copy: send it again, once
			ref = await cfg.side.resync(signal);
			continue;
		}
		const answer = res.headers.get("content-type")?.includes("json") ? await res.json().catch(() => ({})) : {};
		if (!res.ok || !answer.text) throw new Error(answer.error ?? `the Ferry server answered HTTP ${res.status}`);
		return String(answer.text).trim();
	}
	throw new Error("the server could not find this conversation");
}

export function createSide(cfg) {
	// the recap for the notification and the status line; "" when it is off, fails or takes too long
	cfg.recapText = async (ctx) => {
		if (cfg.recap === false) return "";
		try {
			return (await askSide(cfg, ctx, "recap", "", { timeoutMs: RECAP_MS })).replace(/\s+/g, " ").slice(0, 280);
		} catch {
			return "";
		}
	};
	return (pi) => {
		if ((cfg.features ?? []).includes("advisor") && cfg.advisor !== false) {
			pi.registerTool({
				name: "advisor",
				label: "Advisor",
				description: "Ask a stronger model to review this conversation so far and say what is wrong or missing and what to do " +
					"next. It sees everything in the conversation and nothing else, and it has no tools. Takes no parameters; " +
					"you may add a short question to point it at what worries you.",
				promptSnippet: "Ask a stronger model to review the work so far (before committing to an approach, and before declaring done)",
				parameters: Type.Object({
					question: Type.Optional(Type.String({ description: "What you most want a second opinion on (optional, one or two sentences)" })),
				}),
				annotations: { readOnlyHint: true, openWorldHint: false },
				async execute(_id, p, signal, _onUpdate, ctx) {
					let text;
					try {
						text = await askSide(cfg, ctx, "advise", p?.question ?? "", { signal });
					} catch (e) {
						text = `The advisor could not be reached (${e.message}). Go on without it.`;
					}
					return { content: [{ type: "text", text }], details: undefined };
				},
			});
		}
		pi.registerCommand("btw", {
			description: "Ask a side question while the agent works; the answer is not added to the conversation",
			handler: async (args, ctx) => {
				const q = String(args ?? "").trim();
				const show = (t, level = "info") => (ctx.hasUI ? ctx.ui.notify(t, level) : process.stdout.write(`${t}\n`));
				if (!q) return show("Usage: /btw <question>  (a quick side question; the answer is not added to the conversation)");
				const run = async () => {
					try {
						show(`btw: ${q}\n${await askSide(cfg, ctx, "btw", q)}`);
					} catch (e) {
						show(`/btw failed: ${e.message}`, "warning");
					} finally {
						if (ctx.hasUI) ctx.ui.setStatus("ferry-btw", undefined);
					}
				};
				if (!ctx.hasUI) return run(); // print mode: wait for the answer
				ctx.ui.setStatus("ferry-btw", "btw: asking...");
				void run(); // the agent keeps working; the answer shows up when it comes
			},
		});
	};
}
