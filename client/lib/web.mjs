// web_fetch and web_search.
//
// They run on this computer, through the company proxy like a browser, so the company gateway's rules apply. A gateway
// warning page ("are you sure you want to visit this site?") is reported with the address to confirm in a browser;
// Ferry never clicks through it. cfg.web = "off": no web tools.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { serverHeaders } from "./config.mjs";
import { gatewayPage } from "./gateway.mjs";
import { wrapExternal } from "./external.mjs";

export { gatewayPage };

const MAX_BYTES = 3_000_000;
const FILE_BYTES = 50_000_000; // a PDF or Office file web_fetch saves for office_read
const PAGE_CHARS = 40_000;
const READ_CHARS = 100_000; // the most of a page sent to the server to be read with a question (like Claude Code)
const CACHE_MS = 15 * 60_000; // a page read again within 15 minutes is not fetched again
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Ferry";

/** The entry of the user's blocked-sites list that url falls under (the site or a subdomain of it), or "". */
export function blockedSite(url, list) {
	let host = "";
	try {
		host = new URL(/^[a-z][\w+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/\.$/, "");
	} catch {
		return "";
	}
	for (let d of list ?? []) {
		d = String(d).toLowerCase().trim().replace(/^[a-z]+:\/\//, "").replace(/^\*?\./, "").replace(/[/:].*$/, "");
		if (d && (host === d || host.endsWith(`.${d}`))) return d;
	}
	return "";
}

// ---------- HTML to text ----------

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
		const limit = isTextType(res.headers.get("content-type")) ? MAX_BYTES : FILE_BYTES;
		let cut = false;
		for await (const c of res.body ?? []) {
			chunks.push(c);
			size += c.length;
			if (size > limit) {
				cut = true;
				break;
			}
		}
		const buf = Buffer.concat(chunks);
		return { res, url: current, buf, cut, text: isTextType(res.headers.get("content-type")) ? decode(buf, res.headers.get("content-type")) : "" };
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

const isTextType = (ctype) => !ctype || /text|html|json|xml|javascript/i.test(ctype);
const pages = new Map(); // address -> { at, page }

/** The whole page as text: { url, status, title, text, sparse }, or { file } for a PDF / Office file / archive. */
export async function readPage(url, signal) {
	if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
	const hit = pages.get(url);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.page;
	const r = await get(url, signal);
	const ctype = r.res.headers.get("content-type") ?? "";
	if (gatewayPage(r.url, r.buf.length < 30000 ? r.text : "")) throw new GatewayError(r.url, url); // such pages are small
	let page;
	if (!isTextType(ctype)) {
		page = { url: r.url, status: r.res.status, file: { ctype, buf: r.buf, cut: r.cut, name: fileName(r.url, r.res.headers, ctype) } };
	} else {
		const isHtml = /html/i.test(ctype) || /^\s*<(!doctype html|html)/i.test(r.text.slice(0, 200));
		const { title, text } = isHtml ? htmlToText(r.text, r.url) : { title: "", text: r.text };
		// a page whose content is built by JavaScript reads as (almost) nothing here
		const sparse = isHtml && text.replace(/\s+/g, " ").length < 300 && /<script\b/i.test(r.text);
		page = { url: r.url, status: r.res.status, title, text, sparse };
	}
	if (r.res.status < 400) {
		pages.set(url, { at: Date.now(), page });
		if (pages.size > 50) pages.delete(pages.keys().next().value);
	}
	return page;
}

/** A file name for what an address sent: Content-Disposition, else the address's last part, else by type. */
function fileName(url, headers, ctype) {
	const cd = headers.get("content-disposition") ?? "";
	let name = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1] ?? /filename="?([^";]+)"?/i.exec(cd)?.[1] ?? "";
	try {
		name = decodeURIComponent(name || new URL(url).pathname.split("/").filter(Boolean).pop() || "");
	} catch {
		// keep it as it is
	}
	name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(-120);
	const ext = { "application/pdf": ".pdf", "application/zip": ".zip", "application/msword": ".doc",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx" }[ctype.split(";")[0].trim()] ?? "";
	if (!name) name = `download${ext || ".bin"}`;
	return ext && !/\.[a-z0-9]{2,5}$/i.test(name) ? name + ext : name;
}

