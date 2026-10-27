---
name: release-notes
description: Write release notes from git history in this team's format. Use when asked for release notes, a changelog entry or "what changed since version X".
---

# Release notes

1. Find the range: the last tag (`git describe --tags --abbrev=0`) to HEAD, unless the user names versions.
2. Read `git log --no-merges --pretty=format:"%h %s" <range>`. Group the commits into:
   新功能 / 改进 / 修复 / 其他. Drop pure refactors and CI changes unless they matter to users.
3. Write each item as one line a user understands (not the commit message as is), with the short hash at the end.
4. Use the template in `template.md` next to this file. Output Markdown; do not write files unless asked.
