// /memory distill: look across many past conversations for what keeps coming up (the same correction, the same kind
// of task, the same failure and its fix) and turn it into memories, AGENTS.md rules or skills; you confirm each change.
//   1. Each conversation of the last 90 days (every project, at least two messages from you) becomes a small card,
//      written by the server's summary model from a compact transcript. Cards are kept in <FERRY_HOME>/memory/digests/
//      and made again only when the conversation changed; at most 20 new ones per run, newest first.
//   2. The conversation's model reads the cards with your memories, rules and skills, once, and proposes items, each
//      with quotes from the cards as evidence.
//   3. Ferry checks the evidence itself (each quote is on that card; enough different conversations: memory 2, rule 3,
//      skill 3; project items only count this project's conversations), then asks about each item.
// Skills are written only to <FERRY_HOME>/skills/<name>/ with "source: ferry-distill" and only such skills are changed;
// pinned memories are never changed; rules go into a marked block in AGENTS.md. Each run writes
// <FERRY_HOME>/memory/distill/<date>.md with the old content of every changed file. Without a terminal (ferry -p) the
// proposals are printed and nothing changes. At startup, after 10 new conversations and 7 days, one line suggests it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_DIR, FERRY_HOME } from "./config.mjs";
import { MEMORY_ROOT, indexDescriptions, loadIndex, readMemory, runMemory, scopeDir } from "./memory.mjs";
import { askServer, checkCandidates, compactTranscript, editableMemories } from "./memreview.mjs";

const DIGESTS = join(MEMORY_ROOT, "digests");
const REPORTS = join(MEMORY_ROOT, "distill");
const STATE = join(REPORTS, "state.json");
const SESSIONS = join(AGENT_DIR, "sessions");
const SKILLS = join(FERRY_HOME, "skills");
const BUILTIN_SKILLS = fileURLToPath(new URL("../skills/", import.meta.url));
const DAY = 86400_000;
const KEEP_DAYS = 90;
const MAX_NEW_CARDS = 20;
const MIN_USER_MESSAGES = 2;
const PARALLEL = 3;
const NOTICE_SESSIONS = 10;
const NOTICE_DAYS = 7;
export const NEED = { memory: 2, rule: 3, skill: 3, habit: 2 };
const CAP = { memory: 5, rule: 3, skill: 2, habit: 5 };
const SEND_BYTES = 400 * 1024;
const RULES_CHARS = 20_000;
const DIGEST_MS = 90_000;
const DISTILL_MS = 300_000;
const MARK = "source: ferry-distill";
const BLOCK_START = "<!-- ferry-distill: start -->";
const BLOCK_END = "<!-- ferry-distill: end -->";
const BLOCK_TITLE = "## Learned from past conversations (/memory distill; edit or delete freely)";

const today = () => new Date().toLocaleDateString("sv-SE");
const dateOf = (ms) => new Date(ms).toLocaleDateString("sv-SE");
const clip = (t, n) => (String(t ?? "").length > n ? `${String(t).slice(0, n)} ...` : String(t ?? ""));
const textOf = (m) => (typeof m.content === "string" ? m.content
	: (Array.isArray(m.content) ? m.content : []).filter((b) => b?.type === "text").map((b) => b.text).join("\n"));
