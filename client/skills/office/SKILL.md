---
name: office
description: Work with Word, Excel, PowerPoint and PDF files - read them (with tracked changes and comments), change Word as tracked changes (text, whole paragraphs, empty cells of a CR cover page, comments, accept/reject), set Excel cells, create new .docx/.xlsx, convert a whole folder to text. Use whenever a task involves .docx, .doc, .xlsx, .xls, .pptx, .ppt or .pdf files, change requests (CRs) and review edits. Never use Office COM automation.
---
# Office files

Tools (they work on the files; nothing is opened on the screen, Office need not be installed):
- `office_read` - .docx / .xlsx / .pptx / .pdf as text, and the old .doc / .xls / .ppt too. It judges the format by
  the file's content, so a .docx that is really an old .doc (or a PDF) is still read. Word tracked changes show as
  {+inserted+} {-deleted-}, comments are listed at the end with their anchor [comment N]. Excel: `sheet`, `range`
  (A1:H50), `formulas: true`. PDF: `pages: "3-7"` for long files.
  Many files: `office_read` with `path` = a folder or a glob (`D:/docs/**/*.doc*`) and `out` = a folder. Each file
  becomes a .txt under `out` (same relative path); you get back only a summary (ok / failed / encrypted, failed files
  with reasons). Then grep or read the .txt files you need.
- `office_edit` - Word: a list of `edits`, applied in order, tracked by default (`track: false` for silent
  changes; any single edit may set its own `track`). `author` sets the name on changes and comments (default: the
  Office user name, as Word uses), `date` their date (e.g. `"2026-11-06"`, default now). Excel:
  `cells: {"B3": 42, "D3": "=SUM(B1:B3)"}`, `sheet`.
- `office_create` - a new .docx from Markdown, or a new .xlsx from rows.

Word edits (`office_edit` `edits`):

| Edit | What it does |
|---|---|
| `{find: "every 10 s", replace: "every 20 s"}` | replace text inside one paragraph (`replace: ""` deletes; `all: true` for every match) |
| `{insert: "New text", after: "end of the paragraph before"}` | new paragraph(s) after the one holding that text, formatted like it; one paragraph per line; `before` instead of `after`; `style: "B1"` for another paragraph style |
| `{deleteParagraph: "text in it"}` | delete the whole paragraph; `through: "text in the last one"` deletes a run of paragraphs (tables between them too) |
| `{fill: "Faster reporting", label: "Title:"}` | write into the empty cell right of the cell that reads "Title:" |
| `{fill: "38.331", table: 1, row: 2, col: 3}` | write into an empty cell by position (tables counted from 1 in the order office_read shows them) |
| `{fill: "text", after: "Reason for change:"}` | write into the next empty paragraph after that text |
| `{comment: "Why 20 s?", find: "every 20 s"}` | a comment on that text |
| `{comment: "Agreed.", replyTo: 3}` | a reply to [comment 3] |
| `{accept: "all"}` / `{reject: "Alice"}` | accept or reject all tracked changes, or one author's |

`fill` writes only into an empty cell or paragraph; to change text already there use `find` / `replace`.
The result is checked before it is saved (a file Word can open, ids unique, insertions not nested, every change
tracked when tracking is on). If there is a problem, nothing is saved and you get the list: change the edits,
do not work around it with scripts.

How to work:
1. Read first (`office_read`), then edit. Quote `find` exactly as office_read shows it, without the {+ +} / {- -}
   marks; it must lie inside one paragraph and be unique (or `all: true`). Prefer whole phrases or sentences.
2. One `office_edit` call can carry many edits; they apply in order.
3. After editing, read the changed part again to check it.
4. Keep the original untouched when the user may want to compare: copy it first (`powershell: Copy-Item a.docx a-rev1.docx`
   or `bash: cp`), then edit the copy.
5. Old binary .doc/.xls/.ppt files: read them with `office_read`. To change one, ask the user to save it as
   .docx/.xlsx/.pptx (office_edit changes only the new formats).
6. Do not drive Word, Excel or PowerPoint with COM automation (win32com / pywin32, PowerShell
   `New-Object -ComObject Word.Application`, VBScript). Many company PCs block it, and office_read already reads
   .doc and whole folders. Do not write python-docx / olefile / antiword scripts for reading either.
7. A file office_read reports as encrypted (IRM / rights management, or a password) cannot be read by any tool:
   tell the user which files, and go on with the rest.

Standards documents (3GPP / ETSI style):
- A change request shows every change as a tracked change against the current text of the specification: use
  `office_edit` with tracking on, author = the user's company or name if they gave one.
- Do not rewrite unchanged text; change only the words that must change, so the reviewer sees exactly what moved.
- Keep clause numbers, figure and table numbers, and defined terms exactly as written in the spec.
- For "summarise the comments" tasks, read the comments list from `office_read` and group them by clause.

A CR, step by step (copy the template or the spec extract first, and work on the copy):
1. `office_read` the file. Note the cover page labels and which cells are empty.
2. Fill the cover page without tracking (the cover is not a change to the spec), in one call:
   `office_edit` with `track: false` and `edits: [{fill: "Faster measurement reporting", label: "Title:"},
   {fill: "Example Corp", label: "Source to WG:"}, {fill: "F", label: "Category:"}, {fill: "Rel-18", label:
   "Release:"}, {fill: "18.4.0", label: "Current version:"}, ...]`. Use the label text exactly as office_read shows
   it. Cells without a label on their left (the spec number before "CR"), or two cells that read the same: use
   `table` / `row` / `col` as office_read shows the table.
   Reason for change, Summary of change, Consequences if not approved, Clauses affected: fill them the same way.
3. Make the changes in the clause text with tracking on, author = the user's name or company:
   `{find, replace}` for words, `{insert, after}` for a new paragraph (give `style` when the neighbour is a heading
   or a different kind of paragraph), `{deleteParagraph}` for whole paragraphs.
4. Add comments where the reader needs a note: `{comment, find}`.
5. `office_read` again: the cover fields are filled, every change shows as {+...+} / {-...-}, Clauses affected
   matches the clauses changed. For an important CR, ask the `review` subagent to check it (it follows the review
   skill's CR checklist).

Batches: for many files (e.g. "check all 40 contributions in this folder"), first convert the folder with
`office_read` + `out`, then grep the .txt files; for a judgement per file, use `task_batch` with a prompt that tells
each subagent to read {item}'s .txt and report in a fixed short format.
