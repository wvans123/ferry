// Word editing for the office module, on the document's XML tree: replace text as tracked changes (also inside someone
// else's tracked insertion), insert or delete whole paragraphs, fill empty paragraphs and table cells (a CR cover page),
// add comments and replies, accept or reject tracked changes. Every result is checked before it is saved: a file that
// Word could not open, or a change that should be tracked but is not, is reported and the original stays as it was.
import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
	.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
	.replace(/&amp;/g, "&");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escA = (s) => esc(s).replace(/"/g, "&quot;");

// ---------- a small XML tree that writes back what it read ----------

const BAD_AMP = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
const TOKEN = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|[^<]+/y;

/** Elements are { name, attrs (raw text), kids, parent }; text, comments and declarations stay raw strings. Throws when not well-formed. */
export function parseXml(s) {
	const root = { name: "#root", attrs: "", kids: [], parent: null };
	let cur = root;
	let at = 0;
	while (at < s.length) {
		TOKEN.lastIndex = at;
		const m = TOKEN.exec(s);
		if (!m) throw new Error(`not well-formed XML at character ${at}: ${JSON.stringify(s.slice(at, at + 40))}`);
		at = TOKEN.lastIndex;
		if (m[1]) {
			if (m[1] !== cur.name) throw new Error(`</${m[1]}> closes <${cur.name}> at character ${m.index}`);
			cur = cur.parent;
		} else if (m[2]) {
			if (BAD_AMP.test(m[3])) throw new Error(`a bare & in an attribute of <${m[2]}> at character ${m.index}`);
			const n = { name: m[2], attrs: m[3], kids: [], parent: cur, empty: m[4] === "/" };
			cur.kids.push(n);
			if (!n.empty) cur = n;
		} else {
			if (m[0][0] !== "<" && BAD_AMP.test(m[0])) throw new Error(`a bare & in the text at character ${m.index}`);
			cur.kids.push(m[0]);
		}
	}
	if (cur !== root) throw new Error(`<${cur.name}> is never closed`);
	return root;
}

export function xml(n) {
	if (typeof n === "string") return n;
	const inner = n.kids.map(xml).join("");
	if (n.name === "#root") return inner;
	return !n.kids.length && n.empty ? `<${n.name}${n.attrs}/>` : `<${n.name}${n.attrs}>${inner}</${n.name}>`;
}

const isEl = (k) => typeof k !== "string";
function el(name, attrs = "", kids = []) {
	const n = { name, attrs, kids: [], parent: null, empty: !kids.length };
	for (const k of kids) {
		if (isEl(k)) k.parent = n;
		n.kids.push(k);
	}
	return n;
}
const clone = (n) => (isEl(n) ? Object.assign(el(n.name, n.attrs, n.kids.map(clone)), { empty: n.empty }) : n);
const elems = (n, name) => n.kids.filter((k) => isEl(k) && (!name || k.name === name));
const first = (n, name) => n?.kids.find((k) => isEl(k) && k.name === name);
function find(n, test, out = []) {
	for (const k of n.kids) {
		if (!isEl(k)) continue;
		if (test(k)) out.push(k);
		find(k, test, out);
	}
	return out;
}
const named = (n, ...names) => find(n, (k) => names.includes(k.name));
const ancestor = (n, test) => { for (let a = n.parent; a; a = a.parent) if (test(a)) return a; return null; };
const attached = (n) => { while (n.parent) n = n.parent; return n.name === "#root"; };
const hasEls = (n) => n.kids.some(isEl);

/** Put nodes before or after ref, or in its place. */
function place(ref, where, ...nodes) {
	const p = ref.parent;
	const i = p.kids.indexOf(ref);
	for (const n of nodes) if (isEl(n)) n.parent = p;
	p.kids.splice(where === "after" ? i + 1 : i, where === "replace" ? 1 : 0, ...nodes);
	if (where === "replace" && !nodes.includes(ref)) ref.parent = null;
}
const detach = (n) => place(n, "replace");
const unwrap = (n) => place(n, "replace", ...n.kids);
function insertAt(parent, i, ...nodes) {
	for (const n of nodes) if (isEl(n)) n.parent = parent;
	parent.kids.splice(i, 0, ...nodes);
}
const append = (parent, ...nodes) => insertAt(parent, parent.kids.length, ...nodes);
function wrap(node, wrapper) {
	place(node, "replace", wrapper);
	append(wrapper, node);
}

function getA(n, name) {
	const v = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(n.attrs)?.[1];
	return v === undefined ? undefined : unesc(v);
}
const textIn = (n) => unesc(n.kids.filter((k) => !isEl(k)).join(""));

// ---------- runs and paragraph text ----------

const INSERTED = new Set(["w:ins", "w:moveTo"]);
const DELETED = new Set(["w:del", "w:moveFrom"]);
const REVISION = new Set([...INSERTED, ...DELETED]);
const PLAIN = new Set(["w:rPr", "w:t", "w:tab", "w:lastRenderedPageBreak"]);
const MARKS = new Set([...REVISION, "w:rPrChange"]);

/** The runs of a paragraph that show (not deleted ones, not those of a text box inside it), with their text. */
function runsOf(p) {
	const out = [];
	const walk = (n) => {
		for (const k of n.kids) {
			if (!isEl(k)) continue;
			if (k.name === "w:r") out.push({ r: k, text: runText(k), plain: k.kids.every((x) => !isEl(x) || PLAIN.has(x.name)) });
			else if (!DELETED.has(k.name) && k.name !== "w:pPr" && k.name !== "w:p") walk(k);
		}
	};
	walk(p);
	return out;
}
const runText = (r) => r.kids.map((k) => (!isEl(k) ? "" : k.name === "w:t" ? textIn(k) : k.name === "w:tab" ? "\t" : "")).join("");
const paraText = (p) => runsOf(p).map((x) => x.text).join("");
const norm = (s) => s.replace(/[\s\u00a0]+/g, " ").trim();
const cellText = (c) => elems(c, "w:p").map(paraText).join("\n");
// paragraphs with text only: a rejected new paragraph before a table or at the end of a cell stays as an empty one
const allText = (root) => named(root, "w:p").map(paraText).filter(Boolean).join("\n");

function textKids(s) {
	const out = [];
	for (const part of String(s).split(/(\t|\n)/)) {
		if (part === "\t") out.push(el("w:tab"));
		else if (part === "\n") out.push(el("w:br"));
		else if (part) out.push(el("w:t", /^\s|\s$/.test(part) ? ' xml:space="preserve"' : "", [esc(part)]));
	}
	return out;
}
/** Run properties for new text: the given ones without tracked-change marks. */
function cleanRPr(rPr) {
	if (!rPr) return null;
	const c = clone(rPr);
	c.kids = c.kids.filter((k) => !isEl(k) || !MARKS.has(k.name));
	return hasEls(c) ? c : null;
}
const textRun = (rPr, s, attrs = "") => el("w:r", attrs, [...(rPr ? [clone(rPr)] : []), ...textKids(s)]);

function overlapping(p, at, len) {
	let pos = 0;
	const out = [];
	for (const x of runsOf(p)) {
		const a = pos;
		pos += x.text.length;
		if (x.text && a < at + len && pos > at) out.push({ ...x, a, b: pos });
	}
	return out;
}
/** A run boundary at offset `at` of the paragraph's text (splitting a plain run, keeping its formatting). */
function cut(p, at) {
	for (const x of overlapping(p, at, 0)) {
		if (at <= x.a || at >= x.b || !x.plain) continue;
		const rPr = first(x.r, "w:rPr");
		place(x.r, "replace", textRun(rPr, x.text.slice(0, at - x.a), x.r.attrs), textRun(rPr, x.text.slice(at - x.a), x.r.attrs));
	}
}
/** The runs holding [at, at + len), split at both ends. null when a field, picture or note is in the way (strict: anywhere; else at the ends). */
function span(p, at, len, strict) {
	const over = overlapping(p, at, len);
	if (!over.length) return null;
	if (strict ? over.some((x) => !x.plain) : (!over[0].plain && over[0].a < at) || (!over.at(-1).plain && over.at(-1).b > at + len)) return null;
	cut(p, at);
	cut(p, at + len);
	return overlapping(p, at, len).map((x) => x.r);
}

/** The one paragraph that contains text. */
function onePara(body, text) {
	const want = String(text ?? "");
	if (!want) throw new Error("an edit names no text to find");
	const hits = named(body, "w:p").filter((p) => paraText(p).includes(want));
	if (!hits.length) throw new Error(`Not found: "${want.slice(0, 80)}" (text must be inside one paragraph)`);
	if (hits.length > 1) throw new Error(`"${want.slice(0, 80)}" is in ${hits.length} paragraphs: quote more of it so it is unique`);
	return hits[0];
}

// ---------- tracked changes ----------

/** A revision element by this edit's author; its id is noted as one of ours. */
function rev(ctx, name, kids = []) {
	const id = ctx.nextId++;
	ctx.mine.add(String(id));
	return el(name, ` w:id="${id}" w:author="${escA(ctx.author)}" w:date="${ctx.date}"`, kids);
}

/** Mark a run deleted. Text someone else inserted keeps its insertion around the deletion (as Word does); text this edit inserted just goes. */
function deleteRun(ctx, r) {
	const par = r.parent;
	if (par.name === "w:ins" && ctx.mine.has(getA(par, "w:id"))) {
		detach(r);
		if (!hasEls(par)) detach(par);
		return;
	}
	for (const k of r.kids) {
		if (!isEl(k)) continue;
		if (k.name === "w:t") k.name = "w:delText";
		else if (k.name === "w:instrText") k.name = "w:delInstrText";
	}
	wrap(r, rev(ctx, "w:del"));
}

/** Move a new insertion out of the insertion it landed in, splitting that one in two: insertions never nest. */
function liftOut(ctx, node) {
	for (let c = node.parent; INSERTED.has(c.name); c = node.parent) {
		const i = c.kids.indexOf(node);
		const rest = c.kids.splice(i + 1);
		c.kids.splice(i, 1);
		place(c, "after", node);
		if (rest.some(isEl)) place(node, "after", el(c.name, c.attrs.replace(/w:id="\d+"/, `w:id="${ctx.nextId++}"`), rest));
		if (!hasEls(c)) detach(c);
	}
}

/** Mark a paragraph mark inserted or deleted (w:pPr/w:rPr/w:ins|w:del, before the other run properties). */
function markParagraph(ctx, p, kind) {
	let pPr = first(p, "w:pPr");
	if (!pPr) insertAt(p, 0, (pPr = el("w:pPr")));
	let rPr = first(pPr, "w:rPr");
	if (!rPr) {
		rPr = el("w:rPr");
		const after = pPr.kids.find((k) => isEl(k) && (k.name === "w:sectPr" || k.name === "w:pPrChange"));
		if (after) place(after, "before", rPr);
		else append(pPr, rPr);
	}
	const ins = first(rPr, "w:ins");
	if (kind === "w:del" && ins) place(ins, "after", rev(ctx, kind));
	else insertAt(rPr, 0, rev(ctx, kind));
}

/** A new paragraph formatted like `like` (its style, numbering, indents), optionally with another style. */
function newParagraph(ctx, like, text, style) {
	const pPr = first(like, "w:pPr") ? clone(first(like, "w:pPr")) : el("w:pPr");
	const drop = new Set(["w:sectPr", "w:pPrChange", ...(style ? ["w:pStyle", "w:numPr", "w:rPr"] : [])]);
	pPr.kids = pPr.kids.filter((k) => !isEl(k) || !drop.has(k.name));
	if (style) insertAt(pPr, 0, el("w:pStyle", ` w:val="${escA(style)}"`));
	const rPr = first(pPr, "w:rPr");
	if (rPr) {
		rPr.kids = rPr.kids.filter((k) => !isEl(k) || !MARKS.has(k.name));
		if (!hasEls(rPr)) detach(rPr);
	}
	const p = el("w:p", "", hasEls(pPr) ? [pPr] : []);
	if (ctx.track) markParagraph(ctx, p, "w:ins");
	if (text) {
		const run = textRun(cleanRPr(rPr), text);
		append(p, ctx.track ? rev(ctx, "w:ins", [run]) : run);
	}
	return p;
}

/** Write text into an empty paragraph; more lines become new paragraphs after it. */
function fillParagraph(ctx, p, text) {
	const [line, ...rest] = String(text).split(/\r?\n/);
	if (line) {
		const run = textRun(cleanRPr(first(first(p, "w:pPr"), "w:rPr")), line);
		append(p, ctx.track ? rev(ctx, "w:ins", [run]) : run);
	}
	let ref = p;
	for (const l of rest) {
		const np = newParagraph(ctx, p, l);
		place(ref, "after", np);
		ref = np;
	}
	return 1 + rest.length;
}

/** The next paragraph or table after p among its siblings. */
function nextBlock(p) {
	const sibs = p.parent.kids;
	for (let i = sibs.indexOf(p) + 1; i < sibs.length; i++) if (isEl(sibs[i]) && ["w:p", "w:tbl", "w:sdt"].includes(sibs[i].name)) return sibs[i];
	return null;
}

function deleteParagraph(ctx, p) {
	if (!ctx.track) {
		const holder = p.parent;
		detach(p);
		if (holder.name === "w:tc" && !first(holder, "w:p")) append(holder, el("w:p"));
		return;
	}
	for (const { r } of runsOf(p)) deleteRun(ctx, r);
	// the mark too, so accepting joins it with the next paragraph and it vanishes; the last one before a table or the end stays empty
	if (nextBlock(p)?.name === "w:p") markParagraph(ctx, p, "w:del");
}

function deleteRow(ctx, tr) {
	if (!ctx.track) return detach(tr);
	let trPr = first(tr, "w:trPr");
	if (!trPr) {
		const tblPrEx = first(tr, "w:tblPrEx");
		trPr = el("w:trPr");
		if (tblPrEx) place(tblPrEx, "after", trPr);
		else insertAt(tr, 0, trPr);
	}
	const change = first(trPr, "w:trPrChange");
	if (change) place(change, "before", rev(ctx, "w:del"));
	else append(trPr, rev(ctx, "w:del"));
	for (const p of named(tr, "w:p")) for (const { r } of runsOf(p)) deleteRun(ctx, r);
}

// ---------- the edits ----------

function replaceText(ctx, body, e) {
	const want = String(e.find);
	const paras = named(body, "w:p");
	const total = paras.reduce((n, p) => n + paraText(p).split(want).length - 1, 0);
	if (total === 0) throw new Error(`Not found: "${want.slice(0, 80)}" (text must be inside one paragraph)`);
	if (total > 1 && !e.all) throw new Error(`"${want.slice(0, 80)}" occurs ${total} times: make it longer to be unique, or set all: true`);
	const replace = String(e.replace ?? "");
	let replaced = 0;
	let skipped = 0;
	for (const p of paras) {
		let from = 0; // search after the last replacement, so a replacement that contains the text is not replaced again
		for (let guard = 0; guard < 50; guard++) {
			const at = paraText(p).indexOf(want, from);
			if (at < 0) break;
			const runs = span(p, at, want.length, true);
			if (!runs) { // a field, picture or note in the way: leave this one to Word
				skipped++;
				from = at + want.length;
				continue;
			}
			const rPr = first(runs[0], "w:rPr");
			if (ctx.track) {
				const ins = replace ? rev(ctx, "w:ins", [textRun(cleanRPr(rPr), replace)]) : null;
				if (ins) place(runs.at(-1), "after", ins);
				for (const r of runs) deleteRun(ctx, r);
				if (ins) liftOut(ctx, ins);
			} else {
				if (replace) place(runs[0], "after", textRun(rPr, replace, runs[0].attrs));
				runs.forEach(detach);
			}
			from = at + replace.length;
			replaced++;
		}
	}
	return { find: want.slice(0, 60), replaced, skipped };
}

function insertParagraphs(ctx, body, e) {
	const anchor = e.after ?? e.before;
	const p = onePara(body, anchor);
	const lines = String(e.insert).split(/\r?\n/);
	let ref = p;
	for (const line of lines) {
		const np = newParagraph(ctx, p, line, e.style);
		if (e.after !== undefined) {
			place(ref, "after", np);
			ref = np;
		} else place(p, "before", np);
	}
	return { note: `${lines.length} paragraph(s) inserted ${e.after !== undefined ? "after" : "before"} "${String(anchor).slice(0, 60)}"` };
}

function deleteParagraphs(ctx, body, e) {
	const p1 = onePara(body, e.deleteParagraph);
	let blocks = [p1];
	if (e.through !== undefined) {
		const p2 = onePara(body, e.through);
		const sibs = p1.parent.kids;
		const [i, j] = [sibs.indexOf(p1), sibs.indexOf(p2)];
		if (p2.parent !== p1.parent || j < i) throw new Error(`"${String(e.through).slice(0, 60)}" must be in a paragraph after "${String(e.deleteParagraph).slice(0, 60)}", in the same part of the document`);
		blocks = sibs.slice(i, j + 1).filter((k) => isEl(k) && (k.name === "w:p" || k.name === "w:tbl"));
	}
	let n = 0;
	for (const b of blocks) {
		if (b.name === "w:p") { deleteParagraph(ctx, b); n++; } else elems(b, "w:tr").forEach((tr) => deleteRow(ctx, tr));
	}
	const tables = blocks.length - n;
	return { note: `${n} paragraph(s)${tables ? ` and ${tables} table(s)` : ""} deleted from "${String(e.deleteParagraph).slice(0, 60)}"` };
}

const isSpacer = (c) => {
	const w = first(first(c, "w:tcPr"), "w:tcW");
	const type = w && getA(w, "w:type");
	return !norm(cellText(c)) && w && (!type || type === "dxa") && Number(getA(w, "w:w")) < 300;
};

function targetCell(body, e) {
	if (e.label !== undefined) {
		const want = norm(String(e.label));
		const cells = named(body, "w:tc");
		let hits = cells.filter((c) => norm(cellText(c)) === want);
		if (!hits.length) hits = cells.filter((c) => norm(cellText(c)).startsWith(want));
		if (!hits.length) throw new Error(`No table cell reads "${e.label}"`);
		if (hits.length > 1) throw new Error(`${hits.length} table cells read "${e.label}": give table, row and col instead`);
		const row = elems(hits[0].parent, "w:tc");
		let i = row.indexOf(hits[0]) + 1;
		while (i < row.length - 1 && isSpacer(row[i])) i++;
		if (i >= row.length) throw new Error(`No cell to the right of "${e.label}"`);
		return { cell: row[i], where: `the cell right of "${e.label}"` };
	}
	const tables = named(body, "w:tbl").filter((t) => !ancestor(t, (a) => a.name === "w:tbl"));
	const tbl = tables[e.table - 1];
	if (!tbl) throw new Error(`No table ${e.table}: the file has ${tables.length} (count them in office_read, from 1)`);
	const tr = elems(tbl, "w:tr")[e.row - 1];
	if (!tr) throw new Error(`Table ${e.table} has no row ${e.row}`);
	const cell = elems(tr, "w:tc")[e.col - 1];
	if (!cell) throw new Error(`Row ${e.row} of table ${e.table} has no column ${e.col}`);
	return { cell, where: `table ${e.table}, row ${e.row}, column ${e.col}` };
}

function fill(ctx, body, e) {
	let p;
	let where;
	if (e.label !== undefined || e.table !== undefined) {
		const t = targetCell(body, e);
		const has = norm(cellText(t.cell));
		if (has) throw new Error(`${t.where} already has text "${has.slice(0, 60)}": change it with find and replace`);
		p = first(t.cell, "w:p");
		if (!p) append(t.cell, (p = el("w:p")));
		where = t.where;
	} else if (e.after !== undefined) {
		const all = named(body, "w:p");
		const from = all.indexOf(onePara(body, e.after));
		p = all.slice(from + 1).find((x) => !norm(paraText(x)));
		if (!p) throw new Error(`No empty paragraph after "${String(e.after).slice(0, 60)}"`);
		where = `the empty paragraph after "${String(e.after).slice(0, 60)}"`;
	} else throw new Error("fill needs label (the text of the cell to its left), table + row + col, or after (an empty paragraph after this text)");
	fillParagraph(ctx, p, e.fill);
	return { note: `filled ${where}` };
}

// ---------- comments ----------

const NS = {
	w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
	w14: "http://schemas.microsoft.com/office/word/2010/wordml",
	w15: "http://schemas.microsoft.com/office/word/2012/wordml",
	w16cid: "http://schemas.microsoft.com/office/word/2016/wordml/cid",
	mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
};
const RELS = "word/_rels/document.xml.rels";
const COMMENT_PARTS = {
	comments: ["comments.xml", "w:comments", ["w", "w14"], "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"],
	ext: ["commentsExtended.xml", "w15:commentsEx", ["w15"], "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"],
	ids: ["commentsIds.xml", "w16cid:commentsIds", ["w16cid"], "http://schemas.microsoft.com/office/2016/09/relationships/commentsIds",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.commentsIds+xml"],
};
/** A relationship target of a part in word/ as a name in the zip ("../customXml/item1.xml" -> "customXml/item1.xml"). */
function relTarget(t) {
	const parts = [];
	for (const s of (t.startsWith("/") ? t.slice(1) : `word/${t}`).split("/")) {
		if (s === "..") parts.pop();
		else if (s && s !== ".") parts.push(s);
	}
	try { return decodeURI(parts.join("/")); } catch { return parts.join("/"); }
}

/** Declare a namespace on a part's root element (and let older readers ignore it). */
function ensureNs(root, prefix) {
	if (new RegExp(`\\sxmlns:${prefix}=`).test(root.attrs)) return;
	root.attrs += ` xmlns:${prefix}="${NS[prefix]}"`;
	if (!/\sxmlns:mc=/.test(root.attrs)) root.attrs += ` xmlns:mc="${NS.mc}"`;
	const ign = getA(root, "mc:Ignorable");
	if (ign === undefined) root.attrs += ` mc:Ignorable="${prefix}"`;
	else if (!ign.split(/\s+/).includes(prefix)) root.attrs = root.attrs.replace(/mc:Ignorable="[^"]*"/, `mc:Ignorable="${ign} ${prefix}"`);
}

/** The root element of a comment part, made (with its relationship and content type) when the file has none. */
function commentPart(pkg, key) {
	const [file, rootName, prefixes, type, contentType] = COMMENT_PARTS[key];
	if (!pkg.files[RELS]) pkg.files[RELS] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
	const rels = first(pkg.tree(RELS), "Relationships");
	let rel = elems(rels, "Relationship").find((r) => getA(r, "Type") === type);
	if (!rel) {
		const n = Math.max(0, ...elems(rels, "Relationship").map((r) => Number(/^rId(\d+)$/.exec(getA(r, "Id") ?? "")?.[1] ?? 0))) + 1;
		append(rels, (rel = el("Relationship", ` Id="rId${n}" Type="${type}" Target="${file}"`)));
	}
	const name = relTarget(getA(rel, "Target"));
	if (!pkg.files[name]) {
		const decl = prefixes.map((x) => ` xmlns:${x}="${NS[x]}"`).join("");
		const ign = prefixes.filter((x) => x !== "w");
		pkg.files[name] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${rootName}${decl}${ign.length ? ` xmlns:mc="${NS.mc}" mc:Ignorable="${ign.join(" ")}"` : ""}></${rootName}>`);
	}
	const types = first(pkg.tree("[Content_Types].xml"), "Types");
	if (!elems(types, "Override").some((o) => getA(o, "PartName") === `/${name}`)) append(types, el("Override", ` PartName="/${name}" ContentType="${contentType}"`));
	const root = first(pkg.tree(name), rootName);
	if (!root) throw new Error(`${name} has no <${rootName}>`);
	for (const x of prefixes) ensureNs(root, x);
	return root;
}

const hexId = (max) => randomInt(1, max).toString(16).toUpperCase().padStart(8, "0");

function addComment(ctx, pkg, body, e) {
	const comments = commentPart(pkg, "comments");
	const id = ctx.nextId++;
	const lines = String(e.comment).split(/\r?\n/);
	const paraIds = lines.map(() => hexId(0x7fffffff));
	const ps = lines.map((l, i) => `<w:p w14:paraId="${paraIds[i]}" w14:textId="77777777"><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>` +
		`${i ? "" : '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>'}<w:r>${textKids(l).map(xml).join("")}</w:r></w:p>`);
	const c = first(parseXml(`<w:comment w:id="${id}" w:author="${escA(ctx.author)}" w:date="${ctx.date}" w:initials="${escA(ctx.initials)}">${ps.join("")}</w:comment>`), "w:comment");
	const start = el("w:commentRangeStart", ` w:id="${id}"`);
	const end = el("w:commentRangeEnd", ` w:id="${id}"`);
	const ref = el("w:r", "", [el("w:rPr", "", [el("w:rStyle", ' w:val="CommentReference"')]), el("w:commentReference", ` w:id="${id}"`)]);
	let parentPara;
	let note;
	if (e.replyTo !== undefined) {
		const pid = String(e.replyTo);
		const parent = elems(comments, "w:comment").find((x) => getA(x, "w:id") === pid);
		if (!parent) throw new Error(`No comment ${pid} to reply to (office_read lists them as [comment N])`);
		const last = elems(parent, "w:p").at(-1);
		if (!last) throw new Error(`Comment ${pid} is empty`);
		parentPara = getA(last, "w14:paraId");
		if (!parentPara) {
			parentPara = hexId(0x7fffffff);
			last.attrs += ` w14:paraId="${parentPara}" w14:textId="77777777"`;
		}
		const byId = (name) => named(body, name).find((x) => getA(x, "w:id") === pid);
		const pRef = byId("w:commentReference");
		if (!pRef) throw new Error(`Comment ${pid} is not anchored in the document text, so a reply cannot be placed`);
		const pStart = byId("w:commentRangeStart");
		const pEnd = byId("w:commentRangeEnd");
		if (pStart && pEnd) {
			place(pStart, "after", start);
			place(pEnd, "after", end);
		}
		place(pRef.parent.name === "w:r" ? pRef.parent : pRef, "after", ref);
		note = `reply ${id} to comment ${pid} added`;
	} else {
		const want = String(e.find ?? "");
		const p = onePara(body, want);
		const runs = span(p, paraText(p).indexOf(want), want.length, false);
		if (!runs) throw new Error(`"${want.slice(0, 60)}" starts or ends inside a field or picture: quote other words for the comment`);
		place(runs[0], "before", start);
		place(runs.at(-1), "after", end);
		place(end, "after", ref);
		note = `comment ${id} added on "${want.slice(0, 60)}"`;
	}
	append(comments, c);
	const lastPara = paraIds.at(-1);
	append(commentPart(pkg, "ext"), el("w15:commentEx", ` w15:paraId="${lastPara}"${parentPara ? ` w15:paraIdParent="${parentPara}"` : ""} w15:done="0"`));
	append(commentPart(pkg, "ids"), el("w16cid:commentId", ` w16cid:paraId="${lastPara}" w16cid:durableId="${hexId(0x7ffffffe)}"`));
	return { note };
}

// ---------- accept and reject ----------

const PROP_CHANGES = new Set(["w:rPrChange", "w:pPrChange", "w:sectPrChange", "w:tblPrChange", "w:tblPrExChange", "w:tcPrChange", "w:trPrChange", "w:tblGridChange", "w:numberingChange"]);
// what a property holder keeps when a formatting change is rejected, and whether it comes before the restored properties
const KEEP = {
	"w:pPr": [["w:rPr", "w:sectPr"], false], "w:rPr": [[...REVISION], true], "w:trPr": [["w:ins", "w:del"], false],
	"w:tcPr": [["w:cellIns", "w:cellDel", "w:cellMerge"], false], "w:sectPr": [["w:headerReference", "w:footerReference"], true],
};

function restoreProps(change) {
	const holder = change.parent;
	const old = elems(change)[0];
	if (change.name === "w:numberingChange" || !old) return detach(change);
	const [names, keptFirst] = KEEP[holder.name] ?? [[], false];
	const kept = elems(holder).filter((k) => names.includes(k.name));
	const restored = (change.name === "w:tblGridChange" ? elems(old) : old.kids).map(clone);
	holder.kids = [];
	append(holder, ...(keptFirst ? [...kept, ...restored] : [...restored, ...kept]));
}

/** Join a paragraph to the next one (what a removed paragraph mark means): its content moves to the start of the next. */
function joinNext(p) {
	const next = nextBlock(p);
	if (next?.name !== "w:p") return;
	const moved = p.kids.filter((k) => !(isEl(k) && k.name === "w:pPr"));
	detach(p);
	const nPPr = first(next, "w:pPr");
	insertAt(next, nPPr ? next.kids.indexOf(nPPr) + 1 : 0, ...moved);
}

/** Accept or reject the tracked changes that pick() selects. Returns how many. */
export function resolveRevisions(root, action, pick = () => true) {
	const targets = find(root, (n) => (REVISION.has(n.name) || PROP_CHANGES.has(n.name) || /^w:move(From|To)Range(Start|End)$/.test(n.name)) && pick(n));
	let count = 0;
	for (const n of targets) {
		if (!attached(n)) continue; // went with a bigger change
		const holder = n.parent;
		if (!/Range/.test(n.name)) count++;
		if (PROP_CHANGES.has(n.name)) {
			if (action === "reject") restoreProps(n);
			else detach(n);
			continue;
		}
		if (/Range/.test(n.name)) { detach(n); continue; }
		const stays = (action === "accept") === INSERTED.has(n.name); // accepted insertion or rejected deletion
		if (holder.name === "w:rPr" && holder.parent?.name === "w:pPr") { // a paragraph mark
			const p = holder.parent.parent;
			detach(n);
			if (!hasEls(holder)) detach(holder);
			if (!stays) joinNext(p);
			continue;
		}
		if (holder.name === "w:trPr") {
			detach(n);
			const tbl = holder.parent.parent;
			if (!stays) detach(holder.parent);
			if (!first(tbl, "w:tr") && tbl.parent) detach(tbl); // a table without rows is a damaged file
			continue;
		}
		if (!hasEls(n)) { detach(n); continue; } // a mark on numbering or run properties
		if (!stays) { detach(n); continue; }
		for (const t of named(n, "w:delText", "w:delInstrText")) t.name = t.name === "w:delText" ? "w:t" : "w:instrText";
		unwrap(n);
	}
	return count;
}

const REVISED_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

function acceptReject(pkg, e) {
	const action = e.accept !== undefined ? "accept" : "reject";
	const who = e.accept ?? e.reject;
	const author = who === true || who === "all" || who === "" ? null : norm(String(who)).toLowerCase();
	const pick = (n) => !author || norm(getA(n, "w:author") ?? "").toLowerCase() === author;
	let count = 0;
	for (const name of Object.keys(pkg.files).filter((n) => REVISED_PARTS.test(n))) count += resolveRevisions(pkg.tree(name), action, pick);
	return { note: `${count} tracked change(s) ${action}ed${author ? ` (by ${who})` : ""}` };
}

// ---------- checking a result ----------

const XML_PART = /\.(xml|rels)$/;

/** Problems that would make Word refuse or misread the file. */
export function checkDocx(files, docName = "word/document.xml") {
	const problems = [];
	const trees = {};
	for (const name of Object.keys(files).filter((n) => XML_PART.test(n))) {
		try { trees[name] = parseXml(strFromU8(files[name])); } catch (e) { problems.push(`${name}: ${e.message}`); }
	}
	const doc = trees[docName];
	if (!doc) return problems;
	const where = (n) => {
		const p = n.name === "w:p" ? n : ancestor(n, (a) => a.name === "w:p");
		return p ? ` near "${norm(paraText(p) || p.kids.filter(isEl).map((k) => runText(k)).join("")).slice(0, 50)}"` : "";
	};
	const ids = new Map();
	const seen = (id, what) => ids.set(id, [...(ids.get(id) ?? []), what]);
	for (const n of named(doc, ...REVISION)) {
		const id = getA(n, "w:id");
		seen(id, "tracked change");
		const outer = ancestor(n, (a) => REVISION.has(a.name));
		if (outer && INSERTED.has(n.name) && INSERTED.has(outer.name)) problems.push(`a tracked insertion (w:id ${id}) inside another one${where(n)}`);
		if (outer && DELETED.has(n.name) && DELETED.has(outer.name)) problems.push(`a tracked deletion (w:id ${id}) inside another one${where(n)}`);
		if (outer && INSERTED.has(n.name) && DELETED.has(outer.name)) problems.push(`a tracked insertion (w:id ${id}) inside a deletion${where(n)}`);
	}
	for (const t of named(doc, "w:t")) if (ancestor(t, (a) => a.name === "w:del")) problems.push(`deleted text in <w:t> instead of <w:delText>${where(t)}`);
	for (const t of named(doc, "w:delText")) if (!ancestor(t, (a) => DELETED.has(a.name))) problems.push(`<w:delText> outside a deletion${where(t)}`);
	const relsTree = trees[docName.replace(/([^/]+)$/, "_rels/$1.rels")];
	const rels = relsTree ? named(relsTree, "Relationship") : [];
	const commentsRel = rels.find((r) => /\/comments$/.test(getA(r, "Type") ?? ""));
	const commentsTree = commentsRel ? trees[relTarget(getA(commentsRel, "Target"))] : null;
	const commentIds = new Set();
	for (const c of commentsTree ? named(commentsTree, "w:comment") : []) {
		const id = getA(c, "w:id");
		if (commentIds.has(id)) problems.push(`two comments have w:id ${id}`);
		commentIds.add(id);
		seen(id, "comment");
	}
	for (const [id, what] of ids) if (what.length > 1) problems.push(`w:id ${id} is used ${what.length} times (${[...new Set(what)].join(" and ")}s)`);
	const marks = (name) => new Set(named(doc, name).map((x) => getA(x, "w:id")));
	const starts = marks("w:commentRangeStart");
	const ends = marks("w:commentRangeEnd");
	for (const id of starts) if (!ends.has(id)) problems.push(`comment ${id} starts but never ends`);
	for (const id of ends) if (!starts.has(id)) problems.push(`comment ${id} ends but never starts`);
	for (const id of new Set([...starts, ...ends, ...marks("w:commentReference")])) if (!commentIds.has(id)) problems.push(`comment ${id} is marked in the text but missing from the comments`);
	for (const r of rels) {
		if (getA(r, "TargetMode") === "External") continue;
		const target = relTarget(getA(r, "Target") ?? "");
		if (!files[target]) problems.push(`the document links to ${target}, which is not in the file`);
	}
	return problems;
}

// ---------- the package ----------

class Package {
	constructor(bytes) {
		this.files = unzipSync(bytes);
		this.trees = new Map();
	}
	tree(name) {
		if (!this.trees.has(name)) {
			if (!this.files[name]) throw new Error(`${name} is missing: not a Word document`);
			this.trees.set(name, parseXml(strFromU8(this.files[name])));
		}
		return this.trees.get(name);
	}
	flush() {
		for (const [name, t] of this.trees) this.files[name] = strToU8(xml(t));
	}
}

function stamp(date) {
	if (!date) return new Date().toISOString().replace(/\.\d+Z$/, "Z");
	const s = String(date).trim();
	const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
	if (Number.isNaN(t)) throw new Error(`Not a date: ${date} (e.g. 2026-11-06 or 2026-11-06T09:30:00Z)`);
	return new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
}

export function initialsOf(name) {
	const words = String(name).trim().split(/\s+/).filter(Boolean);
	if (words.length > 1) return words.map((w) => w[0]).join("").slice(0, 3).toUpperCase();
	return String(name).trim().slice(0, /[\u3400-\u9fff]/.test(name) ? 2 : 1).toUpperCase() || "F";
}

let user;
/** The name Word itself puts on changes (Office's user name on Windows), else the computer's user name. */
export function officeUser() {
	if (user) return user;
	let name = "";
	let initials = "";
	if (process.platform === "win32") {
		try {
			const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
				"[Console]::OutputEncoding=[Text.Encoding]::UTF8; $u = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Office\\Common\\UserInfo' -ErrorAction SilentlyContinue; \"$($u.UserName)`t$($u.UserInitials)\""],
			{ encoding: "utf8", timeout: 8000, windowsHide: true });
			[name = "", initials = ""] = out.trim().split("\t");
		} catch { /* no Office settings: the computer's user name */ }
	}
	if (!name.trim()) try { name = userInfo().username; } catch { name = "Ferry"; }
	user = { author: name.trim() || "Ferry", initials: initials.trim() || initialsOf(name) };
	return user;
}

