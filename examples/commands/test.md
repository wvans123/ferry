---
description: Run the project's tests and fix what fails
argument-hint: "[which tests, e.g. a file or a name]"
---
Run ${@:-the project's tests} and get them passing.

1. Find out how tests are run here (AGENTS.md, README, package/build files, CI config). Prefer the narrowest command
   that covers the request.
2. Run them. For each failure, find the cause before changing anything: is the code wrong or the test?
3. Fix the code when the code is wrong. Change a test only when the test itself is clearly wrong, and say so.
4. Run the tests again until they pass, then summarise what failed and what you changed.
Keep a task list with the todo tool if there are several failures.
