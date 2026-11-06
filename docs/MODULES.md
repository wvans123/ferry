# 模块

Ferry 按模块开发：每个功能是一个模块，加的时候只动这个模块，不想要了整个拿掉，别的模块不受影响。这份文档写模块长什么样，以及现在有哪些模块。

## 一个模块包括什么

| 部分 | 客户端模块 | 服务端模块 |
|---|---|---|
| 代码 | `client/lib/<名字>.mjs`，导出 `create<名字>(cfg)`，返回一个 pi 扩展（注册工具、命令、事件） | `server/ferry_server/<名字>.py`，逻辑加一个 `mount(app, cfg, ...)`，自己注册自己的接口 |
| 接入 | `client/bin/ferry.mjs` 的 `extensionFactories` 里一行 | `app.py` 末尾一行 `<名字>.mount(...)` |
| 设置 | 写在 `client/lib/config.mjs` 的 `DEFAULTS` 和 `SETTINGS` 里；能关的给一个开关 | 写在 `config.py` 的 `Config` 里；管理页上要改的，在 `admin.py` / `admin.html` 加一块 |
| 测试 | `client/test/<名字>.test.mjs` | `server/tests/test_<名字>.py` |
| 端到端 | 用户能看到的行为，在 `selftest/run.py` 加一项检查（下一个空着的 F 编号），列进 GOAL.md；本地用 `--only F编号` 只跑它 | 同左 |
| 文档 | `docs/USAGE.md` 里一节 | `docs/SERVER.md` 里一节 |

规矩：

- 模块之间不互相调用内部函数。要共享的东西放进 `cfg`，或者通过 pi 的事件；公用的小工具（读设置、发请求头）放在 `config.mjs`。
- 能用命令行工具加一份技能说明（`SKILL.md`）解决的，就不要写成新工具：agent 用 bash 调用，Ferry 只负责把程序带上、把设置（代理、证书、浏览器路径）传进去。浏览器模块就是这样：程序放进 pi 的 bin 文件夹（每条命令的 PATH 上都有），技能只在浏览器打开时列出。Claude Code 和 Cursor 都是这么接外部能力的，也不会让每次请求多带一堆工具定义。
- 删一个模块：删它的代码、接入的那一行、它的设置、测试、F 检查和文档那一节，在 CLAUDE.md 的"故意删掉的"表里记一行原因。

## 现在的模块

核心模块（不能关）：

| 模块 | 做什么 | 代码 | 自测 |
|---|---|---|---|
| 增量同步 | 只传新增的消息，每个请求 ≤ 1 MB，服务端拼回完整对话 | `client/lib/sync.mjs`、`server/ferry_server/store.py`、`app.py` | F1–F5、F14、F17、F26、F47 |
| 模型接入 | 选模型、几家服务商分配和切换、限流和回退、Claude 原生接口、Responses 接口、费用 | `server/ferry_server/pool.py`、`presets.py`、`responses.py`、`usage.py`、`config.py` | F12、F25、F40、F60、F61 |
| 上下文 | 服务端写摘要、请求封顶、按模型上下文长度 | `server/ferry_server/fit.py`、`prompt.py`；`client/lib/commands.mjs`（`/context`）、`compact.mjs`（压缩失败两次就停、压缩后的提示）、`config.mjs`（压缩线） | F5、F21、F43、F48、F81、F82 |
| 提示词 | Ferry 自己的系统提示，服务端规则 | `client/lib/prompt.mjs`、`server/ferry_server/prompt.py` | F9、F10、F33、F63 |
| 权限 | 四种模式、规则、危险命令、禁止目录 | `client/lib/permissions.mjs`、`guard.mjs` | F15、F32 |
| 网络 | 公司代理、证书、网关确认页 | `client/lib/config.mjs`、`gateway.mjs` | F16、F27、F37、F62 |
| 终端界面 | 斜杠命令、插话、标题、头部 | `client/lib/commands.mjs`、`steer.mjs`、`title.mjs`、`brand.mjs`、`trim.mjs` | F38、F53 |
| 安装和更新 | 离线安装包、小更新包、`ferry update`（也升级本机服务端）、fd 和 rg | `client/lib/setup.mjs`、`toolbins.mjs` | F22、F24 |
| 管理页 | 服务端的本机网页 | `server/ferry_server/admin.py`、`admin.html` | 服务端单元测试 |
| 设备 | 每台电脑一个令牌 | `server/ferry_server/devices.py` | F55 |

