---
description: Check the current changes (or given files) for security problems
argument-hint: "[what to check]"
---
Do a security review of ${@:-the uncommitted changes in this repository (git diff HEAD, plus new untracked files)}.

Look only for security problems: injection (SQL, command, path traversal), missing authentication or authorisation
checks, secrets or credentials in code or config, unsafe deserialisation, unvalidated redirects, sensitive data in
logs or error messages, insecure defaults. For each finding give: severity, file and line, how it could be
exploited, and a concrete fix. Say clearly if you found nothing. Do not change any files.
