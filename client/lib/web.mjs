// web_fetch and web_search.
//
// cfg.web = "client" (default): run on this computer, through the company proxy like a browser, so the company
//   gateway's rules apply. A gateway warning page ("are you sure you want to visit this site?") is reported with the
//   address to confirm in a browser; Ferry never clicks through it.
// cfg.web = "server": the Ferry server fetches (only when its admin page has web access on).
// cfg.web = "off": no web tools.
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { unzipSync } from "fflate";
import { Type } from "typebox";
import { PROTOCOL, serverHeaders } from "./config.mjs";
import { gatewayPage } from "./gateway.mjs";
import { blockedSite, electronFor, renderPage } from "./render.mjs";

export { gatewayPage };

const MAX_BYTES = 3_000_000;
const PAGE_CHARS = 40_000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Ferry";

// ---------- HTML to text (same rules as the server's web.py) ----------

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const unescape = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
	if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
	return ENT[e.toLowerCase()] ?? m;
});

export function htmlToText(html, base) {
	const title = unescape((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").trim());
	let h = html.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|noscript|svg|head|nav|footer|form|iframe|template)\b[\s\S]*?<\/\1>/gi, "");
	const pres = [];
	h = h.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, body) => {
		pres.push(unescape(body.replace(/<[^>]+>/g, "")));
		return `\u0000PRE${pres.length - 1}\u0000`;
	});
	h = h.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => {
		const t = txt.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
		if (!t || /^(javascript:|#)/i.test(href)) return t;
		let abs = href;
		try {
			abs = new URL(unescape(href), base).href;
		} catch {
			// keep it as written
		}
		return `[${t}](${abs})`;
	});
	h = h.replace(/<h([1-6])\b[^>]*>/gi, (_, n) => `\n\n${"#".repeat(Number(n))} `)
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<\/?code\b[^>]*>/gi, "`")
		.replace(/<\/?(p|div|section|article|main|br|tr|table|ul|ol|header|aside|blockquote|dl|dt|dd|figure|hr|h[1-6])\b[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, "");
	let text = unescape(h).split("\n").map((l) => l.replace(/[ \t\r\f\v]+/g, " ").trim()).join("\n");
	text = text.replace(/\u0000PRE(\d+)\u0000/g, (_, i) => `\n\`\`\`\n${pres[Number(i)].replace(/^\n|\n$/g, "")}\n\`\`\`\n`);
	return { title, text: text.replace(/\n{3,}/g, "\n\n").trim() };
}

function decode(buf, contentType) {
	let charset = /charset=([\w-]+)/i.exec(contentType ?? "")?.[1];
	if (!charset) charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 3000).toString("latin1"))?.[1];
	try {
		return new TextDecoder(charset || "utf-8").decode(buf);
	} catch {
		return new TextDecoder("utf-8").decode(buf);
	}
}

// ---------- on this computer ----------

async function get(url, signal, init = {}) {
	let current = url;
	for (let i = 0; i < 6; i++) {
		const u = new URL(current);
		if (!/^https?:$/.test(u.protocol)) throw new Error("only http and https addresses can be read");
		const res = await fetch(current, { ...init, redirect: "manual", signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(30000)]),
			headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8", ...(init.headers ?? {}) } });
		const loc = res.headers.get("location");
		if (res.status >= 300 && res.status < 400 && loc) {
			const next = new URL(loc, current).href;
			if (gatewayPage(next)) throw new GatewayError(next, url);
			current = next;
			init = { headers: init.headers };
			continue;
		}
		const chunks = [];
		let size = 0;
		for await (const c of res.body ?? []) {
			chunks.push(c);
			size += c.length;
			if (size > MAX_BYTES) break;
		}
		const buf = Buffer.concat(chunks);
		return { res, url: current, buf, text: decode(buf, res.headers.get("content-type")) };
	}
	throw new Error("too many redirects");
}

export class GatewayError extends Error {
	constructor(page, url) {
		super(`The company network gateway asks for a confirmation before ${new URL(url).hostname} can be reached. ` +
			`Ask the user to open ${page} in a browser and confirm (if the gateway allows it), then try again. ` +
			"Do not try other ways around the gateway.");
		this.page = page;
	}
}

