// Office files without Office: read Word (with tracked changes and comments), Excel, PowerPoint and PDF; change Word
// text as tracked changes and Excel cells; create Word and Excel files. Works on the files themselves, so nothing
// needs to be installed and no window on the screen is touched. A .docx/.xlsx/.pptx is a zip of XML files.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { Type } from "typebox";
import { wrapExternal } from "./external.mjs";

const MAX_OUT = 60_000;

const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
	.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
	.replace(/&amp;/g, "&");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

function openZip(path) {
	const files = unzipSync(typeof path === "string" ? readFileSync(path) : path);
	return { files, text: (n) => (files[n] ? strFromU8(files[n]) : ""), put: (n, s) => { files[n] = strToU8(s); } };
}

// ---------- Word ----------

/** Visible text of one paragraph; tracked changes as {+inserted+} / {-deleted-} when show is true. */
function paragraphText(p, show = true) {
	let out = "";
	let mode = "";
	const re = /<w:ins\b[^>]*>|<\/w:ins>|<w:del\b[^>]*>|<\/w:del>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:delText(?:\s[^>]*)?>([\s\S]*?)<\/w:delText>|<w:tab\/>|<w:br\/>|<w:commentReference w:id="(\d+)"\/>/g;
	let m;
	let open = "";
	const flush = (next) => {
		if (open && open !== next && show) out += open === "ins" ? "+}" : "-}";
		if (next && open !== next && show) out += next === "ins" ? "{+" : "{-";
		open = next;
	};
	while ((m = re.exec(p))) {
		const tok = m[0];
		if (tok.startsWith("<w:ins")) mode = "ins";
		else if (tok === "</w:ins>" || tok === "</w:del>") mode = "";
		else if (tok.startsWith("<w:del") && !tok.startsWith("<w:delText")) mode = "del";
		else if (tok === "<w:tab/>") out += "\t";
		else if (tok === "<w:br/>") out += "\n";
		else if (m[3] !== undefined) out += `[comment ${m[3]}]`;
		else {
			const text = unesc(m[1] ?? m[2] ?? "");
			if (!text) continue;
			if (mode === "del" && !show) continue;
			flush(show ? mode : "");
			out += text;
		}
	}
	flush("");
	return out;
}

function headingLevel(p) {
	const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? "";
	const n = /heading\s*([1-6])|^([1-6])$|berschrift([1-6])|标题\s*([1-6])/i.exec(style);
	if (n) return Number(n[1] ?? n[2] ?? n[3] ?? n[4]);
	return /^title$/i.test(style) ? 1 : 0;
}

export function readDocx(path, { revisions = "show" } = {}) {
	const z = openZip(path);
	const doc = z.text("word/document.xml");
	const show = revisions !== "accepted";
	const lines = [];
	let tracked = false;
	const body = /<w:body>([\s\S]*)<\/w:body>/.exec(doc)?.[1] ?? doc;
	const blocks = body.match(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g) ?? [];
	for (const b of blocks) {
		if (/<w:ins\b|<w:del\b/.test(b)) tracked = true;
		if (b.startsWith("<w:tbl>")) {
			const rows = b.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? [];
			rows.forEach((r, i) => {
				const cells = (r.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map((c) =>
					(c.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map((p) => paragraphText(p, show)).filter(Boolean).join(" / ").replace(/\|/g, "\\|"));
				lines.push(`| ${cells.join(" | ")} |`);
				if (i === 0) lines.push(`|${cells.map(() => " --- ").join("|")}|`);
			});
			lines.push("");
			continue;
		}
		const text = paragraphText(b, show);
		const h = headingLevel(b);
		const list = /<w:numPr>/.test(b) ? "- " : "";
		lines.push(h ? `${"#".repeat(h)} ${text}` : `${list}${text}`);
	}
	const comments = [...z.text("word/comments.xml").matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)].map((c) =>
		`[comment ${attr(c[1], "w:id")}] ${unesc(attr(c[1], "w:author") ?? "")}: ${(c[2].match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map((p) => paragraphText(p)).join(" ")}`);
	let out = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
	if (tracked && show) out = `(tracked changes: {+inserted+} {-deleted-})\n\n${out}`;
	if (comments.length) out += `\n\nComments:\n${comments.join("\n")}`;
	return out;
}

/** Runs of a paragraph that carry visible text: [{ start, end, rPr, text, plain }] with offsets into the paragraph XML. */
function runsOf(p) {
	const dels = [...p.matchAll(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g)].map((m) => [m.index, m.index + m[0].length]);
	const runs = [];
	for (const m of p.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) {
		if (dels.some(([a, b]) => m.index >= a && m.index < b)) continue;
		const inner = m[1];
		const rPr = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(inner)?.[0] ?? "";
		const rest = inner.replace(rPr, "");
		const text = [...rest.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>/g)].map((t) => (t[0] === "<w:tab/>" ? "\t" : unesc(t[1]))).join("");
		const plain = rest.replace(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:tab\/>|<w:lastRenderedPageBreak\/>|<w:proofErr[^>]*\/>/g, "").trim() === "";
		if (text) runs.push({ start: m.index, end: m.index + m[0].length, rPr, text, plain });
	}
	return runs;
}

const tEl = (s) => `<w:t${/^\s|\s$/.test(s) ? ' xml:space="preserve"' : ""}>${esc(s)}</w:t>`;
const runXml = (rPr, s) => `<w:r>${rPr}${tEl(s)}</w:r>`;

