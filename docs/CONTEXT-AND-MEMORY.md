# 上下文管理和记忆：参考了谁，Ferry 怎么做

这份文档对比了 pi、Cursor、Claude Code、Codex CLI 四个成熟实现的做法，再给出 Ferry 的方案和实现顺序。

## 1. 先分清三件事

| 问题 | 例子 | 一句话 |
|---|---|---|
| 规则（人写给 agent 的） | "这个项目用 pnpm"、"回复用中文" | 每次对话都要带上，不会变 |
| 记忆（agent 自己学到的） | "用户纠正过：测试要用真数据库"、"用户是做 3GPP 标准的" | 跨会话记住，会慢慢变多 |
| 上下文（这次会话里的东西） | 读过的文件、执行过的命令、聊过的话 | 只在这次会话里，太长了要压缩 |

## 2. 四个参考实现怎么做

| | pi（Ferry 用的引擎） | Cursor | Claude Code | Codex CLI |
|---|---|---|---|---|
| 规则文件 | `AGENTS.md` / `CLAUDE.md`，从当前目录往上找；用户级放在 agent 目录 | `.cursor/rules/*.mdc`，可设"总是加载 / 相关时加载 / 打开匹配文件时加载 / @ 时加载"；另有团队规则和用户规则 | `CLAUDE.md`（组织、项目、用户三级），`.claude/rules/` 按路径加载；建议每个文件少于 200 行 | `AGENTS.md`，明确优先于记忆 |
| 自动记忆 | 没有 | Memories：从对话里生成，后台生成的要用户批准后才保存 | auto memory：每个项目一个目录，`MEMORY.md` 索引（每次加载前 200 行或 25KB）+ 每条一个文件，分 user / feedback / project / reference 四类；能从代码推出来的不记 | Memories：会话空闲后抽取，再用小模型合并，存在 `~/.codex/memories/` |
| 上下文太长 | 接近窗口时把旧消息写成结构化摘要（目标、进展、读过和改过的文件），保留最近约 2 万 token 原文 | 摘要时给 agent 一个"完整历史文件"的引用，摘要漏了的细节可以回去搜 | 自动压缩 + `/compact` | 接近窗口时压缩成摘要 |
| 大的工具输出 | 模型最多看到 2000 行或 50KB；命令输出超出时全文存到临时文件并告诉模型路径；MCP 结果超过 20KB 时去掉中间、全文存文件 | **写进文件**，只把结尾给模型，需要时再用 `tail`/`grep` 读 | 未查证 | 未查证 |
| 工具和技能说明 | 技能只放名字和简介，用到时再读全文 | MCP 工具说明放进文件夹，只留名字；实测涉及 MCP 的任务总 token 减少 46.9% | 技能按需加载 | 技能按需加载 |

几个共同点：

1. **规则是人写的、确定的；记忆是 agent 写的、可能错的。** 所有产品都让规则优先于记忆，记忆要能看、能改、能删。
2. **记忆要小。** 只在每次对话开头放一个索引，细节用到时再读。
3. **能从代码里查到的东西不进记忆**，避免和代码对不上。
4. **少放进上下文，多放进文件，让 agent 自己去读**，比截断和摘要都省、也更不容易丢信息。

## 3. Ferry 现在已经有的

| 能力 | 在哪 | 状态 |
|---|---|---|
| 项目规则 `AGENTS.md` | 客户端，pi 自带：项目目录和上级目录里的 `AGENTS.md` / `CLAUDE.md` 自动加载 | 可用 |
| 用户规则 | 客户端，`%USERPROFILE%\.ferry\agent\AGENTS.md` | 可用 |
| 团队规则 | 服务端 `rules\_global.md` 和 `rules\<项目名>.md`，拼在客户端系统提示后面，改完下一轮生效 | 可用 |
| 会话摘要 | 客户端（pi），接近模型窗口时 | 可用 |
| 请求封顶 | 服务端，超过 900KB 时删最旧的工具输出 | 可用 |
| 摘要用便宜模型 | 服务端 `[routing] summary` | 可用（v0.6） |
| 对话存在哪 | 客户端始终保存完整记录；服务端按设置缓存在磁盘、只在内存，或完全不存 | 可用（v0.6） |
| 记忆 | 客户端，`memory` 工具 + 每层一个 `MEMORY.md` 索引（v0.10） | 可用 |
| 大输出写文件 | 客户端，超过 8KB 的命令和搜索输出（v0.10） | 可用 |
| 找回被压缩的细节 | 客户端，`history_search` 工具（v0.10） | 可用 |
| 子 agent | 客户端，`task` 工具，独立上下文（v0.10） | 可用 |

