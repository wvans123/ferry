---
name: review
description: Checklist for reviewing a finished document before it goes out - completeness against the request, facts and numbers, internal consistency, tracked-change hygiene, and 3GPP change requests (cover page, reasons, clauses affected, every change tracked). The review subagent follows it; use it too when asked to check a document, a contribution or a CR yourself.
---
# Reviewing a document

You check work someone else made. Read the whole deliverable first (`office_read`; for Word also
`revisions: "accepted"` to see the clean result), then go through the parts below that fit. Report problems
only, most serious first, each with where it is (clause, table, page, paragraph) and what is wrong. Do not
rewrite the document.

## 1. Against the request
- Everything the request asked for is there, in the form asked for (file type, template, length, language).
- Nothing was done that was not asked for (extra clauses changed, text rewritten that should have stayed).
- The audience fits: a WG delegate, a manager, a customer.

## 2. Facts, numbers, dates
- Numbers, units, names, spec numbers, versions and dates match the sources named in the task. Recompute sums,
  percentages and conversions.
- References point to things that exist: clause numbers, figures, tables, documents (Tdoc numbers), specs.
- Dates are real and consistent (meeting dates, "Date:" on the cover, dates in the text).

## 3. Internal consistency
- Terms, abbreviations and names are used the same way throughout (defined once, then the same).
- The summary or abstract says what the body says; conclusions follow from the text.
- Numbering runs without gaps or repeats (clauses, figures, tables, list items).
- No placeholders left: "TBD", "xxx", "<...>", "[Editor's note]" that should be gone, empty table cells that
  should be filled, template instructions still in the text.

## 4. Tracked changes and comments (Word)
- Every intended change is a tracked change; no silent edits in text that is shown as unchanged. Compare the
  shown view ({+inserted+} {-deleted-}) with the request.
- Changes are minimal: only the words that must change are deleted and inserted, not whole sentences retyped.
- The author name on the changes is the one the user wants (their name or company), and the same on all.
- No stray changes: formatting-only changes, changes from an earlier draft, comments that were meant to be
  resolved or removed before sending.
- Open comments are answered or listed for the user.

## 5. 3GPP change request (CR)
Cover page:
- Every field is filled: spec number, CR number (or "-" before allocation), Rev, Current version, Title,
  Source to WG, Source to TSG, Work item code, Date, Category, Release.
- Spec number and Current version match the specification the changes are made against; Release matches the
  version (e.g. 18.x.y is Rel-18).
- Category is a valid letter (F, A, B, C, D) and fits the change (F = correction, B = new feature, A = mirror
  of a correction in an earlier release).
- Reason for change, Summary of change and Consequences if not approved are filled, specific, and agree with
  each other and with the actual changes.
- Clauses affected lists exactly the clauses that carry changes: none missing, none extra.
- Other specs affected / other comments are filled (or "N" / empty as the template asks).

Changed clauses:
- Every change is tracked against the current version of the spec; unchanged text is not retyped.
- Only the affected clauses are in the document, separated by the usual "*** First change ***" / "*** Next
  change ***" markers (or what the WG uses), in clause order.
- Clause numbers, headings, figure and table numbers, ASN.1, defined terms and abbreviations are kept exactly as
  in the spec; new abbreviations are added to the abbreviations clause.
- References to other specs and clauses are correct.
- The changed text reads correctly in the accepted view (grammar, "shall"/"should"/"may" used as the drafting
  rules intend).

## Report
A short list, most serious first: where, what is wrong, and (one line) what would fix it. If nothing is wrong,
say in one or two lines what you checked.