/**
 * Change a .docx. Each edit is one of:
 *   { find, replace, all }                       replace text (tracked unless track is off)
 *   { insert, after | before, style }            new paragraph(s) after / before the paragraph holding that text
 *   { deleteParagraph, through }                 delete the paragraph holding that text (through another one)
 *   { fill, label | table+row+col | after }      write into an empty table cell or paragraph
 *   { comment, find } or { comment, replyTo }    a comment on that text, or a reply to comment N
 *   { accept | reject: "all" or an author }      accept or reject tracked changes
 * Any edit may carry track: false/true for itself. Nothing is saved when an edit fails or the result has problems.
 */
export function editDocx(path, edits, { track = true, author = "Ferry", initials, date, out = path } = {}) {
	const pkg = new Package(readFileSync(path));
	const docName = "word/document.xml";
	const before = new Set(checkDocx(pkg.files, docName));
	const tree = pkg.tree(docName);
	const body = named(tree, "w:body")[0] ?? tree;
	const beforeText = allText(body);
	const ids = ["word/document.xml", "word/comments.xml", "word/footnotes.xml", "word/endnotes.xml"]
		.flatMap((n) => (pkg.files[n] ? [...strFromU8(pkg.files[n]).matchAll(/\bw:id="(\d+)"/g)].map((m) => +m[1]) : []));
	const ctx = { track, author, initials: initials || initialsOf(author), date: stamp(date), nextId: Math.max(0, ...ids) + 1, mine: new Set() };
	const report = [];
	let allTracked = track;
	for (const e of edits) {
		ctx.track = e.track ?? track;
		if (e.accept !== undefined || e.reject !== undefined) { allTracked = false; report.push(acceptReject(pkg, e)); continue; }
		if (!ctx.track && e.comment === undefined) allTracked = false;
		if (e.comment !== undefined) report.push(addComment(ctx, pkg, body, e));
		else if (e.insert !== undefined) report.push(insertParagraphs(ctx, body, e));
		else if (e.deleteParagraph !== undefined) report.push(deleteParagraphs(ctx, body, e));
		else if (e.fill !== undefined) report.push(fill(ctx, body, e));
		else if (e.find !== undefined) {
			if (!String(e.find)) throw new Error("an edit has an empty find");
			report.push(replaceText(ctx, body, e));
		} else throw new Error("Each edit needs find + replace, insert + after/before, deleteParagraph, fill, comment, accept or reject");
	}
	pkg.flush();
	const problems = checkDocx(pkg.files, docName).filter((p) => !before.has(p));
	if (allTracked && !problems.length) {
		// every change should be tracked: rejecting this edit's changes must give back the text as it was
		const back = parseXml(strFromU8(pkg.files[docName]));
		resolveRevisions(back, "reject", (n) => ctx.mine.has(getA(n, "w:id")));
		const now = allText(named(back, "w:body")[0] ?? back);
		if (now !== beforeText) {
			let i = 0;
			while (now[i] === beforeText[i]) i++;
			problems.push(`a change is not tracked, near "${beforeText.slice(Math.max(0, i - 30), i + 30).replace(/\n/g, " / ")}"`);
		}
	}
	if (problems.length) {
		throw new Error(`Not saved, ${path} is unchanged: the result would have these problems:\n- ${problems.slice(0, 10).join("\n- ")}` +
			"\nChange the edits (other words, smaller steps), or make this change in Word.");
	}
	writeFileSync(out, zipSync(pkg.files));
	return report;
}
