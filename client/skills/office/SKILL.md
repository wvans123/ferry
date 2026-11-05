---
name: office
description: Work with Word, Excel, PowerPoint and PDF files - read them (with tracked changes and comments), change Word text as tracked changes (change requests, review edits), set Excel cells, create new .docx/.xlsx, convert a whole folder to text. Use whenever a task involves .docx, .doc, .xlsx, .xls, .pptx, .ppt or .pdf files. Never use Office COM automation.
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

Batches: for many files (e.g. "check all 40 contributions in this folder"), first convert the folder with
`office_read` + `out`, then grep the .txt files; for a judgement per file, use `task_batch` with a prompt that tells
each subagent to read {item}'s .txt and report in a fixed short format.