const list = (dir) => {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
};
const readJson = (file, fallback) => {
	try {
		return JSON.parse(readFileSync(file, "utf8")) ?? fallback;
	} catch {
		return fallback;
	}
};
const sameDir = (a, b) => Boolean(a && b) && (process.platform === "win32"
	? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** Text for comparing a quote with what was said: spacing, quote marks and case do not matter. */
const norm = (s) => String(s ?? "").normalize("NFKC").replace(/["'`“”‘’「」『』]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const found = (haystack, quote) => {
	const q = norm(quote);
	return q.length >= 2 && norm(haystack).includes(q);
};
const LABELS = new Set(["type", "outcome", "category", "friction", "read"]);
const strings = (v, out = []) => {
	if (typeof v === "string") out.push(v);
	else if (Array.isArray(v)) for (const x of v) strings(x, out);
	else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!LABELS.has(k)) strings(x, out);
	return out;
};
/** Whether a quote is on a card: inside one of its texts, not across two. */
export const onCard = (card, quote) => strings(card).some((s) => found(s, quote));

// ---------- state: when distill last ran, what was accepted, what never to suggest ----------

export const loadState = () => readJson(STATE, {});

function saveState(s) {
	mkdirSync(REPORTS, { recursive: true });
	writeFileSync(STATE, JSON.stringify(s, null, 1), "utf8");
}

/** Session files of every project, newest first. */
export function sessionFiles(dir = SESSIONS) {
	const out = [];
	for (const d of list(dir)) {
		for (const f of list(join(dir, d))) {
			if (!f.endsWith(".jsonl")) continue;
			try {
				const st = statSync(join(dir, d, f));
				out.push({ path: join(dir, d, f), size: st.size, mtime: st.mtimeMs });
			} catch {
				// gone while we looked
			}
		}
	}
	return out.sort((a, b) => b.mtime - a.mtime);
}

/** {sessions, days} when distill is worth suggesting: 10 new conversations and 7 days since the last run; else null. */
export function distillDue(now = Date.now(), files = sessionFiles()) {
	const s = loadState();
	const from = s.last ?? s.since;
	if (!from) {
		saveState({ ...s, since: now }); // the first look: count from today
		return null;
	}
	if (now - from < NOTICE_DAYS * DAY || s.noticed === dateOf(now)) return null;
	const sessions = files.filter((f) => f.mtime > from).length;
	return sessions >= NOTICE_SESSIONS ? { sessions, days: Math.floor((now - from) / DAY) } : null;
}

// ---------- step 1: one card per conversation ----------

const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 32);
const cardFile = (id) => join(DIGESTS, `${String(id).replace(/[^\w-]+/g, "_").slice(0, 80)}.json`);

/** What the agent read in a conversation: skills (SKILL.md files) and memories. */
export function readInSession(entries) {
	const out = new Set();
	for (const e of entries) {
		if (e.type !== "message" || e.message?.role !== "assistant" || !Array.isArray(e.message.content)) continue;
		for (const c of e.message.content) {
			if (c?.type !== "toolCall") continue;
			const a = c.arguments ?? {};
			if (c.name === "read" && /[\\/]SKILL\.md$/i.test(String(a.path ?? ""))) out.add(`skill:${basename(dirname(String(a.path).replace(/\\/g, "/")))}`);
			if (c.name === "memory" && a.action === "read" && a.name) out.add(`memory:${a.scope ?? "project"}/${a.name}`);
		}
	}
	return [...out];
}

/** The card as the server wrote it, keeping only quotes the user really wrote in this conversation. */
export function checkCard(card, entries) {
	const said = entries.filter((e) => e.type === "message" && e.message?.role === "user").map((e) => textOf(e.message)).join("\n");
	const c = card && typeof card === "object" ? card : {};
	return {
		...c,
		feedback: (Array.isArray(c.feedback) ? c.feedback : []).map((f) => (found(said, f?.quote) ? f : { ...f, quote: "" })),
		corrections: (Array.isArray(c.corrections) ? c.corrections : []).filter((q) => found(said, q)),
		read: readInSession(entries),
	};
}

/**
 * The cards of the last 90 days, newest first: kept ones reused while their conversation is unchanged, at most 20 new
 * ones made (each one request to the server's summary model). Returns {cards, calls, failed, waiting}.
 */
