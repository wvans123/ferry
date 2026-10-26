// web_fetch and web_search: run on the Ferry server, because this computer usually cannot reach the internet.
// Only offered when the server has web access switched on (it says so in its model list).
import { Type } from "typebox";
import { basename } from "node:path";
import { PROTOCOL, serverHeaders } from "./config.mjs";

async function call(cfg, path, body, signal) {
	const res = await fetch(`${cfg.server}${path}`, {
		method: "POST",
		headers: serverHeaders(cfg, { "Content-Type": "application/json", "x-ferry-protocol": PROTOCOL,
			"x-ferry-project": encodeURIComponent(process.env.FERRY_PROJECT ?? basename(process.cwd())) }),
		body: JSON.stringify(body),
		redirect: "manual",
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
	});
	const json = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
	if (!res.ok) throw new Error(json?.error?.message ?? `the Ferry server answered HTTP ${res.status}`);
	if (!json) throw new Error("the Ferry server did not answer (a login page or proxy in between?)");
	return json;
}

const FetchParams = Type.Object({
	url: Type.String({ description: "The full address, e.g. https://github.com/owner/repo" }),
	offset: Type.Optional(Type.Number({ description: "Continue a long page from this character (next_offset of the previous call)" })),
});
const SearchParams = Type.Object({
	query: Type.String({ description: "What to search for" }),
	count: Type.Optional(Type.Number({ description: "How many results, default 8" })),
});

export function createWeb(cfg) {
	return (pi) => {
		if (!cfg.web) return;
		pi.registerTool({
			name: "web_fetch",
			label: "Web page",
			description: "Read a web page as text. Runs on the Ferry server (this computer has no direct internet), " +
				"so it works for public pages. Long pages come in parts: call again with offset to read on.",
			promptSnippet: "Read a web page (runs on the Ferry server)",
			parameters: FetchParams,
			annotations: { readOnlyHint: true, openWorldHint: true },
			async execute(_id, params, signal) {
				const r = await call(cfg, "/v1/ferry/web/fetch", { url: params.url, offset: params.offset ?? 0 }, signal);
				const more = r.next_offset != null
					? `\n\n[Page continues: ${r.chars - r.next_offset} more characters. Call web_fetch with offset ${r.next_offset}.]` : "";
				return {
					content: [{ type: "text", text: `${r.title ? `# ${r.title}\n` : ""}${r.url}\n\n${r.text}${more}` }],
					details: { url: r.url, status: r.status, chars: r.chars },
				};
			},
		});
		pi.registerTool({
			name: "web_search",
			label: "Web search",
			description: "Search the web; returns titles, addresses and short snippets. Runs on the Ferry server. " +
				"Read a result with web_fetch.",
			promptSnippet: "Search the web (runs on the Ferry server)",
			parameters: SearchParams,
			annotations: { readOnlyHint: true, openWorldHint: true },
			async execute(_id, params, signal) {
				const r = await call(cfg, "/v1/ferry/web/search", { query: params.query, count: params.count ?? 8 }, signal);
				const text = r.results.length
					? r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join("\n\n")
					: `No results for "${params.query}".`;
				return { content: [{ type: "text", text }], details: { count: r.results.length } };
			},
		});
	};
}