export async function fetchPage(url, offset = 0, signal) {
	const p = await readPage(url, signal);
	if (p.file) throw new Error(`${p.file.ctype} is not text`);
	return { url: p.url, status: p.status, title: p.title, chars: p.text.length, text: p.text.slice(offset, offset + PAGE_CHARS),
		next_offset: p.text.length > offset + PAGE_CHARS ? offset + PAGE_CHARS : null, sparse: p.sparse };
}

/** Ask the Ferry server to read the page with a question (only the answer comes back). null when it cannot. */
export async function readOnServer(cfg, page, prompt, signal) {
	if (!(cfg.features ?? []).includes("extract")) return null;
	const res = await fetch(`${cfg.server}/v1/ferry/extract`, {
		method: "POST", redirect: "manual", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000),
		headers: serverHeaders(cfg, { "Content-Type": "application/json" }),
		body: JSON.stringify({ url: page.url, title: page.title, prompt, text: page.text.slice(0, READ_CHARS) }),
	});
	const out = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
	if (!res.ok || !out?.answer) throw new Error(out?.error ?? `HTTP ${res.status}`);
	return out;
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

/**
 * Search through the Ferry server's search API (Tavily, Brave or Bocha; its key stays on the server). Only the query
 * leaves this computer; the results' pages are still read here. null when the server has no search engine set.
 */
export async function searchServer(cfg, query, count = 8, recent = "", signal, sites = {}) {
	if (!(cfg.features ?? []).includes("search")) return null;
	const ask = () => fetch(`${cfg.server}/v1/ferry/search`, {
		method: "POST", redirect: "manual", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(100000)]) : AbortSignal.timeout(100000),
		headers: serverHeaders(cfg, { "Content-Type": "application/json" }),
		body: JSON.stringify({ query, count, recent, allowed_domains: sites.allowed ?? [], blocked_domains: sites.blocked ?? [] }),
	});
	let res = await ask();
	if ([502, 503, 504].includes(res.status) && !res.headers.get("content-type")?.includes("json")) {  // a tunnel or gateway page (not the server's own JSON error) usually clears in a second: ask once more
		await new Promise((done) => setTimeout(done, Number(process.env.FERRY_SEARCH_RETRY_MS ?? 1500)));
		if (signal?.aborted) throw signal.reason;
		res = await ask();
	}
	const isJson = res.headers.get("content-type")?.includes("json");
	let out = null;
	let html = "";
	if (isJson) out = await res.json().catch(() => null);
	else html = await res.text().catch(() => "");
	if (!res.ok || !Array.isArray(out?.results)) {
		if (out?.error) throw new Error(out.error);
		if (!isJson) {
			const err = new Error(`HTTP ${res.status} from ${replySource(res, html)}, not from the search engine (the reply was not JSON)`);
			err.nonJson = true;
			throw err;
		}
		throw new Error(`HTTP ${res.status}`);
	}
	return { results: out.results, engine: out.engine };
}

/** Who sent a reply that is not the Ferry server's JSON: Cloudflare, or the page's own title. */
function replySource(res, html) {
	const ray = res.headers.get("cf-ray");
	if (ray || /cloudflare/i.test(res.headers.get("server") ?? "")) return `Cloudflare${ray ? ` (cf-ray ${ray})` : ""}`;
	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim();
	if (title) return `a page titled "${title.slice(0, 80)}"`;
	return res.headers.get("server") || "something between this computer and the server";
}

/** Domain limits written into the query (site: / -site:), for Bing's page. */
export function withSites(query, allowed = [], blocked = []) {
	if (allowed.length) return `${query} ${allowed.length > 1 ? `(${allowed.map((d) => `site:${d}`).join(" OR ")})` : `site:${allowed[0]}`}`;
	return [query, ...blocked.map((d) => `-site:${d}`)].join(" ");
}

