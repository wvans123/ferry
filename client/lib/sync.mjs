// Ferry model provider for pi.
//
// pi re-sends the whole conversation on every model request. This provider uploads only the messages the
// server has not seen yet (split into parts when they exceed chunkBytes), then sends a tiny request that
// refers to the server-side copy. The server rebuilds the full request, adds its rules, redacts it and
// calls the model. If the server has lost its copy, the client re-uploads everything automatically.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { anthropicMessagesApi, createAssistantMessageEventStream, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { PROTOCOL, serverHeaders } from "./config.mjs";
import { gatewayPage, openInBrowser, whoAnswered } from "./gateway.mjs";

let lastOpened = 0;

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const SALT = randomUUID();
const SUMMARY_TEXT = "You are a context summarization assistant"; // pi's summary prompt

/**
 * Anthropic requests carry prompt-cache markers on the last message, which move every turn. Take them out (and
 * write a one-block text message as a plain string, as pi does for older messages) so the synced conversation
 * stays the same from turn to turn; the server puts the markers back. Returns [[message, block, cache_control]].
 */
export function takeCacheMarks(list) {
	const marks = [];
	list.forEach((m, i) => {
		if (!Array.isArray(m.content) || m.role === "__system__") return;
		m.content.forEach((b, j) => {
			if (b && typeof b === "object" && b.cache_control) {
				marks.push([i, j, b.cache_control]);
				delete b.cache_control;
			}
		});
		const only = m.content.length === 1 ? m.content[0] : null;
		if (only?.type === "text" && Object.keys(only).length === 2) m.content = only.text;
	});
	return marks;
} // pi's summary prompt // per process, so two sessions with the same opening never share a server copy

export class FerryError extends Error {}

