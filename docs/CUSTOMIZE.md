# 自己动手扩展 Ferry

Ferry 的大部分能力都可以用**普通文本文件**来定制，不用写代码。下面每一项都有现成的例子，在仓库的 [examples/](../examples/) 文件夹里，拷过去改改就能用。

文件放在哪决定了它管多大范围：

- **放在 `%USERPROFILE%\.ferry\` 下**：只给你自己用，所有项目都生效。第一次运行 ferry 时会建好 `skills`、`commands`、`agents` 三个文件夹和一份 `README.md`，写明什么放哪。
- **放在项目的 `.ferry\` 下**：只在这个项目里生效。可以提交进仓库，团队一起用。

改完重新打开 ferry 就生效（不想退出的话，输入 `/reload` 也行）。

| 想做的事 | 用什么 | 放在哪 |
|---|---|---|
| 让 agent 了解项目：怎么构建、目录结构、约定 | 规则文件 `AGENTS.md` | 项目根目录；所有项目通用的放 `%USERPROFILE%\.ferry\AGENTS.md`（也认 `CLAUDE.md`） |
| 一句话触发一套固定要求 | 斜杠命令 | `commands\*.md` |
| 一类任务的详细做法，带参考资料和脚本 | 技能 | `skills\<名字>\SKILL.md` |
| 一个专门干某类活的帮手 | 子 agent | `agents\*.md` |
| 改完文件自动格式化、检查 | 钩子 | `hooks.json` |
| 哪些操作不用问、必须问、禁止 | 权限规则 | `permissions.json` |
| 接数据库、Jira、内部系统 | MCP 服务器 | `%USERPROFILE%\.ferry\agent\mcp.json`，或项目里的 `.ferry\mcp.json` |
| 所有人、所有项目都带上的要求 | 服务端提示词 | 服务端管理页 → 提示词 |

Ferry 也认 Claude Code 的文件夹：`.claude\commands\`、`.claude\agents\`、`.claude\skills\`、`CLAUDE.md`。已经给 Claude Code 写过的东西可以直接用。

## 在 Client 和 Server 之间同步 Skill

在任意电脑、任意目录下输入 `/sync`（或 `/skills install` / `/skills upload`），即可跨电脑同步自己的 Skill 整包（包含 `SKILL.md`、`scripts/` 脚本、`references/` 参考资料、`examples/` 和 `templates/` 模板等全部子文件）。

默认使用账户自带的**服务端全局 Skill 库**，无需提前执行 `bind`：
- **上传**默认进服务端全局库，也可在弹窗或参数中选上传到当前项目专属空间（`-p` / `--project`）；
- **安装/拉取**时可选择安装到**本机全局**（`%USERPROFILE%\.ferry\skills\` / `~/.ferry/skills/`，默认，所有项目通用）或**当前项目**（`.ferry/skills/`）。

打开项目后运行 `/sync`、`/sync status` 或按 Tab 补全时，会自动读取并提示当前会话已加载的本机全局与项目 Skill、文件数量及子目录构成（内置 `grill`、`office` 随客户端自带，无需同步）：

```text
/sync status                      # 查看本机全局、当前项目与服务端全局库的同步状态
/sync upload hw-ppt               # 上传本机 hw-ppt 整包（默认进全局库，也可加 -g 或 -p）
/sync upload --all -g             # 一键把本机所有新建/修改过的 Skill 上传到全局库
/sync install hw-ppt              # 从服务端安装 hw-ppt（弹窗可选装到本机全局或当前项目）
/sync install hw-ppt -g           # 直接安装到本机全局 ~/.ferry/skills/hw-ppt
/sync install hw-ppt -p           # 直接安装到当前项目 .ferry/skills/hw-ppt
/sync install --all -g            # 在新电脑上一键把服务端全部 Skill 装到本机全局
/sync history                     # 查看版本历史
/sync install hw-ppt --revision 2 # 恢复指定历史版本到本地
/sync bind                        # （可选）将当前文件夹关联到服务端独立项目空间
```

模型也可在得到你指示时调用 `project_resources` 工具查看状态、上传或安装，并在展示整包文件构成、差异和大小后等待你确认。Client 和 Server 两边都有未同步修改时会提示冲突；Client 安装/拉取前自动保存备份，异常中断可恢复。

Server 管理页的“Skills”页面默认排在第一位显示“全局 Skill 库”，左侧选 skill 和文件，右侧可直接在线编辑 `SKILL.md`、脚本或参考文件，保存后在任意电脑跑 `/sync install <名字>` 即可同步下来并重载。

Skill 上传复用分包传输器，默认单包 ≤ 128 KiB（上限 512 KiB），遇到公司网关拦截会自动缩小分片。单个文件最多 16 MiB，单个 Skill 最多 2048 个文件，整个库最多 4096 个文件、共 96 MiB。同步会自动跳过 `.git`、`node_modules`、`__pycache__`、`*.pyc`、Office 临时锁文件 `~$*`、`.env` 及常见密钥文件，拒绝符号链接和跨平台路径冲突。Server 将内容和历史保存在数据目录的 `resources.sqlite3`。

## 规则：AGENTS.md

每次对话一开始都会带上的说明。最省事的写法是跟 agent 说"读一遍这个项目，写一份 AGENTS.md"，你再改。想要固定的写法，可以把 [examples/commands/init.md](../examples/commands/init.md) 拷到你的 `commands` 文件夹，以后输入 `/init` 就行。

好的 AGENTS.md 只写**看代码看不出来**、但做事必须知道的东西，控制在 150 行以内：
- 构建、测试、跑单个测试的确切命令；
- 目录结构，以及什么东西放在哪；
- 约定：金额用什么类型、哪些文件是生成的不能手改、提交信息格式……
- 容易踩的坑。

例子：[examples/AGENTS.md](../examples/AGENTS.md)。

## 斜杠命令

一个 Markdown 文件就是一个命令，文件名就是命令名。

```markdown
---
description: 根据最近的提交整理站会发言
argument-hint: "[天数，默认 1]"
---
看一下最近 ${1:-1} 天我在这个仓库里的提交……
```

在 ferry 里输入 `/standup 3`，`${1:-1}` 就会换成 3，然后作为你的消息发出去。能用的写法：

| 写法 | 换成 |
|---|---|
| `$1`、`$2` | 第 1、2 个参数 |
| `$ARGUMENTS` 或 `$@` | 全部参数 |
| `${1:-默认值}` | 第 1 个参数，没给就用默认值 |

含空格的参数用引号括起来：`/translate "my doc.md" 日文`。

Ferry 不自带模板命令。[examples/commands/](../examples/commands/) 里有现成的：`/init`（读项目，写 AGENTS.md）、`/review`、`/security-review`、`/commit`、`/test`、`/fix`、`/explain`、`/pr`、`/doc`、`/standup`、`/translate`，需要哪个就拷到 `%USERPROFILE%\.ferry\commands\`。

例子：[examples/commands/](../examples/commands/)。

## 技能

技能是一个文件夹，里面有 `SKILL.md`，还可以放参考资料、模板和脚本。平时只有技能的名字和简介进系统提示；模型判断任务对得上时，才去读全文。你也可以用 `/skill:名字` 直接调用。Ferry 自带三个技能：`office`（读写和修订 Office/PDF）、`review`（交付物复核清单）、`grill`（动工前追问对齐结构与范围，也可直接输 `/grill`）；在 `.ferry\skills\` 或个人 `skills\` 放同名文件夹就能覆盖内置版本。

```markdown
---
name: release-notes
description: Write release notes from git history in this team's format. Use when asked for release notes ...
---
1. Find the range ...
4. Use the template in `template.md` next to this file.
```

`description` 决定模型什么时候想到用它，所以要写清楚"做什么"和"什么时候用"。格式遵循 [Agent Skills 规范](https://agentskills.io/specification)。

例子：[examples/skills/release-notes/](../examples/skills/release-notes/)。

## 子 agent

主 agent 可以用 `task` 工具把活交给子 agent。子 agent 的上下文是全新的，做完只把报告带回来。Ferry 自带四个：
- `explore`：只读，负责搜索和读代码；
- `research`：负责上网查资料、找原始出处；
- `review`：只读，对照最初要求检查做好的文档或代码；
- `general`：和主 agent 用一样的工具。

自己加一个：

```markdown
---
name: security-reviewer
description: Read-only security review of given files or changes. Use it after writing code that handles input ...
tools: read, grep, find, ls
model: deepseek-flash
---
You are a security reviewer. ...
```

- `tools` 不写，就用主 agent 的全部工具。
- `model` 不写，就用服务端管理页“子 agent 用”里选的模型（没单独选就跟主对话一样）；写了服务端提供的模型名（管理页里列的，比如 `deepseek-flash`），这个子 agent 就用它。查资料、整理这类杂活用便宜快速的模型能省不少钱。按名字指定时服务端要打开"工作电脑可以用 /model 自己挑"。
- 子 agent 改文件、执行命令同样要过权限，确认框会弹在你的主窗口里。
- `/help` 的最后列出现有的子 agent。

例子：[examples/agents/security-reviewer.md](../examples/agents/security-reviewer.md)。

## 钩子

在固定时机自动运行你写的命令：

```json
{
  "afterEdit": [
    { "match": "**/*.{ts,tsx}", "run": "npx --no-install prettier --write \"$FERRY_FILE\"" },
    { "match": "**/*.py", "run": "ruff check --fix \"$FERRY_FILE\"" }
  ],
  "onDone": [ { "run": "git status --short" } ]
}
```

- **afterEdit**：agent 改了一个对得上 `match` 的文件之后运行。命令失败（退出码不是 0）时，输出会附在修改结果后面交给 agent，它会接着修。可用的变量：`$FERRY_FILE`（完整路径）、`$FERRY_FILE_REL`（相对项目的路径）。加 `"show": true` 时，成功的输出也会交给 agent。
- **onDone**：agent 做完你的一个请求后运行，结果显示给你看。
- `"timeout"`：超时秒数，可选，默认 afterEdit 60 秒、onDone 120 秒。
- 命令在项目文件夹里执行。Windows 上有 Git Bash 就用 bash，没有就用 cmd。
- 项目里的 `.ferry\hooks.json` 会自动执行命令，所以第一次（以及文件每次被改动后）会先问你允不允许。
- `/status` 显示钩子文件在哪。

例子：[examples/hooks.json](../examples/hooks.json)。

## 权限规则

确认框里选"以后都允许"时，Ferry 会自动写规则。你也可以自己写：

```json
{
  "allow": ["bash(npm test*)", "edit(src/**)", "web_fetch(docs.python.org)", "bash(agent-browser*)"],
  "ask":   ["bash(git push*)"],
  "deny":  ["bash(curl*)", "read(secrets/**)"]
}
```

| 写法 | 管什么 |
|---|---|
| `bash(git log*)` | 以 `git log` 开头的命令。`*` 匹配任意内容；`shell(...)` 同时管 bash 和 PowerShell |
| `edit(src/**)` | 改 `src` 下任意层的文件，包括新建（write） |
| `read(secrets/**)` | 读文件（通常放在 deny 里） |
| `web_fetch(github.com)` | 读这个网站和它的子域名的网页 |
| `bash(agent-browser*)` | 浏览器的所有操作（打开网页、点击、填表）都不再问 |
| `mcp__github__*` | 某个 MCP 服务器的全部工具，这里是叫 github 的那个 |
| `powershell`、`task` | 只写工具名，就是这个工具的所有调用 |

- 规则文件有三个，内容合在一起生效：`%USERPROFILE%\.ferry\permissions.json`（你的，所有项目）、"以后都允许"自动写的个人项目文件、项目里的 `.ferry\permissions.json`（团队）。
- 优先级：禁止 > 询问 > 允许。
- 复合命令（`a && b`）要每一段都被允许才放行。
- 要删掉一条"以后都允许"，打开对应的文件删掉那一行。`/status` 显示这几个文件在哪。

例子：[examples/permissions.json](../examples/permissions.json)。

## MCP 服务器

MCP 服务器给 agent 加工具：查数据库、读 Jira、调内部系统。

**放在哪**

| 文件 | 管多大范围 |
|---|---|
| `%USERPROFILE%\.ferry\agent\mcp.json` | 你自己，所有项目 |
| 项目里的 `.ferry\mcp.json`，或 Claude Code 用的 `.mcp.json` | 这个项目。可以提交进仓库给团队用 |

格式和 Claude Desktop、Cursor 一样：

```json
{ "mcpServers": {
    "docs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/team-docs"] },
    "jira": { "url": "https://mcp.example.com/jira", "headers": { "Authorization": "Bearer ${JIRA_TOKEN}" } }
} }
```

**从别的应用导入**：已经在 Claude Desktop、Claude Code、Cursor、VS Code 或 Windsurf 里配好的，直接拷过来：

```bat
ferry mcp import                 :: 从所有找得到的应用导入
ferry mcp import cursor          :: 只从 Cursor
ferry mcp import D:\x\mcp.json   :: 从一个文件
```

同名的不会覆盖（加 `--force` 才覆盖）；旧的 SSE 方式不支持，会说明原因跳过。

**查看**

- `ferry mcp list`：Ferry 在这个文件夹里会用到哪些服务器、分别写在哪个文件里。
- `ferry mcp check`：逐个连一下，列出每个服务器的工具，连不上的显示原因。
- 在 ferry 里输入 `/mcp`：哪些已连接、各有几个工具；可以临时关掉某个、重新连接、登录需要 OAuth 的服务器。

**其他**

- 项目里的服务器会在这台电脑上启动程序，所以第一次用之前 Ferry 会问你；文件改了会再问。
- 你自己的 `mcp.json` 里有同名服务器时，用你的。
- MCP 工具同样过权限：只读的直接放行，其他的会问。
- `ferry mcp add <名字> -- <命令> [参数…]`、`ferry mcp add <名字> --url <地址>`、`ferry mcp remove <名字>` 直接改你的 `mcp.json`。
- 本地 MCP 服务器要用 npx 下载时，工作电脑要能访问 npm；装不了的话，先在别的电脑装好拷过去。

例子：[examples/mcp.json](../examples/mcp.json)。

## 服务端：团队的提示词和模型

这一项在服务端，作用于所有连上来的工作电脑：
- **提示词**：管理页 → 提示词。可以写全局提示词，也可以按项目写（项目名就是工作电脑上的文件夹名），还有写摘要时的要求。
- **模型**：管理页 → 服务商和模型，选默认模型和写摘要用的模型。

## 装 pi 的扩展包

pi 生态里有别人做好的扩展、技能和命令包，用 `ferry pkg` 安装（需要能访问 npm 或 git）：

```bat
ferry pkg install npm:<包名>
ferry pkg list
ferry pkg remove npm:<包名>
```

扩展包会在 ferry 进程里运行代码，装之前先看看它的源码。

## 更多：写 pi 扩展

上面这些都不够用时，可以用 JavaScript 或 TypeScript 写 [pi 扩展](https://github.com/earendil-works/pi)，放在 `%USERPROFILE%\.ferry\agent\extensions\`。扩展能加工具、命令、快捷键，也能拦截事件。Ferry 自己的功能就是这样做的，代码在 `client/lib/` 下，可以当例子看。
