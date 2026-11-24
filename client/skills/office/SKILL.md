---
name: office
description: Work with Word (.docx/.doc), Excel (.xlsx/.xls), PowerPoint (.pptx/.ppt) and PDF (.pdf) files for both general work (reports, templates, contracts, presentations, spreadsheets, financial/data models, PDFs) and standards CRs. Read text, tables, charts, headers/footers, tracked changes and comments; edit Word, Excel and PowerPoint in place preserving styles; or build rich deliverables cleanly. Never use Office COM automation.
---
# Office & PDF files

## 1. Pick the right path by task

| Task | Tool / Approach |
|---|---|
| **Read** any `.docx/.doc/.xlsx/.xls/.pptx/.ppt/.pdf` | `office_read` (detects format by content; extracts Word headers/footers/tables/revisions/comments, Excel values or `formulas: true`, PowerPoint tables/charts/notes, PDF pages). For large files: `outline: true` first, then `section`, `pages`, `sheet`+`range`, or `offset`. |
| **Read a whole folder** of Office/PDF files | `office_read` with `path` (folder or glob) and `out` (output folder of `.txt` files), then `grep` / `read`. |
| **Edit an existing `.docx`, `.xlsx`, or `.pptx` in place** | `office_edit` — preserves original styles, layouts, images, charts and formulas. For general Word templates/reports/contracts pass `track: false`; for review redlines or 3GPP CRs keep `track: true`. |
| **Create a straightforward `.docx` or `.xlsx`** | `office_create` (`.docx` from Markdown headings/lists/tables/bold/italic; `.xlsx` with auto-sized columns and `=...` formulas). |
| **Create a rich custom `.pptx` deck, styled `.xlsx` model, complex `.docx`, or merge/split PDFs** | Write one reusable script in the task temp folder (`pptxgenjs` / `python-pptx`, `openpyxl`, `docx` / `python-docx`, `pypdf` / `pdfplumber`). Never drive Office via COM (`win32com`, `New-Object -ComObject`): company PCs block it. |

Encrypted files (IRM / password) reported by `office_read` cannot be opened by any script: tell the user and move on.

---

## 2. Word (`.docx`)

`office_edit` `edits` (applied in order, XML validated before saving, returns a preview of changed lines):

| Edit | What it does |
|---|---|
| `{find: "old", replace: "new", all?: true}` | Replace text inside one paragraph (`replace: ""` deletes). Quote `find` without `{+ +}` / `{- -}` marks. |
| `{insert: "Para 1\nPara 2", after\|before: "anchor", style?: "Heading2"}` | Insert paragraph(s) next to the anchor paragraph, inheriting its formatting unless `style` is set. |
| `{deleteParagraph: "text", through?: "end text"}` | Delete one paragraph or a span of paragraphs (including tables between them). |
| `{fill: "value", label: "Title:"}` / `{fill, table, row, col}` / `{fill, after}` | Fill an empty table cell (right of `label`, or 1-based `table`/`row`/`col`) or empty paragraph. |
| `{comment: "note", find: "anchor", date?: "..."}` / `{comment: "reply", replyTo: 3}` | Add a comment or reply to `[comment N]` (multiple comments auto-stagger in local wall-clock time within 1 hour, or pass per-comment `date` like `"2026-11-24T17:25:00+08:00"`). |
| `{accept: "all"}` / `{reject: "Alice"}` | Accept or reject all tracked changes, or one author's. |

- **General documents & templates** (contracts, forms, resumes, PRDs, reports): set `track: false` unless the user wants redlines. Copy the original first (`cp` / `Copy-Item`) when keeping a baseline helps.
- **Rich new `.docx` via `docx` (npm) or `python-docx` gotchas**: set explicit table & cell DXA widths (avoid `%` widths); never put `\n` inside a run (create separate paragraphs); use real heading styles (`Heading1`...) so Word's navigation/TOC works.

---

## 3. PowerPoint (`.pptx`)