export async function gatherCards(cfg, ctx, { now = Date.now(), dir = SESSIONS, onProgress = () => {} } = {}) {
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const current = ctx.sessionManager?.getSessionFile?.();
	const cutoff = now - KEEP_DAYS * DAY;
	const kept = new Map();
	for (const f of list(DIGESTS)) {
		const c = readJson(join(DIGESTS, f), null);
		if (c?.path && c.mtime >= cutoff) kept.set(c.path, c);
	}
	const files = sessionFiles(dir).filter((f) => f.mtime >= cutoff && f.path !== current);
	const cards = [];
	const todo = [];
	for (const f of files) {
		const k = kept.get(f.path);
		if (k && k.size === f.size && (k.mtime === f.mtime || k.hash === hashFile(f.path))) {
			if (k.card) cards.push(k);
		} else todo.push(f);
	}
	let calls = 0;
	let failed = 0;
	let made = 0;
	let waiting = 0;
	const work = [];
	for (const f of todo) {
		let s;
		try {
			s = SessionManager.open(f.path);
		} catch {
			continue;
		}
		const entries = s.getBranch();
		const users = entries.filter((e) => e.type === "message" && e.message?.role === "user").length;
		const base = { id: s.getSessionId(), path: f.path, cwd: s.getCwd?.() ?? "", date: dateOf(f.mtime), size: f.size, mtime: f.mtime,
			hash: hashFile(f.path), users };
		if (users < MIN_USER_MESSAGES) {
			save(base, null);
			continue;
		}
		if (work.length >= MAX_NEW_CARDS) {
			waiting++;
			continue;
		}
		work.push({ base, entries });
	}
	function save(base, card) {
		mkdirSync(DIGESTS, { recursive: true });
		writeFileSync(cardFile(base.id), JSON.stringify({ ...base, card }), "utf8");
	}
	let next = 0;
	const worker = async () => {
		while (next < work.length) {
			const { base, entries } = work[next++];
			try {
				calls++;
				const r = await askServer(cfg, { kind: "digest", model: ctx.model?.id ?? "", today: today(), transcript: compactTranscript(entries) }, DIGEST_MS);
				const card = checkCard(r.card, entries);
				save(base, card);
				cards.push({ ...base, card });
			} catch {
				failed++;
			}
			onProgress(++made, work.length);
		}
	};
	await Promise.all(Array.from({ length: Math.min(PARALLEL, work.length) }, worker));
	cards.sort((a, b) => b.mtime - a.mtime);
	return { cards, calls, failed, waiting };
}

// ---------- step 2: one request to the conversation's model ----------

/** Your rules for every project, and the project's (the files Ferry reads; the first that exists). */
export function agentsFile(target, cwd) {
	const choices = target === "user-agents"
		? [join(FERRY_HOME, "AGENTS.md"), join(FERRY_HOME, "CLAUDE.md"), join(AGENT_DIR, "AGENTS.md")]
		: [join(cwd, "AGENTS.md"), join(cwd, "CLAUDE.md")];
	return choices.find((f) => existsSync(f)) ?? choices[0];
}

const readText = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);
const skillFile = (name) => join(SKILLS, name, "SKILL.md");
const hasMark = (text) => /^source:\s*ferry-distill\s*$/m.test(/^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ""))?.[1] ?? "");

/** Skills the model may know about: yours (those distill wrote are marked) and Ferry's. */
function skillNames() {
	const mine = list(SKILLS).filter((n) => existsSync(skillFile(n)));
	return [...mine.map((n) => (hasMark(readText(skillFile(n))) ? `${n} (ferry-distill)` : n)), ...list(BUILTIN_SKILLS).filter((n) => !mine.includes(n))];
}

function summarize(cards) {
	const count = (key) => {
		const out = {};
		for (const c of cards) for (const v of [].concat(c.card?.[key] ?? [])) if (typeof v === "string" && v) out[v] = (out[v] ?? 0) + 1;
		return out;
	};
	return { conversations: cards.length, from: cards.at(-1)?.date, to: cards[0]?.date, categories: count("category"),
		outcomes: count("outcome"), friction: count("friction"), corrections: cards.reduce((n, c) => n + (c.card?.corrections?.length ?? 0), 0) };
}

/**
 * The distill request: new cards whole, old ones whole while they fit, else summarised to counts; under 400 KB and the
 * upload size. Returns {body, sent}: sent are the cards the model sees in full, by their label.
 */
