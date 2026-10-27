---
description: Write a pull request description for the current branch
argument-hint: "[base branch, default main]"
---
Write a pull request description for the changes on this branch compared with ${1:-main}.

Use git log and git diff against ${1:-main} (merge base). Write:
- a title of one line;
- what changed and why, in a few bullet points;
- how it was tested;
- anything reviewers should look at closely, and any follow-up work.
Match the language of the commit messages. Output it as Markdown I can paste. Do not push or create anything.
