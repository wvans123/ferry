---
description: Review the current changes (or a branch, commit or file) and report problems by severity
argument-hint: "[what to review, e.g. main..HEAD or src/api]"
---
Review ${@:-the uncommitted changes in this repository (git diff HEAD, plus new untracked files)}.

Read the changed code and enough of its surroundings to judge it. Look for, in this order:
1. Bugs: wrong logic, edge cases, error handling, concurrency, resource leaks, off-by-one, null handling.
2. Security: injection, secrets in code, unsafe input handling, missing authorisation.
3. Breaking changes for callers, data formats or configuration.
4. Tests: missing or weakened tests for the changed behaviour.
5. Clarity and consistency with the rest of the code base (only what matters).

Report each finding as: severity (high / medium / low), file and line, what is wrong, and a concrete fix.
Say clearly if you found nothing important. Do not change any files.
