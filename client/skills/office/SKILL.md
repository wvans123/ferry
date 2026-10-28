---
name: office
description: Work with Word, Excel, PowerPoint and PDF files - read them (with tracked changes and comments), change Word text as tracked changes (change requests, review edits), set Excel cells, create new .docx/.xlsx. Use whenever a task involves .docx, .xlsx, .pptx or .pdf files.
---
# Office files

Tools (they work on the files; nothing is opened on the screen, Office need not be installed):
- `office_read` - .docx / .xlsx / .pptx / .pdf as text. Word tracked changes show as {+inserted+} {-deleted-},
  comments are listed at the end with their anchor [comment N]. Excel: `sheet`, `range` (A1:H50), `formulas: true`.
  PDF: `pages: "3-7"` for long files.
- `office_edit` - Word: `edits: [{find, replace}]`, tracked by default (`track: false` for a silent change),
  `author` sets the name on the changes. Excel: `cells: {"B3": 42, "D3": "=SUM(B1:B3)"}`, `sheet`.
- `office_create` - a new .docx from Markdown, or a new .xlsx from rows.

How to work:
1. Read first (`office_read`), then edit. Quote `find` exactly as office_read shows it, without the {+ +} / {- -}
   marks; it must lie inside one paragraph and be unique (or `all: true`). Prefer whole phrases or sentences.
2. One `office_edit` call can carry many edits; they apply in order.
3. After editing, read the changed part again to check it.
4. Keep the original untouched when the user may want to compare: copy it first (`powershell: Copy-Item a.docx a-rev1.docx`
   or `bash: cp`), then edit the copy.
5. Old binary .doc/.xls/.ppt files: ask the user to save them as .docx/.xlsx/.pptx.

Standards documents (3GPP / ETSI style):
- A change request shows every change as a tracked change against the current text of the specification: use
  `office_edit` with tracking on, author = the user's company or name if they gave one.
- Do not rewrite unchanged text; change only the words that must change, so the reviewer sees exactly what moved.
- Keep clause numbers, figure and table numbers, and defined terms exactly as written in the spec.
- For "summarise the comments" tasks, read the comments list from `office_read` and group them by clause.

Batches: for many files (e.g. "check all 40 contributions in this folder"), use `task_batch` with a prompt that tells
each subagent to use `office_read` on {item} and report in a fixed short format.
