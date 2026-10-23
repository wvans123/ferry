// Ferry model provider for pi.
//
// pi re-sends the whole conversation on every model request. This provider uploads only the messages the
// server has not seen yet (split into parts when they exceed chunkBytes), then sends a tiny request that
// refers to the server-side copy. The server rebuilds the full request, adds its rules, redacts it and
// calls the model. If the server has lost its copy, the client re-uploads everything automatically.
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { createAssistantMessageEventStream, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { PROTOCOL } from "./config.mjs";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const SALT = randomUUID(); // per process, so two sessions with the same opening never share a server copy

export class FerryError extends Error {}

export function createSyncProvider(cfg, models) {
	const known = new Map(); // conv -> { count, hash } the server has acknowledged
	const knownTools = new Set();
	const project = process.env.FERRY_PROJECT ?? basename(process.cwd());

	async function post(path, body, signal) {
		return fetch(`${cfg.server}${path}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/octet-stream",
				"x-ferry-protocol": PROTOCOL },
			body,
			signal,
		});
	}

	async function commit(conv, base, baseHash, blob, signal) {
		const bytes = Buffer.from(blob, "utf8");
		const q = new URLSearchParams({ conv, base: String(base), base_hash: baseHash });
		if (bytes.length <= cfg.chunkBytes) return post(`/v1/ferry/commit?${q}`, bytes, signal);
		const upload = randomUUID();
		const parts = Math.ceil(bytes.length / cfg.chunkBytes);
		for (let i = 0; i < parts; i++) {
			const res = await post(`/v1/ferry/upload/${upload}/${i}`,
				bytes.subarray(i * cfg.chunkBytes, (i + 1) * cfg.chunkBytes), signal);
			if (!res.ok) throw new FerryError(`Ferry upload failed: HTTP ${res.status} ${await res.text()}`);
		}
		q.set("upload", upload);
		q.set("parts", String(parts));
		return post(`/v1/ferry/commit?${q}`, "", signal);
	}

	async function shrink(payload, signal) {
		if (!payload || !Array.isArray(payload.messages)) return payload;
		const msgs = payload.messages.map((m) => JSON.stringify(m));
		const conv = sha(SALT + (msgs[0] ?? "") + (msgs[1] ?? ""));
		const chain = [""];
		for (const s of msgs) chain.push(sha(chain[chain.length - 1] + s));
		const toolsJson = Array.isArray(payload.tools) && payload.tools.length ? JSON.stringify(payload.tools) : null;
		const toolsHash = toolsJson ? sha(toolsJson) : null;

		const prev = known.get(conv);
		const base = prev && prev.count <= msgs.length && chain[prev.count] === prev.hash ? prev.count : 0;
		const blob = (b, withTools) => JSON.stringify({ append: msgs.slice(b), tools: withTools ? toolsJson : null });

		let res = await commit(conv, base, chain[base], blob(base, toolsHash && !knownTools.has(toolsHash)), signal);
		if (res.status === 409) res = await commit(conv, 0, "", blob(0, !!toolsHash), signal); // server lost it
		if (res.status === 401) throw new FerryError("Ferry token rejected by the server. Run: ferry login <server> <token>");
		if (res.status === 426) throw new FerryError(`Ferry client and server versions do not match: ${await res.text()}`);
		if (!res.ok) throw new FerryError(`Ferry sync failed: HTTP ${res.status} ${await res.text()}`);
		const ack = await res.json();
		if (ack.count !== msgs.length || ack.hash !== chain[msgs.length]) {
			known.delete(conv);
			throw new FerryError("Ferry server state does not match this client; it will resend on the next try");
		}
		known.set(conv, ack);
		if (toolsHash) knownTools.add(toolsHash);
		const { messages: _m, tools: _t, ...rest } = payload;
		return { ...rest, messages: [], ferry: { conv, count: ack.count, hash: ack.hash, tools_hash: toolsHash } };
	}

	function errorEvent(model, message) {
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		return { type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api,
			provider: model.provider, model: model.id, usage, stopReason: "error", errorMessage: message,
			timestamp: Date.now() } };
	}

	function errorStream(model, message) {
		const stream = createAssistantMessageEventStream();
		stream.push(errorEvent(model, message));
		stream.end();
		return stream;
	}

	// The server can lose its copy between our commit and the model call (restart, cleanup). It then answers
	// 409 before any output. pi does not retry 409, so we do: forget what we think the server has and run the
	// request once more, which re-uploads the session in full.
	const SESSION_LOST = /\b409\b|session not found|tools not found/i;

	function streamFerry(model, context, options) {
		if (!cfg.server || !cfg.token) return errorStream(model, "Ferry is not set up. Run: ferry login <server> <token>");
		const userOnPayload = options?.onPayload;
		const inner = { ...model, api: "openai-completions", baseUrl: `${cfg.server}/v1` };
		const attempt = () => openAICompletionsApi().streamSimple(inner, context, {
			...options,
			apiKey: cfg.token,
			headers: { ...(options?.headers ?? {}), "x-ferry-project": project, "x-ferry-protocol": PROTOCOL },
			onPayload: async (payload, m) => {
				const replaced = userOnPayload ? await userOnPayload(payload, m) : undefined;
				return shrink(replaced ?? payload, options?.signal);
			},
		});
		const out = createAssistantMessageEventStream();
		(async () => {
			for (let i = 0; i < 2; i++) {
				const held = []; // a "start" event is held until we know the attempt produced output
				let committed = false;
				let retry = false;
				for await (const ev of attempt()) {
					if (!committed) {
						if (ev.type === "start") {
							held.push(ev);
							continue;
						}
						if (ev.type === "error" && i === 0 && SESSION_LOST.test(ev.error?.errorMessage ?? "")) {
							known.clear();
							knownTools.clear();
							retry = true;
							break;
						}
						committed = true;
						for (const h of held) out.push(h);
					}
					out.push(ev);
				}
				if (!retry) break;
			}
			out.end();
		})().catch((e) => {
			out.push(errorEvent(model, String(e?.message ?? e)));
			out.end();
		});
		return out;
	}

	return (pi) => {
		pi.registerProvider("ferry", {
			baseUrl: `${cfg.server}/v1`,
			apiKey: "$FERRY_TOKEN",
			api: "ferry-sync",
			models: models.map((m) => ({
				id: m.id,
				name: `Ferry ${m.id}`,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: m.contextWindow ?? 128000,
				maxTokens: m.maxTokens ?? 8192,
			})),
			streamSimple: streamFerry,
		});
	};
}