## 4. 方案（第 1 到 3 步已在 v0.10 实现，和下面写的一致，只有一处不同：记忆目录是 `memory\user\` 和 `memory\projects\<文件夹名>-<哈希>\`，工具叫 `memory`，可以存、读、删）

### 第 1 步：大输出写文件，门槛收紧（参考 Cursor）

pi 已经会把超长的命令输出存成文件，但门槛是 50KB：几次这样的输出就占掉 1MB 限制的很大一块。Ferry 把门槛降到 8KB，并且对所有工具（命令、搜索、MCP）一视同仁：全文存到 `%USERPROFILE%\.ferry\outputs\`，发给模型的只有开头、结尾各几十行加文件路径和总行数，模型需要时自己用 `read`（可指定行范围）或 `grep` 去读。

- 为什么先做它：大输出是撑大上下文最快的东西。这一步直接减少压缩次数和服务端删输出的次数，花的 token 也更少。
- 怎么做：pi 扩展的 `tool_result` 事件可以替换工具结果，pi 的扩展文档也推荐这种写法，不用改 pi。
- 风险：模型可能不去读该读的文件。对策是在结果里写清楚"全文在某路径，共多少行，这里只显示了哪几行"。

### 第 2 步：自动记忆（参考 Claude Code）

- **存在客户端**：`%USERPROFILE%\.ferry\memory\<项目名>\`，一个 `MEMORY.md` 索引，每条记忆一个文件，分 user（你是谁、偏好）、feedback（你的纠正）、project（决定、截止日期）、reference（外部资料在哪）四类。和"客户端是唯一可信来源"的原则一致，也意味着公司电脑上的记忆不出这台电脑（发给模型前同样会脱敏）。
- **怎么进上下文**：每次对话开头把索引的前 200 行放进系统提示（pi 的 `before_agent_start` 事件）。
- **怎么写**：给模型一个 `remember` 工具，只能写记忆目录，所以不弹确认框；规则里说清楚"能从代码查到的不记、和规则冲突时以规则为准"。
- **怎么管**：`/memory` 命令列出、查看、删除；记忆就是普通 Markdown 文件，也可以直接用编辑器改。
- **可选设置**：`memory = "client"`（默认）/ `"server"`（放服务端，几台电脑共享）/ `"off"`。

### 第 3 步：找回被压缩掉的细节（参考 Cursor）

压缩后给模型一个 `history_search` 工具，在本地完整会话记录（pi 的会话文件）里搜索。摘要漏掉的报错信息、文件内容可以找回来，不用再执行一遍命令。

### 第 4 步：服务端摘要

服务端封顶时，不再直接删旧输出，而是用便宜模型把它写成一两句话的摘要。

## 5. 不打算做的

- **代码库向量索引**（Cursor 的语义检索）：需要把代码分块上传到服务端建索引，和"敏感内容尽量不出公司电脑"冲突。先用 `grep` + 大输出写文件，效果不够再考虑只在客户端建索引。
- **后台自动抽取记忆**（Codex 的做法）：会话结束后额外花 token 去整理，结果还要人审。先用"对话中由模型主动 remember + 你可以随时删"的方式。

## 参考资料

- pi：`docs/compaction.md`、`docs/configuration.md`（随 npm 包分发）
- Cursor：[Dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery)，[How Cursor Memory Works](https://www.past.dev/blog/cursor-memory)
- Claude Code：[How Claude remembers your project](https://code.claude.com/docs/en/memory)
- Codex CLI：[Agent-native memory systems taxonomy](https://codex.danielvaughan.com/2026/06/30/agent-native-memory-systems-taxonomy-codex-cli-memories-compaction-mcp-persistence-architecture/)
