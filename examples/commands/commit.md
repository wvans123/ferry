---
description: Write a commit message for the current changes and commit them
argument-hint: "[extra notes for the message]"
---
Commit the current changes in this git repository.

1. Run git status and git diff (staged and unstaged) to see what changed. If nothing is staged, stage the files that
   belong to this change; leave unrelated files, build output and anything that looks like a secret unstaged, and
   tell me what you left out.
2. Look at the last few commit messages (git log --oneline -10) and follow their style and language.
3. Write a message: a short summary line, then (if useful) a body explaining why. ${@:-}
4. Commit with that message. Do not push.
