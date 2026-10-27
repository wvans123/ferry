---
description: Find the cause of an error or bug and fix it
argument-hint: "<error message or description>"
---
Fix this problem: ${@:-the error from the last command}

1. Reproduce or locate it: find where the error comes from (search for the message, read the stack trace, run the
   failing command if it is safe).
2. Find the root cause, not just the line that throws. Explain it to me in one or two sentences.
3. Make the smallest change that fixes the cause, then verify it (run the failing command or the related tests).