功能模块：

| 模块 | 做什么 | 代码 | 开关 | 自测 |
|---|---|---|---|---|
| 记忆 | 项目、个人记忆；全局记忆在服务端 | `client/lib/memory.mjs`、`server/ferry_server/globalmem.py` | `memory`；全局记忆在管理页 | F28、F56、F78、F88 |
| 子 agent | `task`、`task_batch`；内置 explore、research（上网调研）、review（对照要求检查交付物）、general；`task` 的 `resume` 追问做完的子 agent（保留最近 5 个） | `client/lib/subagent.mjs` | `subagents`、`maxParallel`；`agents/<名字>.md` 换模型 | F29、F49、F89 |
| 工具输出 | 待办、长输出存文件、旧输出省略、`history_search`、`past_conversations` | `client/lib/tools.mjs` | `bigOutputBytes`、`trimOldOutputs` | F30、F31、F46、F48 |
| /goal | 一直做到完成 | `client/lib/goal.mjs` | `goalMaxTurns`、`goalBudget` | F41 |
| 后台任务 | `job_start` 等；任务结束时 agent 马上拿到结果，停下了就自己接着干 | `client/lib/jobs.mjs` | `wakeOnJobEnd` | F42、F86 |
| 回退 | `/rewind` | `client/lib/checkpoint.mjs` | — | F38 |
| 钩子 | 改完文件后自动跑检查 | `client/lib/hooks.mjs` | 有 `hooks.json` 才生效 | F39 |
| 提问 | `ask_user` | `client/lib/ask.mjs` | — | F65 |
| 联网 | `web_fetch`、`web_search`、网站黑名单 | `client/lib/web.mjs` | `web`、`blockedSites` | F35、F57、F64 |
| 搜索和读网页 | `web_search` 经服务端搜（模型自带的搜索，或 Tavily、Brave、博查），`web_fetch` 带问题时由服务端的模型读 | `server/ferry_server/search.py`；客户端在 `web.mjs` | 管理页 → 设置 → 网页搜索；不设就读 Bing 的结果页 | F66、F67 |
| 浏览器 | agent 用 agent-browser 命令操作本机 Edge / Chrome | `client/lib/browser.mjs`、`client/browser-skill/` | `browser`、`browserHeadless`、`browserPath` | F36 |
| MCP | 用户和项目的 MCP 服务器 | `client/lib/mcp.mjs` | 有配置才生效 | F44、F45 |
| Office | 读写 Word、Excel、PowerPoint、PDF；读旧版 .doc/.xls/.ppt；整个文件夹转成文本 | `client/lib/office.mjs`、`client/skills/office/` | — | F50、F75–F77 |
| 分块上传和重试 | 每个请求体不超过块大小；被网关或 Cloudflare 挡下时重发、减半；子 agent 不因一次失败而停 | `client/lib/upload.mjs` | `chunkBytes` | F80 |
| 隐藏模型名 | 右下角不显示模型名 | `client/lib/footer.mjs` | `showModel` | 单元测试 |
| 图片 | 读图前缩小；`image_create` 画图 | `client/lib/pictures.mjs`、`image.mjs`、`server/ferry_server/images.py` | `keepImages`；服务端选了画图模型才有 | F59 |
| 团队 | Paperclip 看板上的成员 | `client/lib/team.mjs`、`teamcli.mjs` | 由 Paperclip 启动时才生效 | F54 |
| 通知 | 响铃、Windows 通知、Bark 推手机 | `client/lib/phone.mjs`、`server/ferry_server/notify.py` | `notify`、`phoneNotify` | F52 |
| 旁问、顾问、回顾 | `advisor` 工具、`/btw`、长请求做完的一句话回顾，共用服务端一个接口；`review` 子 agent 和交付质量提示在 `subagent.mjs`、`prompt.mjs` | `client/lib/side.mjs`、`server/ferry_server/side.py`；`sync.mjs` 里 `cfg.side` 记着对话的服务端副本 | `advisor`、`recap`；服务端管理页的顾问模型 | F83–F85 |
| 问题报告 | `/report` 经服务端发 GitHub issue | `client/lib/report.mjs`、`server/ferry_server/report.py` | 服务端设了令牌才发到 GitHub | 单元测试 |

`server/ferry_server/report.py` 是第一个按 `mount()` 写法接入的服务端模块，`search.py` 是第二个。其他服务端功能的接口还写在 `app.py` 里，以后动到哪个就顺手搬成这个样子。