export function buildRequest(cfg, ctx, cards, state, cwd) {
	const { memories } = editableMemories(cwd);
	const since = state.last ?? 0;
	const accepted = (state.accepted ?? []).filter((a) => Date.parse(a.date) >= Date.now() - KEEP_DAYS * DAY);
	const body = {
		kind: "distill", model: ctx.model?.id ?? "", today: today(), project: basename(cwd), memories,
		indexes: { user: loadIndex(scopeDir("user", cwd)), project: loadIndex(scopeDir("project", cwd)) },
		agents: { user: clip(readText(agentsFile("user-agents", cwd)) ?? "", RULES_CHARS), project: clip(readText(agentsFile("project-agents", cwd)) ?? "", RULES_CHARS) },
		skills: skillNames(), accepted, never: (state.never ?? []).map((n) => n.text ?? n.key), cards: [],
	};
	const limit = Math.min(SEND_BYTES, Math.floor((cfg.chunkBytes ?? 512 * 1024) * 0.9));
	let room = limit - Buffer.byteLength(JSON.stringify(body));
	const labels = new Set();
	const entry = (c) => {
		let label = c.id.slice(-8); // pi's ids start with the time, so their ends tell them apart
		if (labels.has(label)) label = c.id;
		labels.add(label);
		return { session: label, date: c.date, project: basename(c.cwd || ""), new: c.mtime > since, card: c.card, of: c };
	};
	const fresh = cards.filter((c) => c.mtime > since).map(entry);
	const old = cards.filter((c) => c.mtime <= since).map(entry);
	const size = (e) => Buffer.byteLength(JSON.stringify({ ...e, of: undefined })) + 2;
	const take = [];
	for (const e of fresh) {
		if (size(e) > room) break;
		take.push(e);
		room -= size(e);
	}
	const oldBytes = old.reduce((n, e) => n + size(e), 0);
	if (oldBytes <= room) take.push(...old);
	else if (old.length) body.old_summary = summarize(old.map((e) => e.of));
	body.cards = take.map(({ of: _, ...e }) => e);
	return { body, sent: new Map(take.map((e) => [e.session, e.of])) };
}

// ---------- step 3: Ferry's own checks ----------

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const neverKey = (i) => `${i.kind}:${i.target ?? ""}:${i.name ?? ""}`;

function blockRules(text) {
	const s = text.indexOf(BLOCK_START);
	const e = text.indexOf(BLOCK_END);
	if (s < 0 || e < s) return null;
	const out = [];
	let cur = null;
	for (const line of text.slice(s + BLOCK_START.length, e).split(/\r?\n/)) {
		const h = /^### (.+)$/.exec(line);
		if (h) out.push(cur = { name: h[1].trim(), lines: [] });
		else if (cur) cur.lines.push(line);
	}
	return { s, e, rules: out.map((r) => ({ name: r.name, content: r.lines.join("\n").trim() })) };
}

