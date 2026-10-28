// Office files without Office: read Word (with tracked changes and comments), Excel, PowerPoint and PDF; change Word
// text as tracked changes and Excel cells; create Word and Excel files. Works on the files themselves, so nothing
// needs to be installed and no window on the screen is touched. A .docx/.xlsx/.pptx is a zip of XML files.
import { readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { Type } from "typebox";

const MAX_OUT = 60_000;

const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
	.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
	.replace(/&amp;/g, "&");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

function openZip(path) {
	const files = unzipSync(readFileSync(path));
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

export function readXlsx(path, { sheet, range, formulas = false, maxRows = 200 } = {}) {
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
	for (const s of pick.slice(0, sheet ? 1 : 5)) {
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
	const pdf = await getDocumentProxy(new Uint8Array(readFileSync(path)));
	const { text } = await extractText(pdf, { mergePages: false });
	let [a, b] = [1, text.length];
	if (pages) {
		const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(String(pages).trim());
		if (m) [a, b] = [+m[1], +(m[2] ?? m[1])];
	}
	return `${text.length} pages\n\n${text.slice(a - 1, b).map((t, i) => `--- page ${a + i} ---\n${t}`).join("\n\n")}`;
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
			description: "Read a Word (.docx), Excel (.xlsx), PowerPoint (.pptx) or PDF file as text. Word: headings, lists and " +
				"tables as Markdown, tracked changes as {+inserted+} {-deleted-} and comments listed at the end. Excel: sheets " +
				"as tables with row numbers and column letters (sheet, range, formulas). PDF: text per page (pages: \"3-7\"). " +
				"Use this instead of read for these files.",
			promptSnippet: "Read Word, Excel, PowerPoint and PDF files (with tracked changes and comments)",
			parameters: Type.Object({
				path: Type.String(),
				sheet: Type.Optional(Type.String({ description: "Excel: one sheet by name" })),
				range: Type.Optional(Type.String({ description: "Excel: e.g. A1:H50" })),
				formulas: Type.Optional(Type.Boolean({ description: "Excel: show formulas instead of values" })),
				pages: Type.Optional(Type.String({ description: "PDF: e.g. 5 or 3-7" })),
				revisions: Type.Optional(Type.String({ description: "Word: show (default, marks tracked changes) or accepted (as if all were accepted)" })),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
			async execute(_id, p, _signal, _onUpdate, ctx) {
				const path = resolve(ctx?.cwd ?? process.cwd(), p.path);
				const ext = extname(path).toLowerCase();
				let text;
				if (ext === ".docx" || ext === ".docm") text = readDocx(path, { revisions: p.revisions });
				else if (ext === ".xlsx" || ext === ".xlsm") text = readXlsx(path, { sheet: p.sheet, range: p.range, formulas: p.formulas });
				else if (ext === ".pptx") text = readPptx(path);
				else if (ext === ".pdf") text = await readPdf(path, p.pages);
				else if (ext === ".doc" || ext === ".xls" || ext === ".ppt") throw new Error(`${ext} is the old binary format: save it as ${ext}x in Office first`);
				else throw new Error("office_read reads .docx, .xlsx, .pptx and .pdf; use read for other files");
				return { content: [{ type: "text", text: cut(text) }], details: undefined };
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
