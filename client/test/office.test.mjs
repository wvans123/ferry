import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { convertBatch, createDocx, createOffice, createXlsx, editDocx, editXlsx, readDocx, readOffice, readPdf, readXlsx } from "../lib/office.mjs";

const dir = mkdtempSync(join(tmpdir(), "ferry-office-"));

test("Word: create, read, and replace text as tracked changes across runs", () => {
	const f = join(dir, "cr.docx");
	createDocx(f, "# Change request\n\nThe UE shall send **the report** every 10 s.\n\n- first item\n\n| Clause | Change |\n|---|---|\n| 5.2 | new |");
	const before = readDocx(f);
	assert.match(before, /^# Change request/m);
	assert.match(before, /The UE shall send the report every 10 s\./);
	assert.match(before, /\| 5\.2 \| new \|/);
	const r = editDocx(f, [{ find: "the report every 10", replace: "a report every 20" }]);
	assert.deepEqual(r, [{ find: "the report every 10", replaced: 1, skipped: 0 }]);
	const after = readDocx(f);
	assert.match(after, /tracked changes/);
	assert.match(after, /The UE shall send \{-the report every 10-\}\{\+a report every 20\+\} s\./);
	assert.match(readDocx(f, { revisions: "accepted" }), /The UE shall send a report every 20 s\./);
	assert.throws(() => editDocx(f, [{ find: "not there", replace: "x" }]), /Not found/);
});

test("Excel: create, set cells keeping the rest, read values and formulas", () => {
	const f = join(dir, "t.xlsx");
	createXlsx(f, { Budget: [["Item", "Cost"], ["A", 10], ["B", 20]], Notes: [["hello"]] });
	editXlsx(f, { B3: 25, A4: "Total", B4: "=SUM(B2:B3)", D1: "new col" }, { sheet: "Budget" });
	const v = readXlsx(f, { sheet: "Budget" });
	assert.match(v, /Sheets: Budget, Notes/);
	assert.match(v, /\| 3 \| B \| 25 \|/);
	assert.match(v, /\| 4 \| Total \|  \|/);
	assert.match(v, /\| 1 \| Item \| Cost \|  \| new col \|/);
	assert.match(readXlsx(f, { sheet: "Budget", formulas: true, range: "A4:B4" }), /\| 4 \| Total \| =SUM\(B2:B3\) \|/);
	assert.match(readXlsx(f, { sheet: "Notes" }), /hello/);
});

/** A one-page PDF with one line of text. */
function makePdf(text, extraOps = "") {
	const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET${extraOps}`;
	const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
	let pdf = "%PDF-1.4\n";
	const offs = objs.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
	const xref = pdf.length;
	pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
	return pdf;
}

test("PDF: text per page", async () => {
	const pdf = makePdf("Hello Ferry PDF");
	const f = join(dir, "a.pdf");
	writeFileSync(f, pdf, "latin1");
	const t = await readPdf(f);
	assert.match(t, /1 pages/);
	assert.match(t, /Hello Ferry PDF/);
});

test("PDF: pdf.js warnings are not printed", async () => {
	// An unknown operator makes pdf.js warn while it renders/parses the page; extractText parses the stream.
	const f = join(dir, "warn.pdf");
	writeFileSync(f, makePdf("Quiet PDF", "\n1 2 3 zzz\n"), "latin1");
	const seen = [];
	const orig = { log: console.log, warn: console.warn };
	console.log = console.warn = (...a) => seen.push(a.join(" "));
	let t;
	try { t = await readPdf(f); } finally { Object.assign(console, orig); }
	assert.match(t, /Quiet PDF/);
	assert.deepEqual(seen, []);
});

// Old binary files. The fixtures were made with LibreOffice from made-up text and repacked to keep only the streams
// the readers use; compressed.doc has its text turned into 1-byte (cp1252) form with a field code put in;
// irm-protected.docx and password.docx carry only the stream names of encrypted files, with dummy bytes.
const FIX = join(import.meta.dirname, "fixtures");

test("old .doc: text through the piece table, 2-byte and 1-byte pieces, field codes dropped", async () => {
	const t = await readOffice(join(FIX, "memo.doc"));
	assert.match(t, /^Ferry test memo\nThe relay keeps every upload under 1 MB\.\n渡船测试：旧版 Word 文件也能读。/);
	assert.match(t, /Item\tOwner\nRelay\tAlice\nClient\tBob\nLast line of the memo\.$/);
	assert.equal(await readOffice(join(FIX, "compressed.doc")), "Plain ASCII memo\nCafe: 5 euro, quotes “like this”.\nSecond paragraph.");
});

test("old .xls and .ppt: cell values and slide text", async () => {
	const x = await readOffice(join(FIX, "budget.xls"));
	assert.match(x, /Sheets: Budget, Notes/);
	assert.match(x, /\| 3 \| Client \| 80\.5 \|/);
	assert.match(x, /\| 4 \| 预算 \| -3 \|/);
	assert.match(x, /\| 1 \| hello sheet two \|/);
	assert.equal(await readOffice(join(FIX, "slides.ppt")), "## Slide 1\nFerry slide one\nRelay keeps uploads small\n\n## Slide 2\n第二页：旧版幻灯片");
});

test("format by content: a .docx that is an old .doc, IRM and password files, other files", async () => {
	const f = join(dir, "really-old.docx");
	copyFileSync(join(FIX, "memo.doc"), f);
	assert.match(await readOffice(f), /^\(really-old\.docx is really a Word 97-2003 \.doc file; read as that\)\n\nFerry test memo/);
	await assert.rejects(readOffice(join(FIX, "irm-protected.docx")), (e) => e.code === "ENCRYPTED" && /rights management \(IRM\)/.test(e.message) && /tell the user/.test(e.message));
	await assert.rejects(readOffice(join(FIX, "password.docx")), (e) => e.code === "ENCRYPTED" && /password/.test(e.message));
	const txt = join(dir, "notes.doc");
	writeFileSync(txt, "just text");
	await assert.rejects(readOffice(txt), /not an Office or PDF file/);
	const pdf = join(dir, "paper.docx");
	writeFileSync(pdf, makePdf("Disguised PDF"), "latin1");
	assert.match(await readOffice(pdf), /really a PDF file[\s\S]*Disguised PDF/);
});

test("batch: a folder into .txt files, with a summary of what failed", async () => {
	const src = join(dir, "batch");
	mkdirSync(join(src, "sub"), { recursive: true });
	createDocx(join(src, "a.docx"), "# Alpha\n\nFirst document.");
	copyFileSync(join(FIX, "memo.doc"), join(src, "sub", "memo.doc"));
	copyFileSync(join(FIX, "irm-protected.docx"), join(src, "sub", "locked.docx"));
	writeFileSync(join(src, "paper.pdf"), makePdf("Batch PDF"), "latin1");
	writeFileSync(join(src, "broken.docx"), "PK\x03\x04 not really a zip");
	writeFileSync(join(src, "~$a.docx"), "lock");
	writeFileSync(join(src, "readme.txt"), "not office");
	const out = join(dir, "batch-txt");
	const s = await convertBatch(dir, "batch", "batch-txt");
	assert.match(s, /ok 3, encrypted 1, failed 1, skipped 2/);
	assert.match(s, /- sub\/locked\.docx: rights management \(IRM\)/);
	assert.match(s, /- broken\.docx: damaged or incomplete file/);
	assert.match(readFileSync(join(out, "a.docx.txt"), "utf8"), /# Alpha\nFirst document\./);
	assert.match(readFileSync(join(out, "sub", "memo.doc.txt"), "utf8"), /渡船测试/);
	assert.match(readFileSync(join(out, "paper.pdf.txt"), "utf8"), /Batch PDF/);
	assert.ok(!existsSync(join(out, "broken.docx.txt")));
	// a glob picks files by name; an out folder inside the input folder is left alone on the next run
	const g = await convertBatch(src, "**/*.doc*", "txt");
	assert.match(g, /ok 2, encrypted 1, failed 1, skipped 1/);
	assert.ok(existsSync(join(src, "txt", "sub", "memo.doc.txt")));
	assert.match(await convertBatch(src, "**/*.doc*", "txt"), /ok 2, encrypted 1, failed 1, skipped 1/);
});

test("office_read tool: one file, a folder without out, a folder with out", async () => {
	const tools = {};
	createOffice()({ registerTool: (t) => { tools[t.name] = t; } });
	const run = (p) => tools.office_read.execute("1", p, undefined, undefined, { cwd: dir });
	assert.match((await run({ path: "batch/sub/memo.doc" })).content[0].text, /Ferry test memo/);
	await assert.rejects(run({ path: "batch" }), /is a folder: .*out/);
	await assert.rejects(run({ path: "batch/*.docx" }), /is a glob: .*out/);
	assert.match((await run({ path: "batch/*.docx", out: "tool-txt" })).content[0].text, /ok 1, encrypted 0, failed 1, skipped 1/);
	assert.match(tools.office_read.description, /COM automation/);
});