/** AGENTS.md with one rule added to (or changed in) Ferry's marked block; the rest of the file stays as it is. */
export function withRule(text, name, content) {
	const b = blockRules(text);
	const rules = b?.rules ?? [];
	const clean = content.replace(/<!--[\s\S]*?-->/g, "").replace(/^#+\s*/gm, "").trim();
	const i = rules.findIndex((r) => r.name === name);
	if (i >= 0) rules[i].content = clean;
	else rules.push({ name, content: clean });
	const block = [BLOCK_START, BLOCK_TITLE, "", ...rules.map((r) => `### ${r.name}\n${r.content}\n`), BLOCK_END].join("\n");
	if (b) return text.slice(0, b.s) + block + text.slice(b.e + BLOCK_END.length);
	return `${text.trimEnd()}${text.trim() ? "\n\n" : ""}${block}\n`;
}

/**
 * The items Ferry lets through, and the dropped ones with why. Evidence counts only when its conversation was sent in
 * full and the quote is on that card; each conversation once; project items only this project's conversations.
 */
export function checkItems(items, sent, { cwd, never = [], editable = new Set() }) {
	const ok = [];
	const dropped = [];
	const count = { memory: 0, rule: 0, skill: 0, habit: 0 };
	const builtin = new Set(list(BUILTIN_SKILLS));
	const nope = new Set(never.map((n) => n.key ?? n));
	const label = (s) => {
		s = String(s ?? "").trim();
		if (sent.has(s)) return s;
		return s.length >= 8 ? [...sent].find(([, c]) => c.id === s || c.id.endsWith(s))?.[0] ?? s : s;
	};
	for (const raw of Array.isArray(items) ? items : []) {
		const item = { ...raw, content: String(raw?.content ?? "").trim() };
		const drop = (why) => dropped.push({ ...item, why });
		if (!(item.kind in NEED) || !item.content) {
			drop("not a memory, rule, skill or habit, or empty");
			continue;
		}
		if (nope.has(neverKey(item))) {
			drop("you said never to suggest this");
			continue;
		}
		const local = ["project", "project-agents"].includes(item.target);
		const evidence = (Array.isArray(item.evidence) ? item.evidence : []).map((e) => ({ ...e, session: label(e?.session) })).filter((e) => {
			const c = sent.get(e.session);
			return c && onCard(c.card, e.quote) && (!local || sameDir(c.cwd, cwd));
		});
		const sessions = new Set(evidence.map((e) => sent.get(e.session).id)).size;
		if (sessions < NEED[item.kind]) {
			drop(`evidence from ${sessions} conversation${sessions === 1 ? "" : "s"}${local ? " in this project" : ""}, needs ${NEED[item.kind]}`);
			continue;
		}
		const out = { ...item, evidence: evidence.map((e) => ({ ...e, date: sent.get(e.session).date })), sessions };
		if (item.kind === "memory") {
			const [c] = checkCandidates([{ action: item.op, scope: item.target, name: item.name, description: item.description, content: item.content }], cwd, editable);
			if (!c) {
				drop("changes a pinned, very long or unknown memory");
				continue;
			}
			Object.assign(out, { op: c.action, name: c.name });
		} else if (item.kind === "rule") {
			if (!["user-agents", "project-agents"].includes(item.target) || !item.name) {
				drop("a rule needs user-agents or project-agents and a name");
				continue;
			}
			const b = blockRules(readText(agentsFile(item.target, cwd)) ?? "");
			out.op = b?.rules.some((r) => r.name === item.name) ? "update" : "add";
		} else if (item.kind === "skill") {
			const name = String(item.target ?? "").replace(/^skill:/, "");
			if (!SKILL_NAME.test(name) || name.length > 64 || builtin.has(name)) {
				drop("a skill name must be a-z, 0-9 and dashes, and not one of Ferry's own");
				continue;
			}
			const old = readText(skillFile(name));
			if (old !== null && !hasMark(old)) {
				drop("a skill you wrote yourself is never changed");
				continue;
			}
			Object.assign(out, { name, op: old === null ? "add" : "update" });
		}
		if (count[item.kind] >= CAP[item.kind]) {
			drop(`more than ${CAP[item.kind]} ${item.kind}s`);
			continue;
		}
		count[item.kind]++;
		ok.push(out);
	}
	return { ok, dropped };
}

// ---------- applying, and the report ----------

function skillText(name, description, content) {
	const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
	const desc = String(description || body.split("\n").find((l) => l.trim()) || name).replace(/\s+/g, " ").replace(/^#+\s*/, "").slice(0, 300);
	return `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n${MARK}\n---\n${body}\n`;
}

/** Write one accepted item; returns the file and its content before (null for a new file). */
export function applyItem(item, cwd) {
	if (item.kind === "memory") {
		const dir = scopeDir(item.target, cwd);
		const file = join(dir, `${item.name}.md`);
		const now = readMemory(dir, item.name);
		if (now?.pinned) throw new Error(`memory "${item.name}" is pinned now`);
		if (item.op === "update" && !now) throw new Error(`memory "${item.name}" is no longer there`);
		const old = readText(file);
		runMemory({ action: "save", scope: item.target, name: item.name, replace: true, content: item.content,
			description: item.description || indexDescriptions(dir)[item.name] || "" }, cwd);
		return { file, old };
	}
	if (item.kind === "rule") {
		const file = agentsFile(item.target, cwd);
		const old = readText(file);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, withRule(old ?? "", item.name, item.content), "utf8");
		return { file, old };
	}
	if (item.kind === "skill") {
		const file = skillFile(item.name);
		const old = readText(file);
		if (old !== null && !hasMark(old)) throw new Error(`skill "${item.name}" is not one distill wrote`);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, skillText(item.name, item.description, item.content), "utf8");
		return { file, old };
	}
	throw new Error(`${item.kind} items are only reported`);
}

const WHERE = { user: "your memory (every project)", project: "this project's memory", "user-agents": "your AGENTS.md (every project)",
	"project-agents": "this project's AGENTS.md" };