/** Replace text in a .docx, as tracked changes by default. edits: [{ find, replace, all }]. Returns per-edit counts. */
export function editDocx(path, edits, { track = true, author = "Ferry", out = path } = {}) {
	const z = openZip(path);
	let doc = z.text("word/document.xml");
	let nextId = Math.max(1000, ...[...doc.matchAll(/w:id="(\d+)"/g)].map((m) => +m[1] + 1));
	const date = new Date().toISOString().replace(/\.\d+Z$/, "Z");
	const rev = (kind) => `<w:${kind} w:id="${nextId++}" w:author="${esc(author)}" w:date="${date}">`;
	const report = [];
	for (const e of edits) {
		let count = 0;
		let skipped = 0;
		const find = String(e.find ?? "");
		if (!find) throw new Error("an edit has an empty find");
		const total = (doc.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).reduce((n, p) => n + paragraphText(p, false).split(find).length - 1, 0);
		if (total === 0) throw new Error(`Not found: "${find.slice(0, 80)}" (text must be inside one paragraph)`);
		if (total > 1 && !e.all) throw new Error(`"${find.slice(0, 80)}" occurs ${total} times: make it longer to be unique, or set all: true`);
		doc = doc.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (p) => {
			let guard = 0;
			let from = 0; // search after the last replacement, so a replacement that contains the text is not replaced again
			for (;;) {
				const runs = runsOf(p);
				const text = runs.map((r) => r.text).join("");
				const at = text.indexOf(find, from);
				if (at < 0 || guard++ > 50) return p;
				let pos = 0;
				const hit = [];
				for (const r of runs) {
					const a = pos;
					const b = pos + r.text.length;
					pos = b;
					if (b <= at || a >= at + find.length) continue;
					hit.push({ r, from: Math.max(0, at - a), to: Math.min(r.text.length, at + find.length - a) });
				}
				if (hit.some((h) => !h.r.plain)) { // a field, picture or note in the way: leave this one to Word
					skipped++;
					from = at + find.length;
					if (!e.all) return p;
					continue;
				}
				const pieces = [];
				hit.forEach((h, i) => {
					const before = h.r.text.slice(0, h.from);
					const mid = h.r.text.slice(h.from, h.to);
					const after = h.r.text.slice(h.to);
					let x = before ? runXml(h.r.rPr, before) : "";
					if (track) x += `${rev("del")}<w:r>${h.r.rPr}<w:delText${/^\s|\s$/.test(mid) ? ' xml:space="preserve"' : ""}>${esc(mid)}</w:delText></w:r></w:del>`;
					if (i === hit.length - 1 && e.replace) x += track ? `${rev("ins")}${runXml(hit[0].r.rPr, e.replace)}</w:ins>` : runXml(hit[0].r.rPr, e.replace);
					if (after) x += runXml(h.r.rPr, after);
					pieces.push([h.r.start, h.r.end, x]);
				});
				for (const [a, b, x] of pieces.reverse()) p = p.slice(0, a) + x + p.slice(b);
				from = at + (e.replace ?? "").length;
				count++;
				if (!e.all) return p;
			}
		});
		report.push({ find: find.slice(0, 60), replaced: count, skipped });
	}
	z.put("word/document.xml", doc);
	writeFileSync(out, zipSync(z.files));
	return report;
}

// ---------- Excel ----------

const colNum = (c) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colName = (n) => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const splitRef = (ref) => { const m = /^([A-Z]+)(\d+)$/.exec(ref.toUpperCase()); if (!m) throw new Error(`Not a cell: ${ref}`); return [m[1], +m[2]]; };

