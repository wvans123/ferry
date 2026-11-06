import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createOffice, editDocx, readDocx } from "../lib/office.mjs";
import { checkDocx, initialsOf, parseXml, xml } from "../lib/wordedit.mjs";

const dir = mkdtempSync(join(tmpdir(), "ferry-wordedit-"));
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A small .docx made in memory: body XML, plus extra parts. */
function docx(name, body, extra = {}) {
	const f = join(dir, name);
	const files = {
		"[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
		"_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
		"word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
		...extra,
	};
	writeFileSync(f, zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
	return f;
}
const part = (f, n = "word/document.xml") => { const b = unzipSync(readFileSync(f))[n]; return b ? strFromU8(b) : ""; };
const nestedIns = (x) => /<w:ins\b[^>]*[^/]>(?:(?!<\/w:ins>)[\s\S])*?<w:ins\b[^>]*[^/]>/.test(x);
const p = (text, attrs = "") => `<w:p${attrs}><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const ALICE = 'w:author="Alice" w:date="2026-01-02T00:00:00Z"';

test("editing inside someone else's insertion does not nest w:ins", () => {
	const f = docx("nested.docx", `<w:p><w:r><w:t xml:space="preserve">The UE </w:t></w:r><w:ins w:id="1" ${ALICE}><w:r><w:rPr><w:b/></w:rPr><w:t>shall send the report</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> often.</w:t></w:r></w:p>`);
	editDocx(f, [{ find: "send the report", replace: "send a short report" }], { author: "Bob" });
	const x = part(f);
	assert.ok(!nestedIns(x), x);
	assert.match(readDocx(f), /The UE \{\+shall \+\}\{-send the report-\}\{\+send a short report\+\} often\./);
	assert.match(readDocx(f, { revisions: "accepted" }), /The UE shall send a short report often\./);
	// Alice's insertion is split around Bob's: her deleted words stay inside her insertion, as Word writes them
	assert.match(x, /<w:ins w:id="1" w:author="Alice"[^>]*><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">shall <\/w:t><\/w:r><w:del [^>]*w:author="Bob"[^>]*><w:r><w:rPr><w:b\/><\/w:rPr><w:delText>send the report<\/w:delText><\/w:r><\/w:del><\/w:ins><w:ins [^>]*w:author="Bob"/);
});

test("an edit across the end of someone else's insertion, a deletion inside it, and an edit of this call's own insertion", () => {
	const f = docx("across.docx", `<w:p><w:ins w:id="1" ${ALICE}><w:r><w:t xml:space="preserve">alpha beta </w:t></w:r></w:ins><w:r><w:t>gamma delta</w:t></w:r></w:p>`);
	editDocx(f, [{ find: "beta gamma", replace: "BG" }, { find: "alpha ", replace: "" }, { find: "BG", replace: "B-G" }], { author: "Bob" });
	const x = part(f);
	assert.ok(!nestedIns(x), x);
	assert.match(readDocx(f, { revisions: "accepted" }), /^B-G delta$/m);
	// Bob's "BG" became "B-G" directly: no deletion of his own new text
	assert.doesNotMatch(x, /<w:delText>BG<\/w:delText>/);
	assert.deepEqual(checkDocx(unzipSync(readFileSync(f))), []);
});

test("insert a paragraph after / before, formatted like its neighbour, as a tracked change", () => {
	const pPr = '<w:pPr><w:pStyle w:val="B1"/><w:ind w:left="568"/><w:rPr><w:ins w:id="2" w:author="Old" w:date="2020-01-01T00:00:00Z"/><w:sz w:val="20"/></w:rPr><w:sectPr/></w:pPr>';
	const f = docx("insert.docx", `${p("Intro.")}<w:p>${pPr}<w:r><w:t>- first item</w:t></w:r></w:p>${p("Outro.")}`);
	editDocx(f, [{ insert: "- second item\n- third item", after: "first item" }, { insert: "New heading", before: "Intro.", style: "Heading1" }], { author: "Bob", date: "2026-11-06" });
	assert.match(readDocx(f), /^# \{\+New heading\+\}\nIntro\.\n- first item\n\{\+- second item\+\}\n\{\+- third item\+\}\nOutro\.$/m);
	const x = part(f);
	// style and indent copied; the neighbour's old mark and section break are not; the new mark is inserted, dated as asked
	assert.match(x, /<w:p><w:pPr><w:pStyle w:val="B1"\/><w:ind w:left="568"\/><w:rPr><w:ins w:id="\d+" w:author="Bob" w:date="2026-11-06T00:00:00Z"\/><w:sz w:val="20"\/><\/w:rPr><\/w:pPr><w:ins [^>]*><w:r><w:rPr><w:sz w:val="20"\/><\/w:rPr><w:t>- second item<\/w:t>/);
	assert.equal(x.match(/<w:sectPr\/>/g).length, 2);
	assert.match(x, /<w:p><w:pPr><w:pStyle w:val="Heading1"\/><w:rPr><w:ins [^>]*\/><\/w:rPr><\/w:pPr><w:ins [^>]*><w:r><w:t>New heading/);
	editDocx(f, [{ reject: "Bob" }]);
	assert.equal(readDocx(f), "(tracked changes: {+inserted+} {-deleted-})\n\nIntro.\n- first item\nOutro.");
});

test("delete whole paragraphs as tracked changes, through a range; accepting removes them", () => {
	const f = docx("delete.docx", [p("Keep one."), p("Drop A."), p("Drop B."), p("Drop C."), p("Keep two.")].join(""));
	editDocx(f, [{ deleteParagraph: "Drop A", through: "Drop C" }], { author: "Bob" });
	assert.match(readDocx(f), /Keep one\.\n\{-Drop A\.-\}\n\{-Drop B\.-\}\n\{-Drop C\.-\}\nKeep two\./);
	assert.equal((part(f).match(/<w:pPr><w:rPr><w:del [^>]*\/><\/w:rPr><\/w:pPr>/g) ?? []).length, 3);
	const g = join(dir, "delete-accepted.docx");
	writeFileSync(g, readFileSync(f));
	editDocx(g, [{ accept: "all" }]);
	assert.equal(readDocx(g), "Keep one.\nKeep two.");
	assert.equal((part(g).match(/<w:p>/g) ?? []).length, 2);
	editDocx(f, [{ reject: "all" }]);
	assert.equal(readDocx(f), "Keep one.\nDrop A.\nDrop B.\nDrop C.\nKeep two.");
});

const cell = (text, w = 2000) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${text === "" ? '<w:p><w:pPr><w:rPr><w:rFonts w:ascii="Arial"/></w:rPr></w:pPr></w:p>' : p(text)}</w:tc>`;
const COVER = `<w:tbl><w:tblPr/><w:tblGrid/>` +
	`<w:tr>${cell("CR-Form-v12.3")}${cell("")}</w:tr>` +
	`<w:tr>${cell("Title:")}${cell("", 142)}${cell("")}</w:tr>` +
	`<w:tr>${cell("Source to WG:")}${cell("", 142)}${cell("")}</w:tr>` +
	`<w:tr>${cell("Date:")}${cell("", 142)}${cell("2026-01-01")}</w:tr>` +
	`</w:tbl>${p("Reason for change:")}<w:p/>${p("5.2 Clause text")}`;

test("fill a CR cover page: the cell right of a label, by table/row/col, the empty paragraph after a text", () => {
	const f = docx("cover.docx", COVER);
	editDocx(f, [
		{ fill: "Faster reporting", label: "Title:" },
		{ fill: "Example Corp", label: "Source to WG" },
		{ fill: "38.331", table: 1, row: 1, col: 2 },
		{ fill: "The report is too slow.\nIt wastes power.", after: "Reason for change:", track: true },
	], { track: false, author: "Bob" });
	const t = readDocx(f);
	assert.match(t, /\| Title: \|  \| Faster reporting \|/);
	assert.match(t, /\| Source to WG: \|  \| Example Corp \|/);
	assert.match(t, /\| CR-Form-v12\.3 \| 38\.331 \|/);
	assert.match(t, /Reason for change:\n\{\+The report is too slow\.\+\}\n\{\+It wastes power\.\+\}\n5\.2 Clause text/);
	// the cover was filled without tracking, in the empty paragraph's own font
	assert.match(part(f), /<w:r><w:rPr><w:rFonts w:ascii="Arial"\/><\/w:rPr><w:t>Faster reporting<\/w:t><\/w:r>/);
	assert.throws(() => editDocx(f, [{ fill: "x", label: "Date:" }]), /already has text "2026-01-01": change it with find and replace/);
	assert.throws(() => editDocx(f, [{ fill: "x", label: "Nope:" }]), /No table cell reads "Nope:"/);
	assert.throws(() => editDocx(f, [{ fill: "x", table: 2, row: 1, col: 1 }]), /No table 2: the file has 1/);
});

test("comments: added on text (the parts are made when missing), read back, a reply, an explicit date", () => {
	const f = docx("comments.docx", `${p("The UE shall send the report every 10 s.")}`);
	editDocx(f, [{ comment: "Why 10 s?\nSee clause 5.", find: "every 10 s" }], { author: "Wesley van J", date: "2026-11-01T09:00:00Z" });
	const t = readDocx(f);
	assert.match(t, /The UE shall send the report every 10 s\[comment \d+\]\./);
	const id = /\[comment (\d+)\] Wesley van J: Why 10 s\? See clause 5\./.exec(t)?.[1];
	assert.ok(id, t);
	const c = part(f, "word/comments.xml");
	assert.match(c, new RegExp(`<w:comment w:id="${id}" w:author="Wesley van J" w:date="2026-11-01T09:00:00Z" w:initials="WVJ">`));
	assert.match(part(f, "word/_rels/document.xml.rels"), /relationships\/comments" Target="comments.xml"/);
	assert.match(part(f, "[Content_Types].xml"), /PartName="\/word\/comments.xml"/);
	assert.match(part(f, "[Content_Types].xml"), /PartName="\/word\/commentsExtended.xml"/);
	assert.match(part(f, "word/commentsIds.xml"), /w16cid:durableId="[0-9A-F]{8}"/);
	assert.match(part(f), new RegExp(`<w:commentRangeStart w:id="${id}"/><w:r><w:t>every 10 s</w:t></w:r><w:commentRangeEnd w:id="${id}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`));
	editDocx(f, [{ comment: "Agreed, 20 s.", replyTo: Number(id) }], { author: "Alice" });
	const reply = /\[comment (\d+)\] Alice \(reply to (\d+)\): Agreed, 20 s\./.exec(readDocx(f));
	assert.ok(reply && reply[2] === id, readDocx(f));
	assert.match(part(f, "word/commentsExtended.xml"), /w15:paraIdParent="[0-9A-F]{8}"/);
	assert.deepEqual(checkDocx(unzipSync(readFileSync(f))), []);
	assert.throws(() => editDocx(f, [{ comment: "x", replyTo: 999 }]), /No comment 999/);
});

test("accept or reject all, or one author's: text, paragraph marks, formatting", () => {
	const BOB = 'w:author="Bob" w:date="2026-01-03T00:00:00Z"';
	const body = `<w:p><w:r><w:t xml:space="preserve">Keep </w:t></w:r><w:ins w:id="1" ${ALICE}><w:r><w:t>alice-new </w:t></w:r></w:ins>` +
		`<w:del w:id="2" ${BOB}><w:r><w:delText>bob-old </w:delText></w:r></w:del><w:r><w:rPr><w:b/><w:rPrChange w:id="3" ${BOB}><w:rPr/></w:rPrChange></w:rPr><w:t>bold</w:t></w:r></w:p>` +
		`<w:p><w:pPr><w:rPr><w:ins w:id="4" ${ALICE}/></w:rPr></w:pPr><w:ins w:id="5" ${ALICE}><w:r><w:t>Alice para</w:t></w:r></w:ins></w:p>${p("Last.")}`;
	const f = docx("revs.docx", body);
	const g = join(dir, "revs-2.docx");
	writeFileSync(g, readFileSync(f));
	editDocx(f, [{ accept: "Alice" }]);
	assert.equal(readDocx(f), "(tracked changes: {+inserted+} {-deleted-})\n\nKeep alice-new {-bob-old -}bold\nAlice para\nLast.");
	editDocx(f, [{ reject: "all" }]);
	assert.equal(readDocx(f), "Keep alice-new bob-old bold\nAlice para\nLast.");
	assert.doesNotMatch(part(f), /<w:b\/>|w:author/); // Bob's bold rejected: back to the old (plain) formatting
	editDocx(g, [{ accept: "all" }]);
	assert.equal(readDocx(g), "Keep alice-new bold\nAlice para\nLast.");
	assert.match(part(g), /<w:rPr><w:b\/><\/w:rPr>/);
	const h = join(dir, "revs-3.docx");
	writeFileSync(h, readFileSync(docx("revs-r.docx", body)));
	editDocx(h, [{ reject: "Alice" }]);
	assert.equal(readDocx(h), "(tracked changes: {+inserted+} {-deleted-})\n\nKeep {-bob-old -}bold\nLast.");
});

test("the result is checked: problems are reported and nothing is saved", () => {
	// a link inside Alice's insertion: a new insertion cannot be moved out of it, so it would nest
	const body = `<w:p><w:ins w:id="1" ${ALICE}><w:hyperlink w:anchor="x"><w:r><w:t>link text</w:t></w:r></w:hyperlink></w:ins></w:p>`;
	const f = docx("refuse.docx", body);
	const before = readFileSync(f);
	assert.throws(() => editDocx(f, [{ find: "link", replace: "anchor" }], { author: "Bob" }),
		/Not saved, .* is unchanged[\s\S]*a tracked insertion \(w:id \d+\) inside another one near "anchor text"/);
	assert.deepEqual(readFileSync(f), before);
	// what the check finds in a damaged file
	const bad = { "word/document.xml": strToU8(`<w:document ${W}><w:body><w:p><w:ins w:id="7"><w:ins w:id="7"><w:r><w:t>a</w:t></w:r></w:ins></w:ins>` +
		`<w:del w:id="8"><w:r><w:t>b</w:t></w:r></w:del><w:commentRangeStart w:id="9"/></w:p></w:body></w:document>`), "word/x.xml": strToU8("<a><b></a>") };
	const problems = checkDocx(bad).join("\n");
	assert.match(problems, /word\/x\.xml: <\/a> closes <b>/);
	assert.match(problems, /a tracked insertion \(w:id 7\) inside another one/);
	assert.match(problems, /deleted text in <w:t> instead of <w:delText>/);
	assert.match(problems, /w:id 7 is used 2 times/);
	assert.match(problems, /comment 9 starts but never ends/);
	assert.match(problems, /comment 9 is marked in the text but missing from the comments/);
});

test("the XML tree writes back what it read; initials", () => {
	const s = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><!-- c --><w:body><w:p w:rsidR="00AB"><w:r><w:t xml:space="preserve"> a &amp; b &#x4E2D; </w:t></w:r><w:r/></w:p></w:body></w:document>`;
	assert.equal(xml(parseXml(s)), s);
	assert.throws(() => parseXml("<a>x & y</a>"), /bare &/);
	assert.throws(() => parseXml("<a><b>"), /never closed/);
	assert.equal(initialsOf("Wesley van J"), "WVJ");
	assert.equal(initialsOf("张三丰"), "张三");
	assert.equal(initialsOf("ferry"), "F");
});

test("office_edit tool: the configured author, notes for each edit", async () => {
	const tools = {};
	createOffice({ officeAuthor: "Example Delegate" })({ registerTool: (t) => { tools[t.name] = t; } });
	docx("tool.docx", `<w:tbl><w:tr>${cell("Title:")}${cell("")}</w:tr></w:tbl>${p("Some text here.")}`);
	const r = await tools.office_edit.execute("1", { path: "tool.docx", edits: [
		{ fill: "A title", label: "Title:", track: false }, { find: "text", replace: "words" }, { comment: "ok?", find: "Some" }] },
	undefined, undefined, { cwd: dir });
	const out = r.content[0].text;
	assert.match(out, /saved in .*tool\.docx \(checked\)\nfilled the cell right of "Title:"\n"text": 1 replaced\ncomment \d+ added on "Some"/);
	assert.match(part(join(dir, "tool.docx")), /w:author="Example Delegate"/);
	assert.match(readDocx(join(dir, "tool.docx")), /\[comment \d+\] Example Delegate: ok\?/);
});