export function describeItem(i) {
	const what = i.kind === "habit" ? "About how you work (only noted in the report)"
		: i.kind === "skill" ? `${i.op === "update" ? "Update" : "New"} skill "${i.name}" in ${SKILLS}`
			: `${i.op === "update" ? "Update" : "New"} ${i.kind} "${i.name}" in ${WHERE[i.target]}`;
	const ev = (i.evidence ?? []).map((e) => `  ${e.date} [${e.session}]: "${clip(e.quote, 200)}"`);
	return [what, "", i.content.trim(), ...(i.reason ? ["", `Why: ${i.reason}`] : []),
		...(ev.length ? ["", `Evidence (${i.sessions ?? ev.length} conversations):`, ...ev] : [])].join("\n");
}

const fence = (t) => `~~~~\n${String(t).trimEnd()}\n~~~~`;

/** Append this run to <FERRY_HOME>/memory/distill/<date>.md; returns its path. */
export function writeReport({ cards, calls, results, dropped, recurrence }) {
	const file = join(REPORTS, `${today()}.md`);
	const lines = [`# /memory distill, ${new Date().toLocaleString("sv-SE").slice(0, 16)}`, "",
		`Conversations: ${cards.length} cards (${cards.filter((c) => c.new).length} new). Model calls: ${calls}.`, ""];
	for (const [n, r] of results.entries()) {
		lines.push(`## ${n + 1}. ${r.item.kind}${r.item.target ? `, ${r.item.target}` : ""}${r.item.name ? ` "${r.item.name}"` : ""}: ${r.status}`, "",
			describeItem(r.item).split("\n").slice(2).join("\n"), "");
		if (r.change) lines.push(`File: ${r.change.file}`, "", r.change.old === null ? "It was a new file." : `Old content:\n\n${fence(r.change.old)}`, "");
	}
	if (dropped.length) {
		lines.push("## Dropped by Ferry's checks", "");
		for (const d of dropped) lines.push(`- ${d.kind ?? "?"}${d.target ? ` ${d.target}` : ""} "${d.name ?? ""}": ${d.why}. ${clip(String(d.content ?? "").replace(/\s+/g, " "), 200)}`);
		lines.push("");
	}
	if (recurrence?.length) {
		lines.push("## Earlier items: did the problem come back?", "");
		for (const r of recurrence) lines.push(`- ${r.item}: ${r.seen_again ? "seen again" : "not seen again"}${r.evidence ? `. ${r.evidence}` : ""}`);
		lines.push("");
	}
	mkdirSync(REPORTS, { recursive: true });
	const before = readText(file);
	writeFileSync(file, `${before ? `${before.trimEnd()}\n\n---\n\n` : ""}${lines.join("\n").trimEnd()}\n`, "utf8");
	return file;
}

// ---------- the command ----------

