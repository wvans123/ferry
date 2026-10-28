import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDocx, createXlsx, editDocx, editXlsx, readDocx, readPdf, readXlsx } from "../lib/office.mjs";

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

test("PDF: text per page", async () => {
	const stream = "BT /F1 18 Tf 72 720 Td (Hello Ferry PDF) Tj ET";
	const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
	let pdf = "%PDF-1.4\n";
	const offs = objs.map((o, i) => { const at = pdf.length; pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
	const xref = pdf.length;
	pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
	const f = join(dir, "a.pdf");
	writeFileSync(f, pdf, "latin1");
	const t = await readPdf(f);
	assert.match(t, /1 pages/);
	assert.match(t, /Hello Ferry PDF/);
});
