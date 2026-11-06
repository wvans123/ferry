// Sending a conversation's new messages to the Ferry server in small requests, and what to do when one is stopped.
//
// A company web gateway may stop request bodies above some size (64-88 KB in issue #26), answering HTTP 403 with its own
// page. So no body Ferry sends is bigger than the current part size (chunkBytes): a commit that is bigger goes up in
// parts first, then a tiny commit names them. When a request is stopped, Ferry halves the part size for the rest of the
// session and sends it again (the server keeps parts by number, so a smaller part simply takes the place of a bigger one).
import { randomUUID } from "node:crypto";

export const MIN_CHUNK = 8 * 1024;
export const MAX_TRIES = 3; // retries after the first attempt

/** Statuses of answers that did not come from the Ferry server (no JSON) and are worth sending again. */
const RETRY_STATUS = new Set([403, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);

const isJson = (res) => !!res.headers?.get?.("content-type")?.includes("json");

/** An answer from something in the way (gateway page, Cloudflare error page), not from the Ferry server. */
export const recoverableAnswer = (res) => !isJson(res) && RETRY_STATUS.has(res.status);

/** A network error that may go away: the connection dropped or timed out. Not our own abort. */
export function recoverableError(e, signal) {
	if (signal?.aborted || e?.name === "AbortError") return false;
	const text = `${e?.message ?? ""} ${e?.cause?.code ?? ""} ${e?.cause?.message ?? ""}`;
	return /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR|socket hang up|terminated|network/i.test(text);
}

/** Pictures in an upload: how many and how many base64 bytes (for blocked.log). */
export function imageStats(blob) {
	let count = 0;
	let bytes = 0;
	const walk = (v) => {
		if (!v || typeof v !== "object") return;
		if (Array.isArray(v)) return v.forEach(walk);
		if (v.type === "image") {
			const data = typeof v.data === "string" ? v.data : typeof v.source?.data === "string" ? v.source.data : "";
			count++;
			bytes += data.length;
		} else if (v.type === "image_url" && typeof (v.image_url?.url ?? v.image_url) === "string") {
			count++;
			bytes += String(v.image_url?.url ?? v.image_url).length;
		}
		Object.values(v).forEach(walk);
	};
	try {
		for (const m of JSON.parse(blob).append ?? []) walk(typeof m === "string" ? JSON.parse(m) : m);
	} catch {
		// not a blob we know: no numbers
	}
	return { count, bytes };
}

/** Half the part size, never below 8 KB (and never above what was just sent). */
export const shrunk = (chunk, sent = chunk) => Math.max(MIN_CHUNK, Math.floor(Math.min(chunk, sent) / 2 / 1024) * 1024);

/**
 * The commit sender. state.chunk is the part size now (it only shrinks). deps:
 *   post(path, body, signal)            -> Response (may throw)
 *   log(path, sent, res, text, extra)   -> blocked.log
 *   sleep(ms), say(text)                -> backoff, a note to the user (said once)
 *   gatewayConfirm(res, text)           -> true when the answer is the gateway's "confirm in the browser" page (no resize helps)
 */
export function createUploader(state, deps) {
	const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	let said = false;

	async function attempt(path, body, signal, extra) {
		let res;
		try {
			res = await deps.post(path, body, signal);
		} catch (e) {
			if (!recoverableError(e, signal)) throw e;
			deps.log?.(path, body.length, { status: 0, headers: new Headers() }, String(e?.cause?.code ?? e?.message), extra);
			return { error: e };
		}
		if (!isJson(res) && !res.ok) {
			const text = await res.clone().text().catch(() => "");
			deps.log?.(path, body.length, res, text, extra);
			return { res, text };
		}
		return { res };
	}

	/**
	 * Send `bytes` as a commit; returns the final Response. A stopped request is sent again (3 times at most, with a
	 * short wait), in smaller parts when it was a gateway's 403. The last stopped answer is returned for the caller to look
	 * at (the gateway's confirmation page, an error to show); a network error that stays throws an Error with the reason.
	 */
	async function commit(bytes, q, signal, imagesOf) {
		const before = state.chunk;
		try {
			return await send(bytes, q, signal, imagesOf);
		} finally {
			if (state.chunk < before && !said) { // once, with the size it ended at
				said = true;
				deps.say?.(`The network stopped a request (HTTP 403). Ferry now sends parts of at most ${Math.round(state.chunk / 1024)} KB for the rest of this session. "ferry doctor --upload" finds the right size.`);
			}
		}
	}

	async function send(bytes, q, signal, imagesOf = () => ({ count: 0, bytes: 0 })) {
		const total = bytes.length;
		let upload = null;
		let seq = 0;
		let offset = 0;
		let tries = 0;
		let images;
		const stats = () => (images ??= imagesOf());
		for (;;) {
			const finishing = upload && offset >= total;
			const direct = !upload && total <= state.chunk;
			let path;
			let body;
			if (direct) {
				path = `/v1/ferry/commit?${q}`;
				body = bytes;
			} else if (finishing) {
				const f = new URLSearchParams(q);
				f.set("upload", upload);
				f.set("parts", String(seq));
				path = `/v1/ferry/commit?${f}`;
				body = Buffer.alloc(0);
			} else {
				upload ??= randomUUID();
				path = `/v1/ferry/upload/${upload}/${seq}`;
				body = bytes.subarray(offset, offset + state.chunk);
			}
			const extra = { part: direct || finishing ? "commit" : `${seq + 1}`, total, chunk: state.chunk, tries,
				...(direct || !finishing ? { images: stats() } : {}) };
			const r = await attempt(path, body, signal, extra);
			if (r.res && !recoverableAnswer(r.res)) {
				if (!r.res.ok || direct || finishing) return r.res;
				offset += body.length;
				seq++;
				tries = 0;
				continue;
			}
			// stopped on the way
			const confirm = r.res && deps.gatewayConfirm?.(r.res, r.text);
			if (confirm || tries >= MAX_TRIES) {
				if (r.res) return r.res;
				throw new Error(`could not reach the Ferry server (${r.error?.cause?.code ?? r.error?.message}) after ${tries + 1} tries`);
			}
			tries++;
			if (r.res?.status === 403 && body.length > MIN_CHUNK) {
				const to = shrunk(state.chunk, body.length);
				if (to < state.chunk) {
					state.chunk = to;
				}
			}
			await sleep(500 * 2 ** (tries - 1));
		}
	}
	return { commit };
}

/**
 * The largest size that passes, found by halving the gap between the last size that passed and the first that failed,
 * down to `precision` KB. test(kb) -> true when a body of that size gets through. Returns 0 when even `low` fails.
 */
export async function findLimit(test, passed, failed, precision = 8) {
	let lo = passed;
	let hi = failed;
	while (hi - lo > precision) {
		const mid = Math.round((lo + hi) / 2);
		if (await test(mid)) lo = mid;
		else hi = mid;
	}
	return lo;
}

/** A part size a little under the largest size that passed (a size on the edge may fail now and then), in bytes. */
export const suggestChunk = (passedKb) => Math.max(8, Math.floor((passedKb * 0.8) / 4) * 4) * 1024;

// ---- subagents: one stopped request must not end the job ----

const TRANSIENT = /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|terminated|Cloudflare answered HTTP (?:5\d\d)|did not get this request|could not reach|HTTP (?:50[234]|52\d|530)/i;
const NOT_TRANSIENT = /token rejected|\b401\b|versions do not match|confirmation again/i;

/** An error text that a second try may fix (network, Cloudflare 5xx, a gateway block), not a login or version problem. */
export const transientMessage = (text) => TRANSIENT.test(String(text ?? "")) && !NOT_TRANSIENT.test(String(text ?? ""));

const lastAssistant = (session) => [...(session.messages ?? [])].reverse().find((m) => m.role === "assistant");

/**
 * Run a subagent's prompt; when it stops on a transient error, tell it to carry on (its conversation is kept, so it
 * goes on from where it was), up to `tries` times with a growing wait. Returns the error text that is left, or "".
 */
export async function promptWithRecovery(session, prompt, { tries = 2, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), aborted = () => false } = {}) {
	await session.prompt(prompt);
	for (let i = 0; i < tries; i++) {
		const last = lastAssistant(session);
		if (aborted() || last?.stopReason !== "error" || !transientMessage(last.errorMessage)) break;
		await sleep(2000 * (i + 1));
		await session.prompt("The last request to the server failed because of a network problem, not because of anything you did. " +
			"Carry on from where you stopped; do not start over.");
	}
	const last = lastAssistant(session);
	return last?.stopReason === "error" ? String(last.errorMessage ?? "model error") : "";
}
