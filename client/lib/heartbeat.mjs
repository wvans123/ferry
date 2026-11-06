// While the agent works, tell the Ferry server every few minutes that this run is alive, and once more when it ends.
// The server's watchdog (server/ferry_server/watchdog.py) tells the phone when a run goes quiet: the company gateway
// wants a confirmation, the computer sleeps or lost the network, ferry quit. Only the project folder's name goes up,
// nothing of the conversation. phoneNotify = false turns it off with the other phone notices.
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { serverHeaders } from "./config.mjs";

export const BEAT_MS = 5 * 60_000;

export function createHeartbeat(cfg, { every = Number(process.env.FERRY_TEST_HEARTBEAT_MS) || BEAT_MS, post } = {}) {
	const send = post ?? ((body, ms) => fetch(`${cfg.server}/v1/ferry/alive`, {
		method: "POST",
		headers: serverHeaders(cfg, { "Content-Type": "application/json" }),
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(ms),
	}).catch(() => {})); // behind the gateway a beat fails, and that is what the server notices
	return (pi) => {
		if (cfg.phoneNotify === false || !cfg.server) return;
		let timer = null;
		let id = "";
		const beat = () => send({ id, project: basename(process.cwd()) }, 15000);
		const end = async () => {
			if (!timer) return;
			clearInterval(timer);
			timer = null;
			await send({ id, project: basename(process.cwd()), end: true }, 3000); // awaited: ferry -p exits right after
		};
		pi.on("agent_start", (_e, ctx) => {
			id = ctx?.sessionManager?.getSessionId?.() || id || randomUUID();
			clearInterval(timer);
			timer = setInterval(beat, every);
			timer.unref?.();
			beat();
		});
		pi.on("agent_settled", end);
		pi.on("session_shutdown", end);
	};
}