export async function distill(cfg, ctx) {
	const cwd = ctx.cwd ?? process.cwd();
	const ui = Boolean(ctx.hasUI);
	const say = (t, level = "info") => (ui ? ctx.ui.notify(t, level) : process.stdout.write(`${t}\n`));
	const status = (t) => (ui ? ctx.ui.setStatus("ferry-distill", t) : t && process.stderr.write(`${t}\n`));
	const state = loadState();
	let got;
	let r;
	let sent;
	let body;
	try {
		status("distill: looking for past conversations...");
		got = await gatherCards(cfg, ctx, { onProgress: (i, n) => status(`distill: reading conversation ${i} of ${n}...`) });
		if (got.cards.length < 2) {
			return say(`Not enough to distill: ${got.cards.length} past conversation${got.cards.length === 1 ? "" : "s"} with at least ` +
				`${MIN_USER_MESSAGES} messages from you in the last ${KEEP_DAYS} days${got.failed ? ` (${got.failed} could not be read)` : ""}.`);
		}
		({ body, sent } = buildRequest(cfg, ctx, got.cards, state, cwd));
		status(`distill: looking across ${body.cards.length} conversations...`);
		r = await askServer(cfg, body, DISTILL_MS);
	} catch (e) {
		return say(`/memory distill failed: ${e.message}`, "warning");
	} finally {
		status(undefined);
	}
	const calls = got.calls + 1;
	const { ok, dropped } = checkItems(r.items, sent, { cwd, never: state.never, editable: editableMemories(cwd).editable });
	const note = `${body.cards.length} conversations, ${got.calls} new card${got.calls === 1 ? "" : "s"}, ${calls} model call${calls === 1 ? "" : "s"}` +
		`${got.failed ? `; ${got.failed} could not be read` : ""}${got.waiting ? `; ${got.waiting} more next time` : ""}`;
	if (!ui) {
		const out = [`/memory distill (${note}):`, ""];
		out.push(ok.length ? ok.map((i, n) => `${n + 1}. ${describeItem(i)}`).join("\n\n") : "Nothing to suggest: nothing came up often enough.");
		if (dropped.length) out.push("", "Dropped by Ferry's checks:", ...dropped.map((d) => `- ${d.kind} "${d.name ?? ""}": ${d.why}`));
		for (const x of r.recurrence ?? []) out.push(`Earlier item "${x.item}": ${x.seen_again ? "seen again" : "not seen again"}`);
		out.push("", "Nothing was changed. Run /memory distill in the terminal to apply these.");
		return say(out.join("\n"));
	}
	const results = [];
	const asked = ok.filter((i) => i.kind !== "habit");
	let stop = false;
	for (const [n, item] of asked.entries()) {
		if (stop) {
			results.push({ item, status: "not asked" });
			continue;
		}
		const pick = await ctx.ui.select(`Distill (${n + 1} of ${asked.length})\n${describeItem(item)}`, ["Apply", "Skip", "Never suggest this again", "Stop"]);
		if (pick === "Apply") {
			try {
				results.push({ item, status: "applied", change: applyItem(item, cwd) });
			} catch (e) {
				results.push({ item, status: `failed: ${e.message}` });
			}
		} else if (pick === "Skip") results.push({ item, status: "skipped" });
		else if (pick === "Never suggest this again") results.push({ item, status: "never suggest again" });
		else {
			results.push({ item, status: "not asked" });
			stop = true;
		}
	}
	for (const item of ok.filter((i) => i.kind === "habit")) results.push({ item, status: "noted" });
	const applied = results.filter((x) => x.status === "applied");
	const report = writeReport({ cards: body.cards, calls, results, dropped, recurrence: r.recurrence });
	const fresh = loadState();
	saveState({
		...fresh, last: Date.now(),
		accepted: [...(fresh.accepted ?? []), ...applied.map(({ item }) => ({ date: today(), kind: item.kind, target: item.target, name: item.name,
			content: clip(item.content, 300) }))].filter((a) => Date.parse(a.date) >= Date.now() - KEEP_DAYS * DAY),
		never: [...(fresh.never ?? []), ...results.filter((x) => x.status === "never suggest again").map(({ item }) => ({ key: neverKey(item),
			text: `${neverKey(item)}: ${clip(item.content.replace(/\s+/g, " "), 120)}` }))].slice(-100),
	});
	const habits = results.filter((x) => x.status === "noted").length;
	say(`Distill: ${ok.length ? `applied ${applied.length} of ${asked.length}` : "nothing came up often enough"}` +
		`${habits ? `; ${habits} note${habits === 1 ? "" : "s"} about how you work` : ""} (${note}). Report: ${report}`);
}

export function createDistill(cfg) {
	if (cfg.memory !== false && cfg.server) cfg.memoryDistill = (ctx) => distill(cfg, ctx);
	return (pi) => {
		if (cfg.memory === false || cfg.memoryReview === false || !cfg.server) return;
		pi.on("session_start", (event, ctx) => {
			if (!ctx.hasUI || !["startup", "new"].includes(event?.reason)) return;
			setTimeout(() => {
				try {
					const due = distillDue();
					if (!due) return;
					saveState({ ...loadState(), noticed: today() });
					ctx.ui.notify(`${due.sessions} conversations since the last distill (${due.days} days). /memory distill looks for what keeps ` +
						"coming up and suggests memories, rules or skills; you confirm each.", "info");
				} catch {
					// this conversation's context is gone, or the folder is not writable
				}
			}, 1500).unref?.();
		});
	};
}