- **Reading**: `office_read` extracts slide text, Markdown tables, native `<c:chart>` series/values, and speaker notes. Use `outline: true` or `pages: "1-5"` on large decks.
- **Updating an existing deck or template**: prefer `office_edit` on `.pptx` (`edits: [{find: "Q2", replace: "Q3", slide: 2}]`), which keeps run fonts, colors, sizes, shapes and charts intact. If scripting with `python-pptx`, assign `run.text = ...` — **never** `text_frame.text = ...` (which wipes run formatting).
- **Building a new presentation (`pptxgenjs` or `python-pptx`)**:
  - **Content & flow**: one clear message per slide; match structure to audience (concise visual cards/charts for live executive talks; denser tables/diagrams for technical pre-reads); vary slide layouts instead of repeating identical bullet slides.
  - **Native data**: use native tables and charts (`addChart` / `add_chart`) for numerical comparisons, with clear titles, data labels, and restrained gridlines.
  - **`pptxgenjs` gotchas**: default `LAYOUT_16x9` is `10" × 5.625"` (`LAYOUT_WIDE` is `13.3" × 7.5"`); hex colors take **no `#` and no 8-digit alpha** (`"1E293B"`, never `"#1E293B"` — `#` corrupts the file); never reuse one options/shadow object across multiple `add*` calls (pptxgenjs mutates it in place); use `bullet: true` rather than literal `•`.
  - **Check**: read the generated `.pptx` back with `office_read` to verify slide count, numbers and text; if rendering slide previews to images, keep resolution modest (`100-150 DPI`).

---

## 4. Excel (`.xlsx`)

- **Reading**: `office_read` takes `sheet`, `range` (`"A1:H50"`), `formulas: true`, or `outline: true`.
- **Editing / creating**: `office_edit` (`cells: {"B3": 42, "D3": "=SUM(B2:B3)"}`, `sheet`) updates cells while keeping existing styles, sheets and formulas; `office_create` builds multi-sheet workbooks with auto-sized columns.
- **Spreadsheet & `openpyxl` rules**:
  - **Formulas over hardcoded totals**: always write `=SUM(B2:B9)`, never a precomputed literal, so the sheet recalculates. Put key assumptions in dedicated cells (`=B5*(1+$B$2)`).
  - **Compatible functions**: prefer `SUMIFS`, `INDEX`/`MATCH`, `IFERROR`, `SUMPRODUCT`. In `openpyxl`, post-2007 functions (`IFS`, `SWITCH`, `TEXTJOIN`, `CONCAT`, `MAXIFS`, `MINIFS`) need an `_xlfn.` prefix; avoid dynamic array formulas (`XLOOKUP`, `FILTER`, `UNIQUE`, `SEQUENCE`) because `openpyxl` lacks spill metadata.
  - **`openpyxl` traps**: never save a workbook opened with `load_workbook(..., data_only=True)` (it permanently overwrites every formula with literals); write only the top-left cell of a merged range; pass `keep_vba=True` on `.xlsm`; quote sheet names containing spaces (`='Q3 Plan'!$B$5`); set `number_format` explicitly (`0.0%` with fraction `0.15`, `#,##0`, `yyyy-mm-dd`).

---

## 5. PDF (`.pdf`)

- **Reading**: `office_read` (`outline: true`, `pages: "3-7"`).
- **Manipulation / complex tables**: use `pypdf` (`PdfReader` / `PdfWriter`) to merge, split or rotate pages; use `pdfplumber` (`page.extract_tables()`) when extracting complex multi-column tables into CSV/Excel.

---

## 6. Standards CRs (3GPP / ETSI)

1. Copy the spec extract / CR template first and `office_read` it (`outline: true` -> target `section`).
2. Fill the cover page in one `office_edit` call with `track: false` (`{fill: "...", label: "Title:"}`, etc., including Reason for change, Summary of change, Consequences if not approved, Clauses affected).
3. Edit the clause body in `office_edit` with `track: true` and `author` set to the user's company/name; touch only the words that change and keep clause/table/figure numbers exact.
4. Check `office_edit`'s returned preview (and run the `review` subagent on important CRs).
