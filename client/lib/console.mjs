// The phone console: the Ferry server shows this session on a page the phone opens from a Bark push or from /phone
// (server/ferry_server/remote.py). The work computer cannot be reached from outside, so it uploads a small status when
// something changes (at most every STATUS_MS, at most STATUS_BYTES: working or idle, the /goal line, the to-do list, one
// line per recent step and the start of the latest reply; no tool output, no file content) and keeps one long poll open
// for commands from the page:
//   steer           while it works: goes in at the next step, like a message typed while the agent works
//   pause / resume  the /goal, exactly as /goal pause | resume
//   task            while idle (remoteTasks, default on): a new request. One that arrives while it is busy (it started
//                   working after the page was drawn) waits and runs after the current request.
// Messages from the phone start with PHONE_MARK. Nothing is widened: a task runs in the current permission mode, and
// the approvals it needs wait in the terminal and on the phone as usual. Only with a terminal (not ferry -p) and when the
// server offers remote answers (it has Bark and a public address). /phone pushes a fresh link; /phone off revokes them.
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { PHONE_MARK, call, pause, remoteOn } from "./remote.mjs";

export const STATUS_MS = 5000;
export const STATUS_BYTES = 4096;
const POLL_S = 25;
const STEPS = 8;
const ARGS = ["command", "path", "file_path", "pattern", "url", "query", "description", "agent"];
const TODO = { x: "completed", ">": "in_progress" };

