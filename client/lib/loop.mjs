// /loop: run a prompt again and again while this window is open, like Claude Code's /loop.
//   /loop 5m check whether CI passed      every 5 minutes (s, m, h, d; at least 1 minute)
//   /loop check the deploy                 every 10 minutes
//   /loop                                  what is looping
//   /loop stop [n]                         stop one loop (or all of them)
// A tick is a message from Ferry (not the user) with the prompt: a turn of its own when the agent is idle, after the
// current run when it is working. A tick is skipped while the previous one is still waiting, so ticks never pile up.
// Loops end with the window (no file, no cron): a loop that is still useful tomorrow is started again tomorrow.
// A loop stops by itself after 24 hours, and says so.
const DEFAULT_MS = 10 * 60_000;
const MAX_AGE_MS = 24 * 3_600_000;
const UNIT = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "5m check CI" -> { everyMs, prompt }; no interval -> the default. Returns { error } when nothing is left to run.
 *  secondMs: how long a second is (a test makes it 1 ms so that "30s" passes in 30 ms). */
export function parseLoop(text, minMs = 60_000, secondMs = 1000) {
	let rest = String(text ?? "").trim();
	let everyMs = DEFAULT_MS;
	const m = rest.match(/^(\d+(?:\.\d+)?)\s*([smhd])\b\s*/i);
	if (m) {
		everyMs = Math.round(Number(m[1]) * UNIT[m[2].toLowerCase()]);
		rest = rest.slice(m[0].length).trim();
	}
	if (!rest) return { error: "Usage: /loop [every, e.g. 5m or 2h] <what to do each time>; /loop stop [n]; /loop alone lists them." };
	if (everyMs > MAX_AGE_MS) return { error: "The longest interval is 1d; a loop stops after 24 hours anyway." };
	const real = Math.max(minMs, everyMs);
	return { everyMs: Math.round(real * secondMs / 1000), prompt: rest, every: everyText(real) };
}

export const everyText = (ms) => ms % UNIT.d === 0 ? `${ms / UNIT.d}d` : ms % UNIT.h === 0 ? `${ms / UNIT.h}h`
	: ms % UNIT.m === 0 ? `${ms / UNIT.m}m` : `${Math.round(ms / 1000)}s`;

export function createLoop(cfg = {}, deps = {}) {
	const minMs = deps.minMs ?? (Number(process.env.FERRY_LOOP_MIN_MS) || 60_000); // the env var is for the self-test
	const secondMs = deps.secondMs ?? 1000;
	return (pi) => {
		const loops = new Map(); // id -> { id, everyMs, prompt, runs, skipped, started, timer, pending }
		let nextId = 1;
		let ui = null;
		let isIdle = () => true;

		const widget = () => {
			if (!ui) return;
			const lines = [...loops.values()].map((l) => `  /loop #${l.id} every ${l.every}: ${l.prompt.slice(0, 60)} (${l.runs} runs)`);
			ui.setWidget("ferry-loop", lines.length ? lines : undefined);
		};
		const describe = (l) => `#${l.id} every ${l.every}, ${l.runs} runs${l.skipped ? `, ${l.skipped} skipped` : ""}: ${l.prompt}`;

		function stop(l, why) {
			clearTimeout(l.timer);
			loops.delete(l.id);
			widget();
			if (why) ui?.notify(`Loop #${l.id} stopped: ${why}`, "info");
		}

		function tick(l) {
			if (!loops.has(l.id)) return;
			if (Date.now() - l.started > MAX_AGE_MS) return stop(l, "24 hours are up. Start it again if it is still useful.");
			if (l.pending && !isIdle()) l.skipped++; // the last tick has not been taken up yet: do not pile up
			else {
				l.runs++;
				l.pending = true;
				// a turn of its own when idle; after the current run when the agent is working (followUp, not steer)
				pi.sendMessage({ customType: "ferry-loop", display: true,
					content: `(From Ferry, not the user: /loop #${l.id}, every ${l.every}, run ${l.runs}. The user asked you to do ` +
						`this each time; do it now and report briefly.)\n${l.prompt}` }, { triggerTurn: true, deliverAs: "followUp" });
			}
			widget();
			l.timer = setTimeout(() => tick(l), l.everyMs);
		}

		pi.on("session_start", (_e, ctx) => {
			if (!ctx.hasUI) return;
			ui = ctx.ui;
			isIdle = () => ctx.isIdle?.() !== false;
		});
		pi.on("agent_settled", () => {
			for (const l of loops.values()) l.pending = false;
		});
		pi.on("session_shutdown", () => {
			for (const l of [...loops.values()]) stop(l);
		});

		pi.registerCommand("loop", {
			description: "Run a prompt every so often while this window is open: /loop 5m <what>; /loop stop [n]",
			handler: async (args, ctx) => {
				const text = String(args ?? "").trim();
				const say = (t, level = "info") => (ctx.hasUI ? ctx.ui.notify(t, level) : process.stdout.write(`${t}\n`));
				if (!ctx.hasUI) return say("/loop needs the window (not ferry -p).", "warning");
				if (!text) return say(loops.size ? `Loops:\n${[...loops.values()].map(describe).join("\n")}` : "No loops. /loop 5m <what to do each time>");
				const st = text.match(/^stop(?:\s+#?(\d+))?$/i);
				if (st) {
					const picked = st[1] ? [loops.get(Number(st[1]))].filter(Boolean) : [...loops.values()];
					if (!picked.length) return say(st[1] ? `No loop #${st[1]}.` : "No loops.", "warning");
					for (const l of picked) stop(l);
					return say(`Stopped ${picked.map((l) => `#${l.id}`).join(", ")}.`);
				}
				const p = parseLoop(text, minMs, secondMs);
				if (p.error) return say(p.error, "warning");
				const l = { id: nextId++, everyMs: p.everyMs, every: p.every, prompt: p.prompt, runs: 0, skipped: 0, started: Date.now(), pending: false, timer: null };
				loops.set(l.id, l);
				l.timer = setTimeout(() => tick(l), l.everyMs);
				widget();
				say(`Loop #${l.id}: every ${l.every}, first in ${l.every}: ${l.prompt}\n/loop stop ${l.id} ends it; it ends with the window anyway.`);
			},
		});
	};
}
