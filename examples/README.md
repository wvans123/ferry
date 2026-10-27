# 示例：自己扩展 Ferry

把需要的文件拷到对应位置就能用，改完在 ferry 里输入 `/reload`（或重开 ferry）。说明见 [docs/CUSTOMIZE.md](../docs/CUSTOMIZE.md)。

| 文件 | 拷到哪里 | 效果 |
|---|---|---|
| `AGENTS.md` | 项目根目录 | 每次对话都带上的项目说明（也可以在 ferry 里输入 `/init` 让它自己写） |
| `commands/standup.md` | 项目的 `.ferry\commands\` 或 `%USERPROFILE%\.ferry\commands\` | 新命令 `/standup` |
| `commands/translate.md` | 同上 | 新命令 `/translate 文件名 [语言]` |
| `commands/commit.md` `test.md` `fix.md` `explain.md` `pr.md` `doc.md` | 同上 | 写代码常用的 `/commit` `/test` `/fix` `/explain` `/pr` `/doc` |
| `agents/security-reviewer.md` | 项目的 `.ferry\agents\` 或 `%USERPROFILE%\.ferry\agents\` | 新的子 agent，主 agent 可以把安全审查交给它 |
| `skills/release-notes/` | 项目的 `.ferry\skills\` 或 `%USERPROFILE%\.ferry\skills\` | 写发布说明的技能，相关任务时自动加载，也可以 `/skill:release-notes` |
| `hooks.json` | `%USERPROFILE%\.ferry\hooks.json` 或项目的 `.ferry\hooks.json` | 改完文件自动格式化 / 检查，失败信息交给 agent 修 |
| `permissions.json` | `%USERPROFILE%\.ferry\permissions.json` 或项目的 `.ferry\permissions.json` | 哪些命令不用问、哪些必须问、哪些禁止 |
| `mcp.json` | `%USERPROFILE%\.ferry\agent\mcp.json` | 接入 MCP 服务器（数据库、Jira、内部文档……） |