export async function searchWeb(query, count = 8, signal, base = process.env.FERRY_TEST_SEARCH_BASE) {
	// strict SafeSearch, in the address and in the cookie Bing's own setting writes: "6G" otherwise matched adult file shares
	const url = `${base || "https://www.bing.com"}/search?q=${encodeURIComponent(query)}&setlang=zh-Hans&adlt=strict`;
	const r = await get(url, signal, { headers: { Cookie: "SRCHHPGUSR=ADLT=STRICT" } });
	if (gatewayPage(r.url, r.buf.length < 30000 ? r.text : "")) throw new GatewayError(r.url, url);
	return { results: parseBing(r.text).slice(0, count) };
}

// ---------- the tools ----------

const FetchParams = Type.Object({
	url: Type.String({ description: "The full address, e.g. https://github.com/owner/repo" }),
	prompt: Type.Optional(Type.String({ description: "What you want from the page. The page is then read for you and only " +
		"the answer comes back, much shorter than the page; use it for most reading. Leave it out when you need the " +
		"page's own text (code, a table, exact wording, a list of links to follow)." })),
	offset: Type.Optional(Type.Number({ description: "Without prompt: continue a long page from this character (next_offset of the previous call)" })),
});
const SearchParams = Type.Object({
	query: Type.String({ description: "What to search for" }),
	count: Type.Optional(Type.Number({ description: "How many results, default 8" })),
	recent: Type.Optional(Type.String({ description: "Only pages from the last day, week, month or year" })),
	allowed_domains: Type.Optional(Type.Array(Type.String(), { description: "Only results from these sites, e.g. [\"3gpp.org\"]" })),
	blocked_domains: Type.Optional(Type.Array(Type.String(), { description: "Never results from these sites" })),
});

/** Whether the web tools are on ("off" or false turns them off; "server" from before 0.26 counts as on). */
export function webOn(cfg) {
	return cfg.web !== "off" && cfg.web !== false;
}