const line = (s, n) => {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** One line for a tool call: the tool and its main argument (exported for tests). */
export function stepLine(tool, args) {
	const a = ARGS.map((k) => args?.[k]).find((v) => typeof v === "string" && v.trim());
	return line(a ? `${tool} (${a})` : tool, 120);
}

/** The status as uploaded, cut until its JSON fits in STATUS_BYTES: older steps and later to-do items first (a few of
 * each stay as long as they can), then the reply and the objective. */
export function fit(status, max = STATUS_BYTES) {
	const s = { ...status, steps: [...(status.steps ?? [])], todo: [...(status.todo ?? [])] };
	const size = () => Buffer.byteLength(JSON.stringify(s));
	const cuts = [() => s.steps.length > 3 && s.steps.shift(), () => s.todo.length > 5 && s.todo.pop(),
		() => s.steps.length && s.steps.shift(), () => s.todo.length && s.todo.pop()];
	for (const cut of cuts) while (size() > max && cut());
	if (size() > max) s.reply = line(s.reply, 100);
	if (size() > max && s.goal) s.goal = { ...s.goal, objective: line(s.goal.objective, 100) };
	return s;
}

/**
 * Carry out one command from the phone. idle: the agent is not working. Returns what happened, for the page:
 * delivered (a steer went in), started, queued (a task waits for the current request), refused (remoteTasks is off),
 * done, nogoal.
 */
export function deliver(pi, cfg, cmd, idle) {
	const text = `${PHONE_MARK} ${String(cmd.text ?? "").trim()}`;
	if (cmd.cmd === "pause" || cmd.cmd === "resume") {
		const want = cmd.cmd === "pause" ? "pursuing" : "paused";
		if (cfg.goalNow?.()?.status !== want) return "nogoal";
		pi.sendUserMessage(`/goal ${cmd.cmd}`, { expandPromptTemplates: true });
		return "done";
	}
	if (cmd.cmd === "steer" && !idle) {
		pi.sendUserMessage(text, { deliverAs: "steer" });
		return "delivered";
	}
	if (cmd.cmd !== "steer" && cmd.cmd !== "task") return "refused";
	if (cfg.remoteTasks === false) return "refused";
	if (!idle) {
		pi.sendUserMessage(text, { deliverAs: "followUp" });
		return "queued";
	}
	pi.sendUserMessage(text);
	return "started";
}

const NOTE = {
	delivered: "goes in at the next step", started: "a new request", queued: "runs after the current request",
	refused: "not run: remoteTasks is off", done: "done", nogoal: "nothing to do: no such goal",
};

export function createConsole(cfg, { todoText = () => "", statusMs = STATUS_MS, retryMs = 3000 } = {}) {
	const id = randomBytes(8).toString("hex"); // one per ferry process: /new and /resume load the extension again, links stay
	return (pi) => {
		let ctx = null;
		let stop = null; // the poll's AbortController while the console runs
		let working = false;
		let steps = [];
		let reply = "";
		let last = null;
		let sent = "";
		let sentAt = 0;
		let timer = null;

		const status = () => fit({
			state: working ? "working" : "idle", project: basename(ctx?.cwd ?? process.cwd()),
			model: ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : "", tasks: cfg.remoteTasks !== false,
			goal: cfg.goalNow?.() ?? null,
			todo: todoText().split("\n").map((l) => /^\[(.)\] (.+)$/.exec(l)).filter(Boolean)
				.map((m) => ({ status: TODO[m[1]] ?? "pending", text: line(m[2], 200) })),
			steps, reply, last,
		});
		const upload = async (force = false) => {
			let body;
			try {
				body = status();
			} catch {
				return false; // a ctx gone stale while its session is replaced
			}
			const json = JSON.stringify(body);
			if (!force && json === sent) return true;
			sent = json;
			sentAt = Date.now();
			try {
				await call(cfg, "PUT", `/v1/ferry/console/${id}`, body);
				return true;
			} catch {
				sent = ""; // sent again with the next change or poll
				return false;
			}
		};
		const changed = () => {
			if (!stop || timer) return;
			timer = setTimeout(() => {
				timer = null;
				upload();
			}, Math.max(0, sentAt + statusMs - Date.now()));
			timer.unref?.();
		};

		const poll = async (signal) => {
			let wait = retryMs;
			await upload(true);
			while (!signal.aborted) {
				try {
					const r = await call(cfg, "GET", `/v1/ferry/console/${id}/commands?wait=${POLL_S}`, undefined, signal, (POLL_S + 10) * 1000);
					if (r.state === "gone" && !(await upload(true))) throw new Error("gone"); // dropped, or the server restarted
					for (const c of r.commands ?? []) {
						const result = deliver(pi, cfg, c, !working);
						last = { cmd: c.cmd, result };
						ctx?.ui?.notify?.(`From your phone: ${c.cmd} (${NOTE[result]})`, result === "refused" || result === "nogoal" ? "warning" : "info");
					}
					wait = retryMs;
					changed(); // also picks up what no event announced, e.g. /goal typed in the terminal
				} catch {
					if (signal.aborted) break;
					await pause(wait, signal); // the network or the gateway: keep trying, less often
					wait = Math.min(wait * 2, 60000);
				}
			}
		};

		pi.on("session_start", (_e, c) => {
			ctx = c;
			if (stop || !c?.hasUI || !remoteOn(cfg)) return;
			cfg.consoleId = id; // pushes for this session carry the console link (phone.mjs, heartbeat.mjs, remote.mjs)
			stop = new AbortController();
			poll(stop.signal);
		});
		pi.on("agent_start", (_e, c) => {
			ctx = c ?? ctx;
			working = true;
			changed();
		});
		pi.on("agent_settled", () => {
			working = false;
			changed();
		});
		pi.on("tool_execution_start", (e) => {
			if (e.parentToolCallId) return;
			steps = [...steps, stepLine(e.toolName, e.args)].slice(-STEPS);
			changed();
		});
		pi.on("tool_execution_end", () => changed());
		pi.on("message_end", (e) => {
			if (e.message?.role !== "assistant") return;
			const text = line((e.message.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" "), 300);
			if (text) reply = text;
			changed();
		});
		pi.on("session_shutdown", async (e) => {
			if (!stop) return;
			stop.abort(); // this pi is done; after /new or /resume the next one polls with the same id
			stop = null;
			clearTimeout(timer);
			if (e?.reason && e.reason !== "quit") return;
			await call(cfg, "DELETE", `/v1/ferry/console/${id}`, undefined, undefined, 3000).catch(() => {}); // its links stop working
		});

		pi.registerCommand("phone", {
			description: "Phone console: push a link to this session's page to the phone; /phone off turns the links off",
			handler: async (args, c) => {
				if (!stop) {
					return c.ui.notify(!c.hasUI ? "The phone console needs the terminal."
						: "The phone console needs a Ferry server with Bark and its public address, and phoneRemote and phoneNotify on.", "warning");
				}
				try {
					if (String(args ?? "").trim().toLowerCase() === "off") {
						await call(cfg, "DELETE", `/v1/ferry/console/${id}/link`);
						return c.ui.notify("Phone console links are off: the pages stop working and pushes carry none. /phone makes a new one.", "info");
					}
					await upload(true);
					const r = await call(cfg, "POST", `/v1/ferry/console/${id}/link`, { push: true });
					if (!r.link) return c.ui.notify("The server gave no link (is its public address set?).", "warning");
					c.ui.notify(`${r.pushed ? "Sent to your phone" : "Could not push to the phone; open it yourself"} (works 12 hours, ` +
						`each refresh renews it): ${r.link}`, r.pushed ? "info" : "warning");
				} catch (err) {
					c.ui.notify(`Could not reach the Ferry server: ${err.message}`, "warning");
				}
			},
		});
	};
}