export async function fetchPage(url, offset = 0, signal) {
	if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
	const r = await get(url, signal);
	const ctype = r.res.headers.get("content-type") ?? "";
	if (gatewayPage(r.url, r.buf.length < 30000 ? r.text : "")) throw new GatewayError(r.url, url); // such pages are small
	if (ctype && !/text|html|json|xml|javascript/i.test(ctype)) throw new Error(`${ctype} is not text: save the file with web_download, then read it (office_read for Word, Excel, PowerPoint, PDF)`);
	const isHtml = /html/i.test(ctype) || /^\s*<(!doctype html|html)/i.test(r.text.slice(0, 200));
	const { title, text } = isHtml ? htmlToText(r.text, r.url) : { title: "", text: r.text };
	const part = text.slice(offset, offset + PAGE_CHARS);
	// a page whose content is built by JavaScript reads as (almost) nothing here; web_render can show it
	const sparse = isHtml && text.replace(/\s+/g, " ").length < 300 && /<script\b/i.test(r.text);
	return { url: r.url, status: r.res.status, title, chars: text.length, text: part,
		next_offset: text.length > offset + PAGE_CHARS ? offset + PAGE_CHARS : null, sparse };
}

// ---------- downloading a file (3GPP specs and contributions, PDFs, zips) ----------

/** A file name for what was downloaded: from Content-Disposition, else from the address. */
function fileNameOf(res, url) {
	const cd = res.headers.get("content-disposition") ?? "";
	const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) ?? /filename="?([^";]+)"?/i.exec(cd);
	let name = m ? decodeURIComponent(m[1]) : decodeURIComponent(basename(new URL(url).pathname) || "download");
	name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "download";
	return name;
}

/**
 * Download url into the project folder (dest: a file or folder path inside cwd; default downloads/<name>).
 * A .zip is unpacked next to it unless unzip is false. Returns { path, bytes, type, files }.
 */