let catalog = null;
/** pi's own entry for a model it knows (Claude, GPT): whether it thinks, and how to ask it to. */
export function knownModel(name) {
	if (!catalog) {
		catalog = new Map();
		for (const file of ["anthropic", "openai"]) {
			try {
				const url = new URL(`./providers/data/${file}.json`, import.meta.resolve("@earendil-works/pi-ai"));
				for (const group of Object.values(JSON.parse(readFileSync(url, "utf8")))) {
					for (const m of Object.values(group)) if (m?.id && m.type === "chat") catalog.set(m.id, { ...m, provider: file });
				}
			} catch {
				// a pi-ai version laid out differently: no thinking settings, everything else works
			}
		}
	}
	return catalog.get(String(name ?? "").replace(/^.*\//, ""));
}

/** pi's model definition for one model the server offers. The user's /context setting wins over the server's size. */
export function modelDef(m, cfg) {
	const own = cfg.contextWindow && typeof cfg.contextWindow === "object" ? cfg.contextWindow[m.id] : 0;
	const known = knownModel(m.model);
	const anthropic = m.api === "anthropic";
	// thinking: on (pi's default level, medium) for the Claude and GPT models pi knows to think
	const thinks = !!known?.reasoning && (anthropic ? known.provider === "anthropic" : known.provider === "openai");
	return {
		id: m.id,
		name: `Ferry ${m.id}`,
		reasoning: thinks,
		...(thinks && known.thinkingLevelMap ? { thinkingLevelMap: known.thinkingLevelMap } : {}),
		...(thinks && anthropic && known.compat ? { compat: known.compat } : {}),
		// pictures go to models that take them (the agent reads image files with the read tool)
		input: m.vision ? ["text", "image"] : ["text"],
		// USD per million tokens, from the server's price list: pi adds up the cost (/cost, the footer)
		cost: { input: m.price?.input ?? 0, output: m.price?.output ?? 0,
			cacheRead: m.price?.cache_read ?? m.price?.input ?? 0, cacheWrite: m.price?.cache_write ?? m.price?.input ?? 0 },
		// your size (/context) only within what the server allows
		contextWindow: Number(own) > 0 ? Math.min(Number(own), m.contextWindow ?? Infinity) : (m.contextWindow ?? 128000),
		maxTokens: m.maxTokens ?? 8192,
	};
}

/** opts.purpose: "agent" (default) or "subagent"; tells the server what the requests are for. */
export function createSyncProvider(cfg, models, opts = {}) {
	const known = new Map(); // conv -> { count, hash } the server has acknowledged
	const byId = new Map(models.map((m) => [m.id, m]));
	const knownTools = new Set();
	const project = process.env.FERRY_PROJECT ?? basename(process.cwd());

	async function post(path, body, signal) {
		return fetch(`${cfg.server}${path}`, {
			method: "POST",
			headers: serverHeaders(cfg, { "Content-Type": "application/octet-stream" }),
			redirect: "manual",
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

	async function shrink(payload, signal, api = "openai") {
		if (!payload || !Array.isArray(payload.messages)) return payload;
		if (cfg.sessionStore === "none") { // the server keeps nothing between calls: always send everything
			known.clear();
			knownTools.clear();
		}
		let list = payload.messages;
		let marks = [];
		if (api === "anthropic") { // the system prompt is a separate field there: sync it as the first item
			list = structuredClone([...(payload.system !== undefined ? [{ role: "__system__", content: payload.system }] : []), ...payload.messages]);
			marks = takeCacheMarks(list);
		}
		const msgs = list.map((m) => JSON.stringify(m));
		const conv = sha(SALT + (msgs[0] ?? "") + (msgs[1] ?? ""));
		const chain = [""];
		for (const s of msgs) chain.push(sha(chain[chain.length - 1] + s));
		const toolsJson = Array.isArray(payload.tools) && payload.tools.length ? JSON.stringify(payload.tools) : null;
		const toolsHash = toolsJson ? sha(toolsJson) : null;

		const prev = known.get(conv);
		const base = prev && prev.count <= msgs.length && chain[prev.count] === prev.hash ? prev.count : 0;
		const blob = (b, withTools) => JSON.stringify({ append: msgs.slice(b), tools: withTools ? toolsJson : null });

		let res = await commit(conv, base, chain[base], blob(base, toolsHash && !knownTools.has(toolsHash)), signal);
		if (!res.headers.get("content-type")?.includes("json") && [403, 502, 503, 504].includes(res.status)) {
			await new Promise((r) => setTimeout(r, 1500)); // a gateway or tunnel hiccup: once more before giving up
			res = await commit(conv, base, chain[base], blob(base, toolsHash && !knownTools.has(toolsHash)), signal);
		}
		if (res.status === 409) res = await commit(conv, 0, "", blob(0, !!toolsHash), signal); // server lost it
		if (res.status === 401) throw new FerryError("Ferry token rejected by the server. Run: ferry login <server> <token>");
		if (res.status === 426) throw new FerryError(`Ferry client and server versions do not match: ${await res.text()}`);
		if (!res.headers.get("content-type")?.includes("json")) {
			const loc = res.headers.get("location") ?? "";
			if (gatewayPage(loc)) { // the gateway's confirmation ran out mid-session
				if (Date.now() - lastOpened > 60000) {
					lastOpened = Date.now();
					openInBrowser(loc);
				}
				throw new FerryError("The company network gateway wants a confirmation again. It is open in your browser " +
					`(${loc}): confirm there, then send your message again.`);
			}
			const text = await res.text().catch(() => "");
			const who = whoAnswered({ status: res.status, headers: res.headers, body: text });
			if (gatewayPage(loc, text) || (res.status === 403 && !/Cloudflare/.test(who))) {
				// the gateway's page has no address of its own: open the server's, the gateway shows its page there
				if (Date.now() - lastOpened > 60000) {
					lastOpened = Date.now();
					openInBrowser(`${cfg.server}/`);
				}
				throw new FerryError(`The Ferry server did not get this request: ${who} If it is the company gateway, confirm in ` +
					"the browser window just opened, then send your message again. (ferry doctor checks the path.)");
			}
			throw new FerryError(`The Ferry server did not get this request: ${who}`);
		}
		if (!res.ok) throw new FerryError(`Ferry sync failed: HTTP ${res.status} ${await res.text()}`);
		const ack = await res.json();
		if (ack.count !== msgs.length || ack.hash !== chain[msgs.length]) {
			known.delete(conv);
			throw new FerryError("Ferry server state does not match this client; it will resend on the next try");
		}
		known.set(conv, ack);
		if (toolsHash) knownTools.add(toolsHash);
		const { messages: _m, tools: _t, system: _s, ...rest } = payload;
		if (api !== "anthropic" && _s !== undefined) rest.system = _s;
		// tell the server what this request is for, so it can send context summaries to a cheaper model
		const purpose = (msgs[0] ?? "").slice(0, 300).includes(SUMMARY_TEXT) ? "summary" : (opts.purpose ?? "agent");
		return { ...rest, messages: [], ferry: { conv, count: ack.count, hash: ack.hash, tools_hash: toolsHash, purpose,
			...(marks.length ? { cache: marks } : {}) } };
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
		// the server says which API its model speaks: Claude through Anthropic's own, everything else OpenAI-style
		const api = byId.get(model.id)?.api === "anthropic" ? "anthropic" : "openai";
		const inner = api === "anthropic"
			? { ...model, api: "anthropic-messages", baseUrl: `${cfg.server}/anthropic` }
			: { ...model, api: "openai-completions", baseUrl: `${cfg.server}/v1` };
		const streamer = api === "anthropic" ? anthropicMessagesApi() : openAICompletionsApi();
		const attempt = () => streamer.streamSimple(inner, context, {
			...options,
			apiKey: cfg.token,
			headers: { ...(options?.headers ?? {}), ...(cfg.headers ?? {}), "x-ferry-project": encodeURIComponent(project), // headers must be ASCII; folder names may not be
				"x-ferry-protocol": PROTOCOL },
			onPayload: async (payload, m) => {
				const replaced = userOnPayload ? await userOnPayload(payload, m) : undefined;
				return shrink(replaced ?? payload, options?.signal, api);
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

	const register = (pi, c = cfg) => pi.registerProvider("ferry", {
		baseUrl: `${cfg.server}/v1`,
		apiKey: "$FERRY_TOKEN",
		api: "ferry-sync",
		models: models.map((m) => modelDef(m, c)),
		streamSimple: streamFerry,
	});
	const factory = (pi) => register(pi);
	factory.register = register; // again, after /context changed a size
	return factory;
}