function sheetsOf(z) {
	const wb = z.text("xl/workbook.xml");
	const rels = Object.fromEntries([...z.text("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b([^>]*)\/?>/g)]
		.map((r) => [attr(r[1], "Id"), attr(r[1], "Target")]));
	return [...wb.matchAll(/<sheet\b([^>]*)\/>/g)].map((s) => {
		const target = rels[attr(s[1], "r:id")] ?? "";
		return { name: unesc(attr(s[1], "name") ?? ""), file: target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}` };
	});
}

function sharedStrings(z) {
	return [...z.text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((si) =>
		[...si[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => unesc(t[1])).join(""));
}

export function readXlsx(path, { sheet, range, formulas = false, maxRows = 200, maxSheets = 5 } = {}) {
	const z = openZip(path);
	const sheets = sheetsOf(z);
	const ss = sharedStrings(z);
	const pick = sheet ? sheets.filter((s) => s.name === sheet) : sheets;
	if (sheet && !pick.length) throw new Error(`No sheet "${sheet}". Sheets: ${sheets.map((s) => s.name).join(", ")}`);
	let [c1, r1, c2, r2] = [1, 1, 9999, 1e7];
	if (range) {
		const [a, b = a] = range.split(":");
		const [ca, ra] = splitRef(a);
		const [cb, rb] = splitRef(b);
		[c1, r1, c2, r2] = [colNum(ca), ra, colNum(cb), rb];
	}
	const out = [`Sheets: ${sheets.map((s) => s.name).join(", ")}`];
	for (const s of pick.slice(0, sheet ? 1 : maxSheets)) {
		const xml = z.text(s.file);
		const grid = new Map();
		let maxC = 0;
		for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
			const ref = attr(c[1], "r");
			if (!ref) continue;
			const [col, row] = splitRef(ref);
			const cn = colNum(col);
			if (cn < c1 || cn > c2 || row < r1 || row > r2) continue;
			const inner = c[2] ?? "";
			const t = attr(c[1], "t");
			const f = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(inner)?.[1];
			const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
			let val = t === "s" ? ss[+v] ?? "" : t === "inlineStr" ? [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => unesc(x[1])).join("")
				: t === "b" ? (v === "1" ? "TRUE" : "FALSE") : unesc(v ?? "");
			if (formulas && f) val = `=${unesc(f)}`;
			if (!grid.has(row)) grid.set(row, new Map());
			grid.get(row).set(cn, val);
			maxC = Math.max(maxC, cn);
		}
		const rows = [...grid.keys()].sort((a, b) => a - b);
		out.push("", `## ${s.name} (${rows.length} rows with data)`);
		if (!rows.length) continue;
		const from = Math.max(c1, 1);
		const cols = Array.from({ length: Math.min(maxC, from + 39) - from + 1 }, (_, i) => from + i);
		out.push(`| row | ${cols.map(colName).join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`);
		for (const r of rows.slice(0, maxRows)) {
			out.push(`| ${r} | ${cols.map((c) => String(grid.get(r).get(c) ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`);
		}
		if (rows.length > maxRows) out.push(`... ${rows.length - maxRows} more rows: ask for a range, e.g. A${rows[maxRows]}:${colName(maxC)}${rows.at(-1)}`);
	}
	return out.join("\n");
}

/** Set cells in place, keeping everything else (styles, other sheets, charts). cells: { "B3": 42, "C3": "text", "D3": "=SUM(B1:B3)" } */
export function editXlsx(path, cells, { sheet, out = path } = {}) {
	const z = openZip(path);
	const sheets = sheetsOf(z);
	const s = sheet ? sheets.find((x) => x.name === sheet) : sheets[0];
	if (!s) throw new Error(`No sheet "${sheet}". Sheets: ${sheets.map((x) => x.name).join(", ")}`);
	let xml = z.text(s.file);
	if (!/<sheetData\/>|<sheetData>/.test(xml)) throw new Error("This sheet has no data area");
	xml = xml.replace("<sheetData/>", "<sheetData></sheetData>");
	for (const [ref0, value] of Object.entries(cells)) {
		const ref = ref0.toUpperCase();
		const [col, row] = splitRef(ref);
		const cellRe = new RegExp(`<c r="${ref}"([^>]*?)(?:\\/>|>[\\s\\S]*?<\\/c>)`);
		const old = cellRe.exec(xml);
		const style = old ? attr(old[1], "s") : undefined;
		const s_ = style ? ` s="${style}"` : "";
		let cell;
		if (value === null || value === "") cell = `<c r="${ref}"${s_}/>`;
		else if (typeof value === "number" || (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value))) cell = `<c r="${ref}"${s_}><v>${value}</v></c>`;
		else if (typeof value === "boolean") cell = `<c r="${ref}"${s_} t="b"><v>${value ? 1 : 0}</v></c>`;
		else if (String(value).startsWith("=")) cell = `<c r="${ref}"${s_}><f>${esc(String(value).slice(1))}</f></c>`;
		else cell = `<c r="${ref}"${s_} t="inlineStr"><is>${tEl(String(value)).replace(/w:t/g, "t")}</is></c>`;
		if (old) {
			xml = xml.replace(cellRe, cell);
			continue;
		}
		const rowRe = new RegExp(`<row r="${row}"([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/row>)`);
		const r = rowRe.exec(xml);
		if (r) {
			const inner = r[2] ?? "";
			const parts = [...inner.matchAll(/<c r="([A-Z]+)\d+"[\s\S]*?(?:\/>|<\/c>)/g)];
			const after = parts.find((p) => colNum(p[1]) > colNum(col));
			const newInner = after ? inner.slice(0, after.index) + cell + inner.slice(after.index) : inner + cell;
			xml = xml.replace(rowRe, `<row r="${row}"${r[1].replace(/\s*spans="[^"]*"/, "")}>${newInner}</row>`);
		} else {
			const rows = [...xml.matchAll(/<row r="(\d+)"/g)];
			const next = rows.find((x) => +x[1] > row);
			const rowXml = `<row r="${row}">${cell}</row>`;
			xml = next ? xml.slice(0, next.index) + rowXml + xml.slice(next.index) : xml.replace("</sheetData>", `${rowXml}</sheetData>`);
		}
	}
	z.put(s.file, xml);
	// formulas: let Excel recalculate on opening, and drop the cached calculation order that may no longer match
	delete z.files["xl/calcChain.xml"];
	z.put("[Content_Types].xml", z.text("[Content_Types].xml").replace(/<Override[^>]*calcChain[^>]*\/>/, ""));
	z.put("xl/_rels/workbook.xml.rels", z.text("xl/_rels/workbook.xml.rels").replace(/<Relationship[^>]*calcChain[^>]*\/>/, ""));
	let wb = z.text("xl/workbook.xml");
	wb = /<calcPr\b/.test(wb) ? wb.replace(/<calcPr\b([^>]*?)\/>/, (m, a) => `<calcPr${a.replace(/\s*fullCalcOnLoad="[^"]*"/, "")} fullCalcOnLoad="1"/>`)
		: wb.replace("</workbook>", '<calcPr fullCalcOnLoad="1"/></workbook>');
	z.put("xl/workbook.xml", wb);
	writeFileSync(out, zipSync(z.files));
	return Object.keys(cells).length;
}

// ---------- PowerPoint and PDF ----------

export function readPptx(path) {
	const z = openZip(path);
	const slides = Object.keys(z.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
		.sort((a, b) => +/(\d+)\.xml/.exec(a)[1] - +/(\d+)\.xml/.exec(b)[1]);
	return slides.map((n, i) => {
		const paras = (z.text(n).match(/<a:p>[\s\S]*?<\/a:p>/g) ?? []).map((p) => [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => unesc(t[1])).join("")).filter(Boolean);
		const notes = z.text(n.replace("slides/slide", "notesSlides/notesSlide"));
		const noteText = [...notes.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => unesc(t[1])).join(" ").trim();
		return `## Slide ${i + 1}\n${paras.join("\n")}${noteText ? `\nNotes: ${noteText}` : ""}`;
	}).join("\n\n");
}

export async function readPdf(path, pages) {
	const { extractText, getDocumentProxy } = await import("unpdf");
	// verbosity 0 = errors only: pdf.js prints font warnings ("Warning: TT: undefined function") to the console, which
	// lands in the TUI input box.
	const pdf = await getDocumentProxy(new Uint8Array(typeof path === "string" ? readFileSync(path) : path), { verbosity: 0 });
	const { text } = await extractText(pdf, { mergePages: false });
	let [a, b] = [1, text.length];
	if (pages) {
		const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(String(pages).trim());
		if (m) [a, b] = [+m[1], +(m[2] ?? m[1])];
	}
	return `${text.length} pages\n\n${text.slice(a - 1, b).map((t, i) => `--- page ${a + i} ---\n${t}`).join("\n\n")}`;
}

// ---------- old binary files: .doc, .xls, .ppt ----------
// They are OLE compound files: a small FAT file system inside one file. Read here with plain code, so neither Office
// nor its COM automation (blocked on many company PCs) is needed.

const END = 0xfffffffa; // sector numbers from here up mark the end of a chain, a free sector, a FAT sector
const u16le = new TextDecoder("utf-16le");
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const concat = (parts) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
};
const CP1252 = "€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž�" +
	"�‘’“”•–—˜™š›œ�žŸ";
/** One byte per character: Windows-1252 (Word's "compressed" text), or Latin-1. */
const bytesText = (b, cp1252 = true) => {
	const codes = new Uint16Array(b.length);
	for (let i = 0; i < b.length; i++) codes[i] = cp1252 && b[i] >= 0x80 && b[i] < 0xa0 ? CP1252.charCodeAt(b[i] - 0x80) : b[i];
	return u16le.decode(codes);
};

/** An error for a file nobody can read without its owner; batch mode counts these apart. */
function locked(message, short) {
	const e = new Error(message);
	e.code = "ENCRYPTED";
	e.short = short;
	return e;
}
const IRM = () => locked("This file is encrypted with rights management (IRM): it cannot be read without the owner's permission, " +
	"by office_read or by any other tool or script. Do not try other ways; tell the user.", "rights management (IRM)");
const PASSWORD = () => locked("This file is protected with a password: it cannot be read without it. Do not try other ways; " +
	"ask the user for an unprotected copy.", "password");

/** A compound file: { names: every storage/stream path, stream(path) -> bytes or undefined }. */
export function readCfb(buf) {
	const bad = () => new Error("damaged file (old Office compound file format)");
	if (buf.length < 512) throw bad();
	const dv = view(buf);
	const u32 = (o) => {
		if (o < 0 || o + 4 > buf.length) throw bad();
		return dv.getUint32(o, true);
	};
	const ssz = 1 << dv.getUint16(0x1e, true);
	if (ssz !== 512 && ssz !== 4096) throw bad();
	const per = ssz / 4;
	const at = (s) => (s + 1) * ssz;
	const fatSectors = [];
	for (let i = 0; i < 109; i++) if (u32(0x4c + i * 4) < END) fatSectors.push(u32(0x4c + i * 4));
	for (let d = u32(0x44), n = 0; d < END && n <= u32(0x48); n++) { // more FAT sector numbers, in a chain of DIFAT sectors
		for (let i = 0; i < per - 1; i++) if (u32(at(d) + i * 4) < END) fatSectors.push(u32(at(d) + i * 4));
		d = u32(at(d) + ssz - 4);
	}
	const fat = [];
	for (const s of fatSectors) for (let i = 0; i < per; i++) fat.push(at(s) + i * 4 + 4 <= buf.length ? u32(at(s) + i * 4) : 0xfffffffe);
	const chain = (start, table) => {
		const out = [];
		for (let s = start; s < END; s = table[s]) {
			if (s >= table.length || out.length >= table.length) throw bad();
			out.push(s);
		}
		return out;
	};
	const big = (start, size) => {
		const all = concat(chain(start, fat).map((s) => buf.subarray(at(s), at(s) + ssz)));
		return size === undefined ? all : all.subarray(0, size);
	};
	const dir = big(u32(0x30));
	const ddv = view(dir);
	const entries = [];
	for (let o = 0; o + 128 <= dir.length; o += 128) {
		const nameLen = Math.min(64, ddv.getUint16(o + 0x40, true));
		entries.push({
			name: u16le.decode(dir.subarray(o, o + Math.max(0, nameLen - 2))), type: dir[o + 0x42],
			left: ddv.getUint32(o + 0x44, true), right: ddv.getUint32(o + 0x48, true), child: ddv.getUint32(o + 0x4c, true),
			start: ddv.getUint32(o + 0x74, true), size: ddv.getUint32(o + 0x78, true),
		});
	}
	const root = entries[0];
	if (root?.type !== 5) throw bad();
	const cutoff = u32(0x38);
	const msz = 1 << dv.getUint16(0x20, true);
	let mini;
	let miniFat;
	const small = (start, size) => { // streams under the cutoff live in 64-byte sectors inside the root's own stream
		if (!mini) {
			mini = big(root.start, root.size);
			const mf = u32(0x3c) < END ? big(u32(0x3c)) : new Uint8Array(0);
			miniFat = Array.from({ length: mf.length >> 2 }, (_, i) => view(mf).getUint32(i * 4, true));
		}
		return concat(chain(start, miniFat).map((s) => mini.subarray(s * msz, (s + 1) * msz))).subarray(0, size);
	};
	const paths = new Map();
	const seen = new Set();
	const stack = [[root.child, ""]];
	while (stack.length) {
		const [id, prefix] = stack.pop();
		if (id >= entries.length || seen.has(id)) continue;
		seen.add(id);
		const e = entries[id];
		paths.set(prefix + e.name, e);
		stack.push([e.left, prefix], [e.right, prefix]);
		if (e.type === 1) stack.push([e.child, `${prefix}${e.name}/`]);
	}
	return {
		names: [...paths.keys()],
		stream(path) {
			const e = paths.get(path) ?? [...paths].find(([k]) => k.toLowerCase() === path.toLowerCase())?.[1];
			if (e?.type !== 2) return undefined;
			return e.size < cutoff ? small(e.start, e.size) : big(e.start, e.size);
		},
	};
}

/** Word's text with its marks: paragraphs and line breaks as new lines, table cells as tabs, field codes dropped (results kept). */
function wordText(s) {
	let out = "";
	const fields = []; // per open field: true while in its code, false once in its result
	let cell = false;
	for (const ch of s) {
		const c = ch.charCodeAt(0);
		if (c === 0x13) fields.push(true);
		else if (c === 0x14) { if (fields.length) fields[fields.length - 1] = false; }
		else if (c === 0x15) fields.pop();
		else if (fields.includes(true)) continue;
		else if (c === 0x07) { // end of a cell; a second one in a row ends the table row
			out = cell ? `${out.slice(0, -1)}\n` : `${out}\t`;
			cell = !cell;
			continue;
		} else if (c === 0x0d || c === 0x0b || c === 0x0c) out += "\n";
		else if (c === 0x09) out += "\t";
		else if (c === 0x1e) out += "-";
		else if (c === 0xa0) out += " ";
		else if (c >= 0x20) out += ch;
		cell = false;
	}
	return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Text of a Word 97-2003 .doc: the main text through the piece table, both 1-byte and 2-byte pieces. */
export function readDoc(cfb) {
	const wd = cfb.stream("WordDocument");
	if (!wd || wd.length < 0x200) throw new Error("damaged Word file (no WordDocument stream)");
	const dv = view(wd);
	if (dv.getUint16(0, true) !== 0xa5ec) throw new Error("damaged Word file (not a Word 97-2003 document)");
	const flags = dv.getUint16(0x0a, true);
	if (flags & 0x0100) throw PASSWORD();
	if (dv.getUint16(2, true) < 101) throw new Error("a Word 6/95 file (older than Word 97): it cannot be read here; ask the user to save it as .docx");
	const table = cfb.stream(flags & 0x0200 ? "1Table" : "0Table");
	const bad = () => new Error("damaged Word file (no piece table)");
	if (!table) throw bad();
	const lw = 34 + dv.getUint16(32, true) * 2 + 2; // after FibBase and FibRgW: FibRgLw
	const fcs = lw + dv.getUint16(lw - 2, true) * 4 + 2; // then FibRgFcLcb
	const ccpText = dv.getUint32(lw + 12, true);
	const fcClx = dv.getUint32(fcs + 33 * 8, true);
	const lcbClx = dv.getUint32(fcs + 33 * 8 + 4, true);
	if (!lcbClx || fcClx + lcbClx > table.length) throw bad();
	const tv = view(table);
	let o = fcClx;
	while (o < fcClx + lcbClx && table[o] === 1) o += 3 + tv.getInt16(o + 1, true); // property runs before the piece table
	if (table[o] !== 2) throw bad();
	const lcb = tv.getUint32(o + 1, true);
	const plc = o + 5;
	const n = (lcb - 4) / 12;
	if (!Number.isInteger(n) || plc + lcb > table.length) throw bad();
	const parts = [];
	for (let i = 0; i < n; i++) {
		const cp0 = tv.getUint32(plc + i * 4, true);
		const cp1 = Math.min(tv.getUint32(plc + i * 4 + 4, true), ccpText);
		if (cp1 <= cp0) continue;
		const fc = tv.getUint32(plc + (n + 1) * 4 + i * 8 + 2, true);
		if (fc & 0x40000000) { const a = (fc & 0x3fffffff) / 2; parts.push(bytesText(wd.subarray(a, a + cp1 - cp0))); }
		else parts.push(u16le.decode(wd.subarray(fc, fc + (cp1 - cp0) * 2)));
	}
	return wordText(parts.join(""));
}

/** Rows as a Markdown table, like readXlsx: grid is Map(row -> Map(col -> text)), both from 1. */
function gridTable(name, grid, maxC, maxRows) {
	const rows = [...grid.keys()].sort((a, b) => a - b);
	const out = ["", `## ${name} (${rows.length} rows with data)`];
	if (!rows.length) return out;
	const cols = Array.from({ length: Math.min(maxC, 40) }, (_, i) => i + 1);
	out.push(`| row | ${cols.map(colName).join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`);
	for (const r of rows.slice(0, maxRows)) out.push(`| ${r} | ${cols.map((c) => String(grid.get(r).get(c) ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`);
	if (rows.length > maxRows) out.push(`... ${rows.length - maxRows} more rows`);
	return out;
}

/** Strings of the shared string table, which may run on over CONTINUE records (segs). */
function sstStrings(segs) {
	let si = 0;
	let o = 0;
	const next = () => {
		while (si < segs.length && o >= segs[si].length) { si++; o = 0; }
		if (si >= segs.length) throw new Error("end");
	};
	const u8 = () => { next(); return segs[si][o++]; };
	const u16 = () => u8() | (u8() << 8);
	const u32 = () => (u16() | (u16() << 16)) >>> 0;
	const skip = (n) => { while (n > 0) { next(); const k = Math.min(n, segs[si].length - o); o += k; n -= k; } };
	const out = [];
	try {
		skip(4);
		const count = u32();
		for (let i = 0; i < count; i++) {
			const cch = u16();
			const flags = u8();
			const runs = flags & 8 ? u16() : 0;
			const ext = flags & 4 ? u32() : 0;
			let high = flags & 1;
			let s = "";
			for (let left = cch; left > 0;) {
				if (o >= segs[si].length) { // the characters go on in the next record, which starts with a new flags byte
					si++;
					o = 0;
					if (si >= segs.length) throw new Error("end");
					high = segs[si][o++] & 1;
				}
				const seg = segs[si];
				const k = Math.min(left, Math.floor((seg.length - o) / (high ? 2 : 1)));
				s += high ? u16le.decode(seg.subarray(o, o + k * 2)) : bytesText(seg.subarray(o, o + k), false);
				o = k ? o + k * (high ? 2 : 1) : seg.length;
				left -= k;
			}
			skip(runs * 4 + ext);
			out.push(s);
		}
	} catch { /* a short or damaged table: keep what was read */ }
	return out;
}

/** Cell values of an Excel 97-2003 .xls: text, numbers, cached formula results (dates show as numbers). */
export function readXls(cfb, { maxRows = 200 } = {}) {
	const wb = cfb.stream("Workbook");
	if (!wb) throw new Error(cfb.stream("Book") ? "an Excel 5/95 file (older than Excel 97): it cannot be read here; ask the user to save it as .xlsx" : "damaged Excel file");
	const dv = view(wb);
	function* records(from) {
		for (let o = from; o + 4 <= wb.length;) {
			const len = dv.getUint16(o + 2, true);
			yield { type: dv.getUint16(o, true), data: wb.subarray(o + 4, o + 4 + len) };
			o += 4 + len;
		}
	}
	const xlStr = (d, o, cch) => (d[o] & 1 ? u16le.decode(d.subarray(o + 1, o + 1 + cch * 2)) : bytesText(d.subarray(o + 1, o + 1 + cch), false));
	const sheets = [];
	let sstSegs = null;
	let sst = [];
	for (const { type, data } of records(0)) {
		if (type === 0x3c && sstSegs) { sstSegs.push(data); continue; }
		if (sstSegs) { sst = sstStrings(sstSegs); sstSegs = null; }
		if (type === 0x0a) break; // end of the workbook part
		if (type === 0x2f) throw PASSWORD(); // FILEPASS
		if (type === 0x85 && data.length >= 8) sheets.push({ pos: view(data).getUint32(0, true), kind: data[5], name: xlStr(data, 7, data[6]) });
		if (type === 0xfc) sstSegs = [data];
	}
	const rk = (v) => {
		let n;
		if (v & 2) n = v >> 2;
		else { const b = new DataView(new ArrayBuffer(8)); b.setUint32(4, v & 0xfffffffc, true); n = b.getFloat64(0, true); }
		return String(v & 1 ? n / 100 : n);
	};
	const out = [`Sheets: ${sheets.map((s) => s.name).join(", ")}`];
	for (const sh of sheets) {
		if (sh.kind !== 0) continue; // charts, macro sheets
		const grid = new Map();
		let maxC = 0;
		let formula = null;
		const set = (r, c, v) => {
			if (!grid.has(r + 1)) grid.set(r + 1, new Map());
			grid.get(r + 1).set(c + 1, v);
			maxC = Math.max(maxC, c + 1);
		};
		for (const { type, data } of records(sh.pos)) {
			if (type === 0x0a) break;
			if (data.length < (type === 0x207 ? 3 : 6)) continue;
			const d = view(data);
			const r = d.getUint16(0, true);
			const c = data.length >= 4 ? d.getUint16(2, true) : 0;
			if (type === 0xfd && data.length >= 10) set(r, c, sst[d.getUint32(6, true)] ?? "");
			else if (type === 0x203 && data.length >= 14) set(r, c, String(d.getFloat64(6, true)));
			else if (type === 0x27e && data.length >= 10) set(r, c, rk(d.getUint32(6, true)));
			else if (type === 0xbd) for (let i = 0; 6 + i * 6 + 6 <= data.length; i++) set(r, c + i, rk(d.getUint32(6 + i * 6, true)));
			else if (type === 0x06 && data.length >= 14) {
				if (d.getUint16(12, true) !== 0xffff) set(r, c, String(d.getFloat64(6, true)));
				else if (data[6] === 0) formula = [r, c]; // text result: in the STRING record that follows
				else if (data[6] === 1) set(r, c, data[8] ? "TRUE" : "FALSE");
			} else if (type === 0x207 && formula) { set(...formula, xlStr(data, 2, d.getUint16(0, true))); formula = null; }
			else if (type === 0x204 && data.length >= 9) set(r, c, xlStr(data, 8, d.getUint16(6, true)));
			else if (type === 0x205 && data.length >= 8 && !data[7]) set(r, c, data[6] ? "TRUE" : "FALSE");
		}
		out.push(...gridTable(sh.name, grid, maxC, maxRows));
	}
	return out.join("\n");
}

/** Text of a PowerPoint 97-2003 .ppt, slide by slide (found through the file's own index of its records). */
export function readPpt(cfb) {
	const doc = cfb.stream("PowerPoint Document");
	if (!doc) throw new Error("damaged PowerPoint file");
	const cu = cfb.stream("Current User");
	if (cu?.length >= 20 && view(cu).getUint32(12, true) === 0xf3d1c4df) throw PASSWORD();
	const dv = view(doc);
	const u32 = (o) => (o + 4 <= doc.length ? dv.getUint32(o, true) : 0);
	const hdr = (o) => (o + 8 <= doc.length ? { ver: dv.getUint16(o, true) & 0xf, inst: dv.getUint16(o, true) >> 4, type: dv.getUint16(o + 2, true), len: dv.getUint32(o + 4, true) } : null);
	const atom = (h, a) => {
		const b = Math.min(a + h.len, doc.length);
		const t = h.type === 0x0fa0 ? u16le.decode(doc.subarray(a, b)) : h.type === 0x0fa8 ? bytesText(doc.subarray(a, b)) : null;
		return t?.replace(/[\r\v]/g, "\n").replace(/[\x00-\x08\x0e-\x1f]/g, "").trim() || null;
	};
	// every text atom between from and to, inside containers too; masters and notes are left out
	const walk = (from, to, push, skip = new Set([0x03f8, 0x03f0, 0x0fc9])) => {
		for (let o = from, h; (h = hdr(o)) && o + 8 <= to; o += 8 + h.len) {
			if (h.ver === 0xf) { if (!skip.has(h.type) && !(h.type === 0x0ff0 && h.inst)) walk(o + 8, Math.min(o + 8 + h.len, to), push, skip); }
			else { const t = atom(h, o + 8); if (t) push(t); }
		}
	};
	const slides = [];
	try {
		const persist = new Map(); // object id -> where it is, newest edit first
		let docRef = 0;
		for (let e = cu?.length >= 20 ? view(cu).getUint32(16, true) : 0, n = 0; n < 1000; n++) { // edits, newest first
			const h = hdr(e);
			if (h?.type !== 0x0ff5) break;
			if (!n) docRef = u32(e + 8 + 16);
			const d = u32(e + 8 + 12);
			const dh = hdr(d);
			for (let p = d + 8; dh && p < d + 8 + dh.len;) {
				const x = u32(p);
				for (let i = 0; i < x >>> 20; i++) if (!persist.has((x & 0xfffff) + i)) persist.set((x & 0xfffff) + i, u32(p + 4 + i * 4));
				p += 4 + (x >>> 20) * 4;
			}
			if (!u32(e + 8 + 8)) break;
			e = u32(e + 8 + 8);
		}
		const docOff = persist.get(docRef);
		const dh = docOff !== undefined && hdr(docOff);
		for (let o = docOff + 8, h; dh && (h = hdr(o)) && o < docOff + 8 + dh.len; o += 8 + h.len) {
			if (h.type !== 0x0ff0 || h.inst !== 0) continue; // the list of slides with their outline text
			for (let a = o + 8, ah; (ah = hdr(a)) && a < o + 8 + h.len; a += 8 + ah.len) {
				if (ah.type === 0x03f3) slides.push({ ref: u32(a + 8), text: [] });
				else if (slides.length) { const t = atom(ah, a + 8); if (t) slides.at(-1).text.push(t); }
			}
		}
		for (const s of slides) { // text boxes drawn on the slide itself
			const at = persist.get(s.ref);
			const h = at !== undefined && hdr(at);
			if (h?.type === 0x03ee) walk(at + 8, at + 8 + h.len, (t) => s.text.push(t));
		}
	} catch { /* fall back to reading the records in order */ }
	if (!slides.some((s) => s.text.length)) {
		const all = [];
		walk(0, doc.length, (t) => all.push(t));
		return all.join("\n");
	}
	return slides.map((s, i) => `## Slide ${i + 1}\n${s.text.join("\n")}`).join("\n\n");
}

// ---------- any file, by what it is ----------

const KINDS = {
	docx: ["Word .docx", /\.(docx|docm|dotx|dotm)$/i], xlsx: ["Excel .xlsx", /\.(xlsx|xlsm|xltx|xltm)$/i],
	pptx: ["PowerPoint .pptx", /\.(pptx|pptm|potx|ppsx)$/i], pdf: ["PDF", /\.pdf$/i], doc: ["Word 97-2003 .doc", /\.(doc|dot)$/i],
	xls: ["Excel 97-2003 .xls", /\.(xls|xlt)$/i], ppt: ["PowerPoint 97-2003 .ppt", /\.(ppt|pps|pot)$/i],
};

/** What the first bytes say: zip (a .docx/.xlsx/.pptx), ole (.doc/.xls/.ppt), pdf, rtf, html, or unknown. */
export function sniffOffice(buf) {
	if (buf[0] === 0x50 && buf[1] === 0x4b) return "zip";
	if ([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => buf[i] === b)) return "ole";
	const head = Buffer.from(buf.subarray(0, 1024)).toString("latin1");
	if (head.includes("%PDF-")) return "pdf";
	if (head.startsWith("{\\rtf")) return "rtf";
	if (/^(﻿|\xef\xbb\xbf)?\s*(<\?xml|<!doctype|<html|MIME-Version)/i.test(head)) return "html";
	return "unknown";
}

const OTHER = {
	rtf: "an RTF file (text with formatting codes), not a binary Word file: read it with read",
	html: "a web page or XML file saved under an Office name: read it with read",
	unknown: "not an Office or PDF file (judged by its content): use read for text files",
};

/** Text of a Word, Excel, PowerPoint (new or old format) or PDF file, judged by its content, not its name.
 * full: the whole file (batch mode); otherwise the usual limits (Excel 200 rows and 5 sheets, PDF pages). */
export async function readOffice(path, p = {}, { full = false } = {}) {
	const buf = readFileSync(path);
	const kind = sniffOffice(buf);
	let what;
	let text;
	if (kind === "zip") {
		const names = [];
		try {
			unzipSync(buf, { filter: (f) => { names.push(f.name); return false; } });
		} catch (e) {
			throw new Error(`damaged or incomplete file (zip: ${e.message})`);
		}
		const has = (n) => names.includes(n);
		if (has("word/document.xml")) [what, text] = ["docx", readDocx(buf, { revisions: p.revisions })];
		else if (has("xl/workbook.xml")) [what, text] = ["xlsx", readXlsx(buf, full ? { maxRows: Infinity, maxSheets: Infinity } : p)];
		else if (has("ppt/presentation.xml")) [what, text] = ["pptx", readPptx(buf)];
		else throw new Error("a zip file, not a Word, Excel or PowerPoint document");
	} else if (kind === "pdf") [what, text] = ["pdf", await readPdf(buf, full ? undefined : p.pages)];
	else if (kind === "ole") {
		const cfb = readCfb(buf);
		if (cfb.names.some((n) => /DRM/i.test(n))) throw IRM();
		if (cfb.names.includes("EncryptedPackage") || cfb.names.includes("EncryptionInfo")) throw PASSWORD();
		if (cfb.stream("WordDocument")) [what, text] = ["doc", readDoc(cfb)];
		else if (cfb.stream("Workbook") || cfb.stream("Book")) [what, text] = ["xls", readXls(cfb, { maxRows: full ? Infinity : 200 })];
		else if (cfb.stream("PowerPoint Document")) [what, text] = ["ppt", readPpt(cfb)];
		else throw new Error(`an OLE compound file with no Word, Excel or PowerPoint document inside (it holds: ${cfb.names.slice(0, 8).join(", ")})`);
	} else throw new Error(OTHER[kind]);
	const [label, ext] = KINDS[what];
	return ext.test(path) ? text : `(${basename(path)} is really a ${label} file; read as that)\n\n${text}`;
}

// ---------- many files at once ----------

const INPUT_EXT = /\.(docx?|docm|dot[xm]?|xlsx?|xlsm|xlt[xm]?|pptx?|pptm|pps[xm]?|pot[xm]?|pdf)$/i;
const hasGlob = (s) => /[*?{]/.test(s);

function globRegex(pattern) {
	let re = "";
	let braces = 0;
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*" && pattern[i + 1] === "*") {
			i++;
			if (pattern[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
		} else if (c === "*") re += "[^/]*";
		else if (c === "?") re += "[^/]";
		else if (c === "{") { braces++; re += "(?:"; }
		else if (c === "}" && braces) { braces--; re += ")"; }
		else if (c === "," && braces) re += "|";
		else re += c.replace(/[.+^$()|\\[\]{}]/g, "\\$&");
	}
	return new RegExp(`^${re}$`, "i");
}

/** The files a batch reads: a folder gives its Office/PDF files (all subfolders), a glob every file it matches. */
export function batchInputs(cwd, path, outDir) {
	const norm = String(path).replace(/\\/g, "/");
	let base;
	let want;
	const glob = hasGlob(norm);
	if (glob) {
		const segs = norm.split("/");
		const k = segs.findIndex(hasGlob);
		base = resolve(cwd, segs.slice(0, k).join("/") || (norm.startsWith("/") ? "/" : "."));
		const rx = globRegex(segs.slice(k).join("/"));
		want = (rel) => rx.test(rel);
	} else {
		base = resolve(cwd, norm);
		if (!statSync(base).isDirectory()) return { base: dirname(base), files: [base], skipped: 0 };
		want = (rel) => INPUT_EXT.test(rel);
	}
	const files = [];
	let skipped = 0;
	const walk = (dir) => {
		let list;
		try { list = readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const d of list) {
			const full = join(dir, d.name);
			if (d.isDirectory()) { if (full !== outDir) walk(full); continue; }
			if (!d.isFile()) continue;
			if (!want(relative(base, full).replace(/\\/g, "/"))) { if (!glob) skipped++; }
			else if (d.name.startsWith("~$")) skipped++; // Office's lock file for a document someone has open
			else files.push(full);
		}
	};
	walk(base);
	return { base, files: files.sort(), skipped };
}

/** Convert many files to .txt under out (same relative paths); returns a short summary for the agent. */
export async function convertBatch(cwd, path, out, { signal, onProgress } = {}) {
	const outDir = resolve(cwd, out);
	const { base, files, skipped } = batchInputs(cwd, path, outDir);
	if (!files.length) throw new Error(`No Office or PDF files found in ${path}`);
	let ok = 0;
	const empty = [];
	const enc = [];
	const failed = [];
	let done = 0;
	for (const f of files) {
		if (signal?.aborted) break;
		const rel = relative(base, f).replace(/\\/g, "/");
		try {
			const text = await readOffice(f, {}, { full: true });
			const dest = join(outDir, `${rel}.txt`);
			mkdirSync(dirname(dest), { recursive: true });
			writeFileSync(dest, `${text}\n`);
			ok++;
			if (!text.replace(/^\d+ pages$|^--- page \d+ ---$|^\(.* is really a .* file; read as that\)$/gm, "").trim()) empty.push(rel);
		} catch (e) {
			if (e.code === "ENCRYPTED") enc.push(`- ${rel}: ${e.short}`);
			else failed.push(`- ${rel}: ${String(e.message).split("\n")[0].slice(0, 200)}`);
		}
		if (++done % 10 === 0) onProgress?.(`${done}/${files.length} files`);
	}
	const list = (a) => (a.length > 100 ? [...a.slice(0, 100), `... ${a.length - 100} more`] : a);
	const lines = [
		`${done < files.length ? `Stopped after ${done} of ${files.length} files. ` : ""}Text files are in ${outDir} (each file as <its relative path>.txt).`,
		`ok ${ok}, encrypted ${enc.length}, failed ${failed.length}, skipped ${skipped} (not Office/PDF, or ~$ lock files)`,
	];
	if (enc.length) lines.push("", "Encrypted: cannot be read without the owner; tell the user, do not try other ways:", ...list(enc));
	if (failed.length) lines.push("", "Failed:", ...list(failed));
	if (empty.length) lines.push("", `No text (scanned or pictures only?): ${list(empty).join(", ")}`);
	lines.push("", "Next: grep or read the .txt files you need.");
	return lines.join("\n");
}

// ---------- new files ----------

/** A simple .docx from Markdown: headings (#), paragraphs, bullet lists (- ), tables (| a | b |), **bold**, *italic*. */
export function createDocx(path, markdown) {
	const inline = (s) => s.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/).filter(Boolean).map((part) => {
		if (/^\*\*.*\*\*$/.test(part)) return `<w:r><w:rPr><w:b/></w:rPr>${tEl(part.slice(2, -2))}</w:r>`;
		if (/^\*.*\*$/.test(part)) return `<w:r><w:rPr><w:i/></w:rPr>${tEl(part.slice(1, -1))}</w:r>`;
		return `<w:r>${tEl(part)}</w:r>`;
	}).join("");
	const body = [];
	const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		if (/^\s*\|/.test(l)) {
			const rows = [];
			while (i < lines.length && /^\s*\|/.test(lines[i])) {
				if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
				i++;
			}
			i--;
			const n = Math.max(...rows.map((r) => r.length));
			const border = '<w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders>';
			body.push(`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${border}</w:tblPr><w:tblGrid>${"<w:gridCol/>".repeat(n)}</w:tblGrid>${rows.map((r, ri) =>
				`<w:tr>${Array.from({ length: n }, (_, c) => `<w:tc><w:p>${ri === 0 ? inline(`**${r[c] ?? ""}**`.replace(/^\*\*\*\*$/, "")) : inline(r[c] ?? "")}</w:p></w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`);
			continue;
		}
		const h = /^(#{1,6})\s+(.*)$/.exec(l);
		if (h) body.push(`<w:p><w:pPr><w:pStyle w:val="Heading${h[1].length}"/></w:pPr>${inline(h[2])}</w:p>`);
		else if (/^\s*[-*]\s+/.test(l)) body.push(`<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr>${inline(`• ${l.replace(/^\s*[-*]\s+/, "")}`)}</w:p>`);
		else if (l.trim()) body.push(`<w:p>${inline(l)}</w:p>`);
	}
	const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
	const heading = (n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${[32, 28, 26, 24, 22, 22][n - 1]}"/></w:rPr></w:style>`;
	const files = {
		"[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
		"_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
		"word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
		"word/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/><w:sz w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${[1, 2, 3, 4, 5, 6].map(heading).join("")}<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr></w:style></w:styles>`,
		"word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
	};
	writeFileSync(path, zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
}

/** A simple .xlsx: sheets { name: [[...row], ...] } (numbers stay numbers, "=..." becomes a formula). */
export function createXlsx(path, sheets) {
	const names = Object.keys(sheets);
	if (!names.length) throw new Error("No sheets");
	const cell = (v, ref) => (v === null || v === undefined || v === "" ? ""
		: typeof v === "number" || /^-?\d+(\.\d+)?$/.test(String(v)) ? `<c r="${ref}"><v>${v}</v></c>`
			: String(v).startsWith("=") ? `<c r="${ref}"><f>${esc(String(v).slice(1))}</f></c>`
				: `<c r="${ref}" t="inlineStr"><is>${tEl(String(v)).replace(/w:t/g, "t")}</is></c>`);
	const files = {
		"[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
		"_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
		"xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
		"xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n).replace(/"/g, "&quot;")}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr fullCalcOnLoad="1"/></workbook>`,
	};
	names.forEach((n, i) => {
		const rows = sheets[n] ?? [];
		files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, ri) =>
			`<row r="${ri + 1}">${(r ?? []).map((v, ci) => cell(v, `${colName(ci + 1)}${ri + 1}`)).join("")}</row>`).join("")}</sheetData></worksheet>`;
	});
	writeFileSync(path, zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
}

// ---------- tools ----------

const cut = (s) => (s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n...(cut at ${MAX_OUT / 1000}k characters: ask for fewer pages, a sheet or a range)` : s);

export function createOffice() {
	return (pi) => {
		pi.registerTool({
			name: "office_read",
			label: "Read Office/PDF",
			description: "Read Word, Excel, PowerPoint or PDF files as text, without Office: .docx and old .doc, .xlsx and " +
				"old .xls, .pptx and old .ppt, .pdf. The format is judged by the file's content, so a file with the wrong " +
				"extension is still read. Word: headings, lists and tables as Markdown, tracked changes as {+inserted+} " +
				"{-deleted-} and comments listed at the end. Excel: sheets as tables with row numbers and column letters " +
				"(sheet, range, formulas). PDF: text per page (pages: \"3-7\"). Use this instead of read for these files.\n" +
				"Many files (more than a few): give a folder or a glob as path (\"D:/docs\" or \"D:/docs/**/*.doc*\") and out " +
				"(a folder): every file becomes a .txt under out with the same relative path, and you get back only a summary " +
				"(ok / failed / encrypted counts, failed files with reasons); then grep or read the .txt files. Do not write " +
				"python scripts for this.\nNever drive Word, Excel or PowerPoint with COM automation (win32com, " +
				"New-Object -ComObject): many company PCs block it. Encrypted (IRM or password) files cannot be read by any " +
				"tool: tell the user.",
			promptSnippet: "Read Word, Excel, PowerPoint and PDF files, old formats too, one file or a whole folder into .txt files",
			parameters: Type.Object({
				path: Type.String({ description: "A file; or, with out, a folder or a glob" }),
				out: Type.Optional(Type.String({ description: "Batch: folder for the .txt files (one per file read)" })),
				sheet: Type.Optional(Type.String({ description: "Excel: one sheet by name" })),
				range: Type.Optional(Type.String({ description: "Excel: e.g. A1:H50" })),
				formulas: Type.Optional(Type.Boolean({ description: "Excel: show formulas instead of values" })),
				pages: Type.Optional(Type.String({ description: "PDF: e.g. 5 or 3-7" })),
				revisions: Type.Optional(Type.String({ description: "Word: show (default, marks tracked changes) or accepted (as if all were accepted)" })),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
			async execute(_id, p, signal, onUpdate, ctx) {
				const cwd = ctx?.cwd ?? process.cwd();
				if (p.out) {
					const summary = await convertBatch(cwd, p.path, p.out, {
						signal, onProgress: (s) => onUpdate?.({ content: [{ type: "text", text: `office_read: ${s}` }], details: {} }),
					});
					return { content: [{ type: "text", text: summary }], details: undefined };
				}
				const path = resolve(cwd, p.path);
				if (hasGlob(p.path) || statSync(path).isDirectory()) {
					throw new Error(`${p.path} is ${hasGlob(p.path) ? "a glob" : "a folder"}: to read many files, call office_read again with ` +
						"out (a folder for the text files, e.g. out: \"office-text\"). Each file becomes a .txt there and you get a summary back.");
				}
				const text = await readOffice(path, p);
				return { content: [{ type: "text", text: wrapExternal(`file:${path}`, cut(text)) }], details: undefined };
			},
		});

		pi.registerTool({
			name: "office_edit",
			label: "Edit Office",
			description: "Change a Word or Excel file in place, keeping its formatting. Word: replace text, by default as tracked " +
				"changes (like a 3GPP change request: the reader sees what was deleted and inserted); find must be inside one " +
				"paragraph and unique unless all: true. Excel: set cells (numbers, text, or formulas starting with =). " +
				"Read the file with office_read first. To make a new file use office_create.",
			promptSnippet: "Change Word text as tracked changes, or Excel cells, keeping the formatting",
			parameters: Type.Object({
				path: Type.String(),
				edits: Type.Optional(Type.Array(Type.Object({
					find: Type.String(), replace: Type.String({ description: "Empty to delete" }),
					all: Type.Optional(Type.Boolean()),
				}), { description: "Word: text replacements" })),
				track: Type.Optional(Type.Boolean({ description: "Word: tracked changes (default true)" })),
				author: Type.Optional(Type.String({ description: "Word: name on the tracked changes (default Ferry)" })),
				cells: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
					{ description: "Excel: { \"B3\": 42, \"C3\": \"text\", \"D3\": \"=SUM(B1:B3)\" }" })),
				sheet: Type.Optional(Type.String({ description: "Excel: sheet name (default the first)" })),
			}),
			async execute(_id, p, _signal, _onUpdate, ctx) {
				const path = resolve(ctx?.cwd ?? process.cwd(), p.path);
				const ext = extname(path).toLowerCase();
				if (ext === ".docx" || ext === ".docm") {
					if (!p.edits?.length) throw new Error("Word: give edits");
					const r = editDocx(path, p.edits, { track: p.track !== false, author: p.author || "Ferry" });
					const lines = r.map((x) => `"${x.find}": ${x.replaced} replaced${x.skipped ? `, ${x.skipped} skipped (a field or picture inside; change it in Word)` : ""}`);
					return { content: [{ type: "text", text: `${p.track !== false ? "Tracked changes" : "Changes"} saved in ${path}\n${lines.join("\n")}` }], details: undefined };
				}
				if (ext === ".xlsx" || ext === ".xlsm") {
					if (!p.cells || !Object.keys(p.cells).length) throw new Error("Excel: give cells");
					const n = editXlsx(path, p.cells, { sheet: p.sheet });
					return { content: [{ type: "text", text: `${n} cell(s) set in ${path}${p.sheet ? ` (${p.sheet})` : ""}; formulas are recalculated when Excel opens it.` }], details: undefined };
				}
				throw new Error("office_edit changes .docx and .xlsx files");
			},
		});

		pi.registerTool({
			name: "office_create",
			label: "New Office file",
			description: "Create a new Word file from Markdown (headings, paragraphs, bullet lists, tables, bold, italic) or a " +
				"new Excel file from rows ({ \"Sheet1\": [[\"Name\", \"Qty\"], [\"A\", 3]] }; \"=...\" is a formula).",
			promptSnippet: "Create a Word file from Markdown or an Excel file from rows",
			parameters: Type.Object({
				path: Type.String({ description: "Ends with .docx or .xlsx" }),
				markdown: Type.Optional(Type.String({ description: "Word: the content" })),
				sheets: Type.Optional(Type.Record(Type.String(), Type.Array(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]))),
					{ description: "Excel: sheet name -> rows" })),
			}),
			async execute(_id, p, _signal, _onUpdate, ctx) {
				const path = resolve(ctx?.cwd ?? process.cwd(), p.path);
				const ext = extname(path).toLowerCase();
				if (ext === ".docx") createDocx(path, p.markdown ?? "");
				else if (ext === ".xlsx") createXlsx(path, p.sheets ?? {});
				else throw new Error("office_create makes .docx or .xlsx");
				return { content: [{ type: "text", text: `Created ${path}` }], details: undefined };
			},
		});
	};
}
