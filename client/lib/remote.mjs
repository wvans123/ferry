// The phone console (the Ferry server's /m page): this ferry window reports a short status to the server, and picks
// up answers given on the phone (stop, approve, deny) in the server's reply.
//
// - Only when the server has its phone console on; otherwise one tiny request every five minutes asks whether it is.
// - The report is small: project folder name, conversation title, working / waiting / idle, the current tool and a
//   short detail, the /goal, the start of the last reply, and a waiting approval. Never files or the conversation.
// - Stop works like Esc at the computer. Approve needs `ferry config set remoteApprove true` on this computer, and
//   dangerous actions or actions outside the project folder are never approved from the phone (deny always works).
// - The connection is this computer calling the server, like every model call; nothing connects into it.
// - `ferry config set phoneConsole false` stops the reports altogether.
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { serverHeaders } from "./config.mjs";

const short = (s, n) => {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n)}…` : t;
};

function textOf(m) {
	if (!m) return "";
	return typeof m.content === "string" ? m.content : (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
}

function titleOf(sm) {
	try {
		const name = sm?.getSessionName?.();
		if (name) return name;
		for (const e of sm.getBranch()) if (e.type === "message" && e.message?.role === "user") return short(textOf(e.message), 80);
	} catch {
		// no session yet
	}
	return "";
}

function goalOf(sm) {
	let goal = null;
	try {
		for (const e of sm.getBranch()) if (e.type === "custom" && e.customType === "ferry-goal") goal = e.data ?? null;
	} catch {
		// no session yet
	}
	return goal && (goal.status === "pursuing" || goal.status === "paused") ? `${goal.status === "paused" ? "(paused) " : ""}${goal.objective}` : "";
}

/** One line about a tool call, for the phone. */
export function describeCall(tool, input = {}) {
	const v = input.command ?? input.path ?? input.url ?? input.query ?? input.pattern ?? input.description ?? input.prompt ?? "";
	return short(typeof v === "string" ? v : JSON.stringify(v), 160);
}

export function createRemote(cfg, permState, { version = "" } = {}) {
	const inst = randomBytes(6).toString("hex");
	const s = { state: "idle", since: 0, tool: "", detail: "", text: "", project: basename(process.cwd()) };
	const done = new Set(); // command ids carried out, told to the server once
	let ctx = null;
	let timer = null;
	let sending = false;
	let again = false;
	let every = 30;

	const on = () => Boolean(cfg.server) && cfg.phoneConsole !== false && !process.env.PAPERCLIP_RUN_ID;

	function payload() {
		const p = permState.pendingAsk;
		return {
			instance: inst, version, project: s.project, title: titleOf(ctx?.sessionManager), state: p ? "asking" : s.state,
			since: s.since, tool: s.tool, detail: s.detail, text: s.text, goal: goalOf(ctx?.sessionManager), mode: permState.mode,
			pending: p ? { id: p.id, tool: p.tool, detail: p.detail, danger: p.danger } : null,
			remote_approve: cfg.remoteApprove === true, done: [...done],
		};
	}

	function carryOut(cmd) {
		if (done.has(cmd.id)) return;
		done.add(cmd.id);
		const p = permState.pendingAsk;
		if (cmd.action === "stop") {
			p?.answer("deny", "The user stopped the work from their phone.");
			if (s.state !== "idle") ctx?.abort?.();
			ctx?.ui?.notify?.("Stopped from the phone", "warning");
		} else if (cmd.action === "deny" && p && p.id === cmd.approval) {
			p.answer("deny");
		} else if (cmd.action === "approve" && p && p.id === cmd.approval && cfg.remoteApprove === true && !p.danger) {
			p.answer("approve");
		}
	}

	async function report(extra = {}) {
		if (!on()) return;
		if (sending) {
			again = true;
			return;
		}
		sending = true;
		clearTimeout(timer);
		const sent = [...done];
		try {
			const res = await fetch(`${cfg.server}/v1/ferry/status`, {
				method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000),
				headers: serverHeaders(cfg, { "Content-Type": "application/json" }), body: JSON.stringify({ ...payload(), ...extra }),
			});
			const r = res.ok && res.headers.get("content-type")?.includes("json") ? await res.json() : null;
			if (res.status === 404) every = 3600; // an older server without the console
			else if (r) {
				for (const id of sent) done.delete(id); // the server has them now
				every = Math.max(2, Math.min(Number(r.every) || 30, 3600));
				for (const c of r.commands ?? []) carryOut(c);
			} else every = 60;
		} catch {
			every = 60; // offline for a moment: try again later, quietly
		} finally {
			sending = false;
		}
		if (again || done.size) {
			again = false;
			return report();
		}
		if (!extra.closing) {
			timer = setTimeout(() => report(), every * 1000);
			timer.unref?.();
		}
	}

	let soon = null;
	const changed = () => { // several events in a row: one report
		clearTimeout(soon);
		soon = setTimeout(() => report(), 250);
		soon.unref?.();
	};
	permState.onPending = changed;

	return (pi) => {
		if (!on()) return;
		const keep = (c) => { if (c) ctx = c; };
		pi.on("session_start", (_e, c) => {
			keep(c);
			s.state = "idle";
			report();
		});
		pi.on("agent_start", (_e, c) => {
			keep(c);
			s.state = "working";
			s.since = Math.floor(Date.now() / 1000);
			s.tool = s.detail = "";
			changed();
		});
		pi.on("tool_execution_start", (e, c) => {
			keep(c);
			s.tool = e.toolName;
			s.detail = describeCall(e.toolName, e.args);
			changed();
		});
		pi.on("message_end", (e, c) => {
			keep(c);
			if (e.message?.role === "assistant") {
				const t = short(textOf(e.message), 240);
				if (t) s.text = t;
			}
		});
		pi.on("agent_settled", (_e, c) => {
			keep(c);
			s.state = "idle";
			s.tool = s.detail = "";
			changed();
		});
		pi.on("session_shutdown", () => {
			clearTimeout(timer);
			report({ closing: true }).catch(() => {});
		});
	};
}
