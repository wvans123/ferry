// Answering from the phone: an approval or an ask_user question waiting in the terminal is also put in the Ferry
// server's inbox (server/ferry_server/remote.py). The work computer cannot be reached from outside, so it long-polls the
// server for the answer. After phoneApprovalSeconds the server pushes the phone (Bark) with a link to a page that shows
// the whole question. Whichever answers first wins: the terminal (the item is taken back) or the phone (the dialog
// closes). Only when the server offers it ("remote": it has Bark and a public address) and a terminal is there.
import { serverHeaders } from "./config.mjs";

const POLL_S = 25;

export function remoteOn(cfg) {
	return cfg.phoneRemote !== false && cfg.phoneNotify !== false && Boolean(cfg.server) && (cfg.features ?? []).includes("remote");
}

async function call(cfg, method, path, body, signal, ms = 15000) {
	const r = await fetch(`${cfg.server}${path}`, {
		method,
		headers: serverHeaders(cfg, body ? { "Content-Type": "application/json" } : {}),
		body: body ? JSON.stringify(body) : undefined,
		redirect: "manual", // a company gateway's confirmation page is not an answer
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms),
	});
	if (r.status === 404) return { state: "gone" };
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return r.json();
}

const pause = (ms, signal) => new Promise((done) => {
	const t = setTimeout(done, ms);
	signal.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
});

/**
 * Put a waiting item in the server's inbox. item: { kind: "approve", who, project, tool, target, danger, outside, always }
 * or { kind: "ask", who, project, questions }. Returns null when remote answers are off, else
 * { answer: Promise<answer | null>, close() }; close() when the terminal answered.
 */
export function openRemote(cfg, item, { notifyAfter = cfg.phoneApprovalSeconds ?? 60, retryMs = 3000 } = {}) {
	if (!remoteOn(cfg)) return null;
	const stop = new AbortController();
	let id = "";
	let timer = null;
	const answer = (async () => {
		try {
			id = (await call(cfg, "POST", "/v1/ferry/remote", item)).id ?? "";
		} catch {
			return null; // the terminal still asks
		}
		if (id && stop.signal.aborted) call(cfg, "DELETE", `/v1/ferry/remote/${id}`).catch(() => {});
		if (!id || stop.signal.aborted) return null;
		timer = setTimeout(() => call(cfg, "POST", `/v1/ferry/remote/${id}/notify`).catch(() => {}), notifyAfter * 1000);
		timer.unref?.();
		while (!stop.signal.aborted) {
			try {
				const r = await call(cfg, "GET", `/v1/ferry/remote/${id}?wait=${POLL_S}`, undefined, stop.signal, (POLL_S + 10) * 1000);
				if (r.state === "answered") return r.answer;
				if (r.state !== "waiting") return null; // expired, or the server restarted
			} catch {
				await pause(retryMs, stop.signal); // the network or the gateway: keep asking
			}
		}
		return null;
	})().finally(() => clearTimeout(timer));
	return {
		answer,
		close() {
			if (stop.signal.aborted) return;
			stop.abort();
			clearTimeout(timer);
			if (id) call(cfg, "DELETE", `/v1/ferry/remote/${id}`).catch(() => {}); // else the registration takes it back
		},
	};
}

/**
 * Race the terminal against the phone. local(signal) shows the dialog; the signal closes it when the phone answers.
 * Returns { value } (the terminal's answer) or { phone } (the phone's answer).
 */
export async function race(remote, local) {
	if (!remote) return { value: await local(undefined) };
	const ac = new AbortController();
	const fromPhone = remote.answer.then((a) => (a ? { phone: a } : new Promise(() => {})));
	let r;
	try {
		r = await Promise.race([local(ac.signal).then((value) => ({ value })), fromPhone]);
	} finally {
		if (r?.phone) ac.abort();
		else remote.close();
	}
	return r;
}