/** Sites a shell command would reach: every http(s) address, and the page agent-browser is told to open. */
export function commandSites(command) {
	const c = String(command ?? "");
	const urls = c.match(/https?:\/\/[^\s"'<>|;&)]+/gi) ?? [];
	for (const m of c.matchAll(/\bagent-browser(?:\.exe)?\b[^|;&\n]*?\b(?:open|goto|navigate|read|new)\s+["']?([^\s"'|;&]+)/gi)) urls.push(m[1]);
	return urls;
}

/**
 * Pages only this computer should read: the company's intranet and anything on a private network. They are never
 * sent to the Ferry server: an address that is an IP on a private network, a name without a dot, a typical internal
 * suffix, or a site in localSites (ferry config set localSites wiki.corp.com,jira.corp.com).
 */
export function localSite(url, cfg = {}) {
	let host = "";
	try {
		host = new URL(/^[a-z][\w+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
	} catch {
		return true;
	}
	if (!host.includes(".") || /\.(local|lan|corp|internal|intranet|home|localdomain)$/.test(host)) return true;
	if (/^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) || /^(::1|f[cd][0-9a-f]{2}:|fe80:)/.test(host)) return true;
	return !!blockedSite(url, cfg.localSites);
}

/**
 * Ask the Ferry server to read a public page: only the address (and the question) goes up. Returns the server's
 * answer, or { fallback: reason } when this computer should read it (a file, a private address, a site the server
 * cannot reach), or null when the server does not read pages.
 */
export async function readByServer(cfg, url, prompt, offset, signal) {
	if (!(cfg.features ?? []).includes("read")) return null;
	const res = await fetch(`${cfg.server}/v1/ferry/read`, {
		method: "POST", redirect: "manual", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000),
		headers: serverHeaders(cfg, { "Content-Type": "application/json" }),
		body: JSON.stringify({ url, prompt, offset }),
	});
	const out = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
	if (res.status === 415) return { fallback: "file" };
	if (res.status === 422) return { fallback: out?.unreachable ?? "unreachable" };
	if (!res.ok || !out) return { fallback: out?.error ?? `HTTP ${res.status}` };
	return out;
}

/** A PDF, Office file or archive web_fetch got: into the project's downloads folder, for office_read. */
function saveFile(page, cwd) {
	const f = page.file;
	if (f.cut) {
		return { content: [{ type: "text", text: `${page.url} is a file (${f.ctype}) bigger than ${FILE_BYTES / 1e6} MB: download it ` +
			"with a command (curl -L --retry 3 -C - -o <file> <url>)." }], details: { url: page.url } };
	}
	const dir = join(cwd, "downloads");
	mkdirSync(dir, { recursive: true });
	let file = join(dir, f.name);
	for (let i = 2; existsSync(file) && readFileSync(file).compare(f.buf) !== 0; i++) file = join(dir, f.name.replace(/(\.[^.]*)?$/, `-${i}$1`));
	writeFileSync(file, f.buf);
	const office = /\.(pdf|docx?|xlsx?|pptx?)$/i.test(file);
	return { content: [{ type: "text", text: `${page.url} is a file (${f.ctype}, ${Math.round(f.buf.length / 1024)} KB). Saved as ${file}` +
		(office ? "; read it with office_read." : /\.zip$/i.test(file) ? "; unpack it with unzip (or Expand-Archive in PowerShell)." : ".") }],
		details: { url: page.url, path: file } };
}

export function createWeb(cfg) {
	return (pi) => {
		if (cfg.blockedSites?.length) {
			// blocked sites hold for every tool: the browser (agent-browser open), curl, anything a command reaches
			pi.on("tool_call", (event) => {
				if (event.toolName !== "bash" && event.toolName !== "job_start") return undefined;
				for (const u of commandSites(event.input?.command)) {
					const hit = blockedSite(u, cfg.blockedSites);
					if (hit) return { block: true, reason: `${hit} is on the user's blocked sites list: do not open it, by any tool. Tell the user if the task needs it.` };
				}
				return undefined;
			});
		}
		if (!webOn(cfg)) return;
		const where = "Runs on this computer through its normal network (company proxy and gateway rules apply).";
		const notBlocked = (url) => {
			const hit = blockedSite(url, cfg.blockedSites);
			if (hit) throw new Error(`${hit} is on the user's blocked sites list: do not open it, by any tool. Tell the user if the task needs it.`);
		};
		const show = (r) => {
			const more = r.next_offset != null
				? `\n\n[Page continues: ${r.chars - r.next_offset} more characters. Call web_fetch with offset ${r.next_offset}.]` : "";
			return {
				content: [{ type: "text", text: wrapExternal(r.url, `${r.title ? `# ${r.title}\n` : ""}${r.url}\n\n${r.text}${more}`) }],
				details: { url: r.url, status: r.status, chars: r.chars },
			};
		};
		pi.registerTool({
			name: "web_fetch",
			label: "Web page",
			description: "Read a web page. Public pages are read by the Ferry server; intranet and private addresses, and " +
				`pages it cannot reach, on this computer (${where.toLowerCase().replace(/\.$/, "")}). With prompt, the page is ` +
				"read for you and only the answer comes back (like Claude Code's WebFetch); without it you get the page's text, " +
				"long pages in parts (call again with offset). A PDF, Word, Excel or PowerPoint file is saved into the downloads " +
				"folder for office_read. Pages that need a login or are built by scripts: use the browser.",
			promptSnippet: "Read a web page, or ask a question about it",
			parameters: FetchParams,
			annotations: { readOnlyHint: true, openWorldHint: true },
			async execute(_id, params, signal, _onUpdate, ctx) {
				notBlocked(params.url);
				const prompt0 = String(params.prompt ?? "").trim();
				let why = "";
				if (!localSite(params.url, cfg)) { // public pages: the Ferry server reads them, only the result comes here
					try {
						const r = await readByServer(cfg, params.url, prompt0, Number(params.offset) || 0, signal);
						if (r?.answer) {
							return { content: [{ type: "text", text: wrapExternal(r.url, `${r.title ? `# ${r.title}\n` : ""}${r.url}\n\n${r.answer}`) + `\n\n[Answered from the page by ${r.model}. For exact wording, code or tables, call web_fetch without prompt.]` }],
								details: { url: r.url, chars: r.chars, answeredBy: r.model, readBy: "server" } };
						}
						if (r && typeof r.text === "string") return show({ ...r, readBy: "server" });
						if (r?.fallback && r.fallback !== "file") why = r.fallback;
					} catch (e) {
						if (signal?.aborted) throw e;
						why = String(e.message).slice(0, 200);
					}
				}
				const page = await readPage(params.url, signal);
				if (page.file) return saveFile(page, ctx?.cwd ?? process.cwd());
				if (page.sparse) {
					return show({ url: page.url, title: page.title, text: `${page.text}\n\n[This page is probably built by JavaScript, ` +
						"so it reads almost empty here. " + (cfg.browser === false ? "Another source may have the same information; otherwise tell the user.]"
							: "Open it in the browser (agent-browser, see the browser skill) to read it after its scripts ran.]") });
				}
				const prompt = String(params.prompt ?? "").trim();
				if (prompt && !params.offset) {
					let note = "";
					try {
						const out = await readOnServer(cfg, page, prompt, signal);
						if (out) {
							const more = page.text.length > READ_CHARS ? ` Only the first ${READ_CHARS} of its ${page.text.length} characters were read.` : "";
							return { content: [{ type: "text", text: wrapExternal(page.url, `${page.title ? `# ${page.title}\n` : ""}${page.url}\n\n${out.answer}`) + `\n\n[Answered from the page by ${out.model}.${more} For exact wording, code or tables, call web_fetch without prompt.]` }],
								details: { url: page.url, status: page.status, chars: page.text.length, answeredBy: out.model } };
						}
						note = "[The Ferry server cannot read pages for you, so this is the page's text; look for the answer to your question in it.]\n\n";
					} catch (e) {
						if (signal?.aborted) throw e;
						note = `[Reading the page on the Ferry server failed (${String(e.message).slice(0, 200)}); this is the page's text.]\n\n`;
					}
					const r = await fetchPage(params.url, 0, signal);
					return show({ ...r, text: note + r.text });
				}
				const r = await fetchPage(params.url, params.offset ?? 0, signal);
				return show(why && !params.offset ? { ...r, text: `[Read on this computer: the Ferry server could not (${why}).]\n\n${r.text}` } : r);
			},
		});
		pi.registerTool({
			name: "web_search",
			label: "Web search",
			description: "Search the web; returns titles, addresses and short snippets. Snippets are not enough to answer from: " +
				"read the best results with web_fetch. Search again with other words when the results miss.",
			promptSnippet: "Search the web",
			parameters: SearchParams,
			annotations: { readOnlyHint: true, openWorldHint: true },
			async execute(_id, params, signal) {
				const count = Math.max(1, Math.min(Number(params.count) || 8, 20));
				const recent = ["day", "week", "month", "year"].includes(params.recent) ? params.recent : "";
				let r = null;
				let note = "";
				const clean = (v) => (Array.isArray(v) ? v : []).map((d) => String(d).trim().replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, ""))
					.filter((d) => /^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(d)).slice(0, 20);
				const allowed = clean(params.allowed_domains);
				const blocked = allowed.length ? [] : clean(params.blocked_domains);
				try {
					r = await searchServer(cfg, params.query, count, recent, signal, { allowed, blocked });
				} catch (e) {
					if (signal?.aborted) throw e;
					note = e.nonJson ? `\n\n[Searching through the server failed: ${String(e.message).slice(0, 300)}; these results are Bing's page.]`
						: `\n\n[The server's search engine failed (${String(e.message).slice(0, 200)}); these results are Bing's page.]`;
				}
				if (r?.engine) note += `\n\n[Searched by the server with ${r.engine}.]`;
				if (!r) {
					r = await searchWeb(withSites(params.query, allowed, blocked), count, signal);
					if (recent) note += `\n\n[Bing's page cannot limit results to the last ${recent}: check the dates yourself.]`;
					if (cfg.browser !== false) note += "\n\n[These come from Bing's page as a program sees it. If they are off-topic, " +
						"search in the browser (agent-browser) instead.]";
				}
				const text = r.results.length
					? r.results.map((x, i) => `${i + 1}. ${x.title}${x.date ? ` (${String(x.date).slice(0, 10)})` : ""}\n   ${x.url}\n   ${String(x.snippet ?? "").slice(0, 600)}`).join("\n\n")
					: `No results for "${params.query}". Try other words.`;
				return { content: [{ type: "text", text: wrapExternal(`web_search: ${params.query}`, text) + note }], details: { count: r.results.length, engine: r.engine ?? "bing" } };
			},
		});
	};
}