export async function downloadFile(url, { dest, unzip = true, cwd = process.cwd(), maxBytes = 300e6, signal } = {}) {
	if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
	let current = url;
	let res;
	for (let i = 0; i < 6; i++) {
		res = await fetch(current, { redirect: "manual", signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(600000)]),
			headers: { "User-Agent": UA } });
		const loc = res.headers.get("location");
		if (res.status >= 300 && res.status < 400 && loc) {
			const next = new URL(loc, current).href;
			if (gatewayPage(next)) throw new GatewayError(next, url);
			current = next;
			continue;
		}
		break;
	}
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${current}`);
	const type = res.headers.get("content-type") ?? "";
	if (/text\/html/i.test(type)) {
		const text = await res.text();
		if (gatewayPage(current, text.slice(0, 30000))) throw new GatewayError(current, url);
		throw new Error(`${current} is a web page, not a file. Read it with web_fetch (a folder listing shows the file links).`);
	}
	const size = Number(res.headers.get("content-length") || 0);
	if (size > maxBytes) throw new Error(`the file is ${Math.round(size / 1e6)} MB, more than the ${Math.round(maxBytes / 1e6)} MB limit`);
	const root = resolve(cwd);
	let target = resolve(root, dest || join("downloads", fileNameOf(res, current)));
	if (dest && (dest.endsWith("/") || dest.endsWith("\\") || !extname(target))) target = join(target, fileNameOf(res, current));
	const rel = relative(root, target);
	if (rel.startsWith("..") || resolve(rel) === rel) throw new Error("save downloads inside the project folder");
	mkdirSync(dirname(target), { recursive: true });
	const part = `${target}.part`;
	let got = 0;
	const counter = new TransformStream({
		transform(chunk, ctl) {
			got += chunk.length;
			if (got > maxBytes) ctl.error(new Error(`the file is bigger than the ${Math.round(maxBytes / 1e6)} MB limit`));
			else ctl.enqueue(chunk);
		},
	});
	try {
		await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(part));
		renameSync(part, target);
	} catch (e) {
		rmSync(part, { force: true });
		throw e;
	}
	const out = { path: relative(root, target) || target, bytes: statSync(target).size, type, files: [] };
	if (unzip !== false && /\.zip$/i.test(target)) {
		const dir = target.replace(/\.zip$/i, "");
		const entries = unzipSync(readFileSync(target));
		for (const [name, data] of Object.entries(entries)) {
			if (name.endsWith("/")) continue;
			const f = resolve(dir, name);
			if (!f.startsWith(resolve(dir) + sep)) continue; // a name that climbs out of the folder
			mkdirSync(dirname(f), { recursive: true });
			writeFileSync(f, data);
			out.files.push(relative(root, f));
		}
	}
	return out;
}

// ---------- in a hidden browser (render.mjs) ----------

const rendered = new Map(); // url -> text, so a long rendered page can be read on with offset without opening it again

/** Like fetchPage, but the page's scripts run first (Electron, hidden). */
export async function renderToText(cfg, url, offset = 0, signal) {
	let full = offset > 0 ? rendered.get(url) : undefined;
	if (!full) {
		const r = await renderPage(cfg, url, { signal });
		if (gatewayPage(r.url, r.html.length < 30000 ? r.html : "")) throw new GatewayError(r.url, url);
		const fromHtml = htmlToText(r.html, r.url);
		const inner = String(r.text ?? "").trim();
		// htmlToText keeps links and headings; innerText wins when the markup hides most of the text (e.g. shadow DOM)
		const text = fromHtml.text.length >= inner.length * 0.6 ? fromHtml.text : inner;
		full = { url: r.url, title: r.title || fromHtml.title, text, ms: r.ms };
		rendered.set(url, full);
		if (rendered.size > 20) rendered.delete(rendered.keys().next().value);
	}
	const part = full.text.slice(offset, offset + PAGE_CHARS);
	return { url: full.url, status: 200, title: full.title, chars: full.text.length, text: part, rendered: true,
		next_offset: full.text.length > offset + PAGE_CHARS ? offset + PAGE_CHARS : null };
}

function bingTarget(u) {
	try {
		const url = new URL(u);
		const v = url.searchParams.get("u");
		if (url.hostname.endsWith("bing.com") && url.pathname.startsWith("/ck/") && v?.startsWith("a1")) {
			return Buffer.from(v.slice(2), "base64url").toString("utf8");
		}
	} catch {
		// not a URL
	}
	return u;
}

export function parseBing(html) {
	const clean = (s) => unescape((s ?? "").replace(/<[^>]+>/g, "")).trim();
	const out = [];
	for (const block of html.match(/<li class="b_algo"[^>]*>[\s\S]*?<\/li>/g) ?? []) {
		const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
		if (!a) continue;
		out.push({ title: clean(a[2]), url: bingTarget(unescape(a[1])), snippet: clean(/<p[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1]) });
	}
	return out;
}

export async function searchWeb(query, count = 8, signal, base = process.env.FERRY_TEST_SEARCH_BASE) {
	const url = `${base || "https://www.bing.com"}/search?q=${encodeURIComponent(query)}&setlang=zh-Hans`;
	const r = await get(url, signal);
	if (gatewayPage(r.url, r.buf.length < 30000 ? r.text : "")) throw new GatewayError(r.url, url);
	return { results: parseBing(r.text).slice(0, count) };
}

// ---------- through the Ferry server ----------

async function viaServer(cfg, path, body, signal) {
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

// ---------- the tools ----------

const FetchParams = Type.Object({
	url: Type.String({ description: "The full address, e.g. https://github.com/owner/repo" }),
	offset: Type.Optional(Type.Number({ description: "Continue a long page from this character (next_offset of the previous call)" })),
});
const RenderParams = Type.Object({
	url: Type.String({ description: "The full address, e.g. https://example.com/dashboard" }),
	offset: Type.Optional(Type.Number({ description: "Continue a long page from this character (next_offset of the previous call)" })),
});
const DownloadParams = Type.Object({
	url: Type.String({ description: "The file's full address, e.g. https://www.3gpp.org/ftp/Specs/archive/23_series/23.501/23501-j40.zip" }),
	path: Type.Optional(Type.String({ description: "Where to save it in the project folder (a file or a folder); default downloads/<file name>" })),
	unzip: Type.Optional(Type.Boolean({ description: "Unpack a .zip next to it (default true)" })),
});
const SearchParams = Type.Object({
	query: Type.String({ description: "What to search for" }),
	count: Type.Optional(Type.Number({ description: "How many results, default 8" })),
});

/** Which way web access works for this run: "client", "server" or "" (none). */
export function webMode(cfg) {
	const want = cfg.web === undefined || cfg.web === true ? "client" : cfg.web;
	if (want === "server") return cfg.serverWeb ? "server" : "";
	return want === "client" ? "client" : "";
}

export function createWeb(cfg) {
	return (pi) => {
		const mode = webMode(cfg);
		if (!mode) return;
		const where = mode === "client" ? "Runs on this computer through its normal network (company proxy and gateway rules apply)."
			: "Runs on the Ferry server.";
		const canRender = mode === "client" && Boolean(electronFor(cfg));
		const notBlocked = (url) => {
			const hit = blockedSite(url, cfg.blockedSites);
			if (hit) throw new Error(`${hit} is on the user's blocked sites list: do not open it, by any tool. Tell the user if the task needs it.`);
		};
		const show = (r) => {
			const more = r.next_offset != null
				? `\n\n[Page continues: ${r.chars - r.next_offset} more characters. Call ${r.rendered ? "web_render" : "web_fetch"} with offset ${r.next_offset}.]` : "";
			return {
				content: [{ type: "text", text: `${r.title ? `# ${r.title}\n` : ""}${r.url}${r.rendered ? " (rendered in a hidden browser)" : ""}\n\n${r.text}${more}` }],
				details: { url: r.url, status: r.status, chars: r.chars, rendered: Boolean(r.rendered) },
			};
		};
		pi.registerTool({
			name: "web_fetch",
			label: "Web page",
			description: `Read a web page as text. ${where} Long pages come in parts: call again with offset to read on.`,
			promptSnippet: "Read a web page as text",
			parameters: FetchParams,
			annotations: { readOnlyHint: true, openWorldHint: true },
			async execute(_id, params, signal) {
				notBlocked(params.url);
				let r = mode === "client" ? await fetchPage(params.url, params.offset ?? 0, signal)
					: await viaServer(cfg, "/v1/ferry/web/fetch", { url: params.url, offset: params.offset ?? 0 }, signal);
				if (r.sparse && canRender && !params.offset) {
					// built by JavaScript: open it in the hidden browser instead; if that fails, keep what we have
					r = await renderToText(cfg, r.url, 0, signal).catch((e) => ({ ...r, text: `${r.text}\n\n[web_render failed: ${e.message}]` }));
				} else if (r.sparse && mode === "client") {
					r = { ...r, text: `${r.text}\n\n[This page is probably built by JavaScript, so it reads almost empty here. ` +
						"Tell the user; another source may have the same information.]" };
				}
				return show(r);
			},
		});
		if (canRender) {
			pi.registerTool({
				name: "web_render",
				label: "Web page (browser)",
				description: "Read a web page whose content is built by JavaScript: it is opened in a hidden browser on this " +
					"computer, its scripts run, then its text is read. Slower than web_fetch; web_fetch already switches to this " +
					"by itself when a page reads empty. Read only: nothing is clicked or typed, no logins or cookies are used. " +
					"Long pages come in parts: call again with offset.",
				promptSnippet: "Read a JavaScript-built web page through a hidden browser",
				parameters: RenderParams,
				annotations: { readOnlyHint: true, openWorldHint: true },
				async execute(_id, params, signal) {
					notBlocked(params.url);
					return show(await renderToText(cfg, params.url, params.offset ?? 0, signal));
				},
			});
		}
		if (mode === "client") {
			pi.registerTool({
				name: "web_download",
				label: "Download",
				description: "Download a file (Word, PDF, zip, spreadsheet...) from the web into the project folder, e.g. 3GPP " +
					"specifications and contributions from https://www.3gpp.org/ftp/. A .zip is unpacked next to it. Then read " +
					"the files with office_read or read. To find a file, read the folder listing with web_fetch first. " + where,
				promptSnippet: "Download a file from the web into the project folder",
				parameters: DownloadParams,
				annotations: { readOnlyHint: false, openWorldHint: true },
				async execute(_id, params, signal, _onUpdate, ctx) {
					notBlocked(params.url);
					const r = await downloadFile(params.url, { dest: params.path, unzip: params.unzip, cwd: ctx?.cwd ?? process.cwd(),
						maxBytes: Number(cfg.downloadMaxMB ?? 300) * 1e6, signal });
					const files = r.files.length ? `\nUnpacked ${r.files.length} file(s):\n${r.files.slice(0, 40).map((f) => `- ${f}`).join("\n")}` +
						(r.files.length > 40 ? `\n... and ${r.files.length - 40} more` : "") : "";
					return { content: [{ type: "text", text: `Saved ${r.path} (${(r.bytes / 1e6).toFixed(2)} MB${r.type ? `, ${r.type}` : ""}).${files}` }],
						details: r };
				},
			});
		}
		pi.registerTool({
			name: "web_search",
			label: "Web search",
			description: `Search the web (Bing); returns titles, addresses and short snippets. ${where} Read a result with web_fetch.`,
			promptSnippet: "Search the web",
			parameters: SearchParams,
			annotations: { readOnlyHint: true, openWorldHint: true },
			async execute(_id, params, signal) {
				const count = Math.max(1, Math.min(Number(params.count) || 8, 20));
				const r = mode === "client" ? await searchWeb(params.query, count, signal)
					: await viaServer(cfg, "/v1/ferry/web/search", { query: params.query, count }, signal);
				const text = r.results.length
					? r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join("\n\n")
					: `No results for "${params.query}".`;
				return { content: [{ type: "text", text }], details: { count: r.results.length } };
			},
		});
	};
}
