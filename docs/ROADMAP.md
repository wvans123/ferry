# Ferry 路线图（2026-11 起）

原则：
- **按模块加功能**：每次只动一个模块，只测这个模块，发版前再跑全套自测。
- **Ferry 服务端始终是服务端**：它拼回完整对话、保管 Key、去请求模型。换的只是"前面的客户端"。

## 核心：把"按 Ferry 的规矩发给服务端"做成一个可复用的包

Ferry 客户端的规矩：只上传新增内容、单个请求不超过 1 MB、服务端已有的消息只发引用；服务端拼回完整对话再发给模型。现在这套逻辑在 ferry 客户端里（`client/lib/sync.mjs`）。把它单独拿出来，做成一个包（暂叫 ferry-transport），以后所有客户端都用它：

```
DSH / Codex / Claude Code / IDE ──(ferry-transport：增量、小块)──▶ Ferry 服务端 ──(完整对话)──▶ 模型
```

## 分支

- `main`：Ferry 自己的客户端 + 服务端，照常改进、发版。
- `integrations`：DSH、Codex、Claude Code 这些接入都在这个分支上做，不影响 main；做稳了再合回去。

## 顺序（integrations 分支）

| 顺序 | 模块 | 做什么 |
|---|---|---|
| 1 | ferry-transport | 从 ferry 客户端拆出发送逻辑，ferry 自己改用它（行为不变，自测全过） |
| 2 | DSH 当客户端（重点） | 写一个 DSH 插件 `dsh-llm-ferry`，DSH 的对话按 Ferry 的规矩发给 Ferry 服务端，模型列表来自服务端。DSH 自带的 llm-pi-ai 只认三种接口（openai-completions、openai-responses、anthropic-messages），不能靠改配置接入，所以照它的结构另写一个模型插件，发送部分换成 ferry-transport |
| 3 | 好用的客户端功能做成 DSH 插件 | 逐个挑：Office 读写、团队看板（Paperclip）、记忆、网关确认/证书处理等 |
| 4 | 本机转发口（给 Codex、Claude Code、Cline 等） | 工作电脑上开一个本机地址，这些工具把它当模型地址；转发口用 ferry-transport 发给 Ferry 服务端 |
| 5 | IDE 插件 | 需求还在时再做 |

main 分支上接着做：团队的调度员 + 看门狗（见下），agent 功能按模块改进。

## 团队怎么改（参考 DeepSeek Super-agent）

DeepSeek 想做的是"一个一直在线的 agent"：你在群聊、GitHub 里跟它说话，它同时推进很多件事，你不用记"这件事在哪个会话里"。做法：
- **调度员**只和你说话、只派活，不自己干活（不给 bash，用便宜快的模型）；
- **工人**各干各的，上下文互不干扰；
- **同一件事的后续消息直接给负责的工人**，不经过调度员；
- **看门狗**定时检查每个工人有没有实际进展。

对应到 Ferry 团队：
- Lead 改成调度员：只留 team 工具和只读工具，换便宜模型；你所有的话都对 Lead 说。
- "后续消息直达"：Paperclip 在任务下留言就会叫醒负责人，已经有了。
- 看门狗：定时看"进行中但很久没有新运行或新留言"的任务，去留言提醒负责人或叫醒 Lead。

## 不搬到服务端的东西

文件和命令永远在本地执行。服务端已经有对话全文；记忆、待办这些是几 KB 的小笔记，放本地就行。只有当 DSH 和 ferry 要共用同一份记忆时，再考虑让服务端存一份副本。

暂不做：邮件、聊天软件作为事件来源。

## 下一个模块：浏览器换成 agent-browser（待确认）

web_fetch 和浏览器的区别：web_fetch 只发一个 HTTP 请求，把网页的 HTML 转成文字，读不到靠 JavaScript 生成的内容，不能登录、点击、填表。浏览器是在电脑上真开一个 Edge，页面跑完脚本再读，能点、能填、能截图，也能用你已经登录的账号。

Ferry 现在的浏览器模块用微软的 Playwright MCP（默认关）。它的问题是：二十来个工具的定义每次请求都要带上；每次看页面返回整棵无障碍树，动辄几千 token；安装包里多了大约 19 MB。

打算换成 Vercel 的 [agent-browser](https://github.com/vercel-labs/agent-browser)（Apache-2.0）：

- 一个命令行程序，agent 用 bash 调用：`agent-browser open <网址>`、`snapshot -i`（只列可操作的元素，每个带一个 `@e1` 这样的编号）、`click @e3`、`fill @e5 "内容"`、`get text`、`screenshot`。官方说一次快照 200～400 token。
- 不加新的工具定义，配一份技能说明（`client/skills/browser/SKILL.md`）教 agent 怎么用，和 Claude Code、Codex 里的用法一样。
- 有 Windows x64 的原生程序；`--executable-path` 指向电脑上的 Edge，不用下载 Chrome；`--proxy` 走公司代理；`caCert` 用 ferry 的证书；`--profile` 可以保留登录状态；`--headed` 让你看到它在操作。
- Ferry 要做的：安装包带上 Windows 的程序，启动时把 Edge 路径、代理、证书写进它的配置，权限规则里把只读的子命令（snapshot、get、screenshot）算作只读，其他照常询问。

还没在 Windows 和公司代理下试过，要先在你的电脑上验证再替换。

## 看过、暂时不做的

| 项目 | 是什么 | 结论 |
|---|---|---|
| [agent-desktop](https://github.com/vercel-labs/agent-desktop) | 同一家的桌面版：通过系统的无障碍接口读、操作任何桌面程序（Windows 上是 UI Automation），也是命令行加快照编号的用法 | 暂不做。Word、Excel 已经直接改文件，不用操作窗口；在公司电脑上让 agent 点任意程序风险大；项目还在 labs 阶段。以后真要操作某个只有界面的内部程序，按同样的"命令行 + 技能说明"接进来，改动很小 |
| [Scrapling](https://github.com/D4Vinci/Scrapling) | Python 爬虫框架：伪装浏览器指纹、绕过 Cloudflare 验证、自适应选择器、并发爬取，带 MCP 服务器 | 不集成。工作电脑上的客户端不需要 Python，它还要下载自己的浏览器；我们要读的（3GPP、文档站）是普通页面；在公司网络里绕过网站的反爬也不合适。某个项目真要爬数据，agent 可以在那个项目里用命令装它 |
| [ClawChat](https://clawling.com/zh/chat/) | 一个聊天 App，让 Claude Code、Codex、OpenClaw、Hermes 这些 agent 和人在群聊里一起说话，agent 会主动发言 | 团队先用 Paperclip。ClawChat 的聊天服务在它自己的云上，不能自己部署，公司的工作内容不能放上去；它是聊天，不管任务、分工和进度。它"在手机上跟 agent 群聊"的想法，和上面"调度员只跟你说话"是一回事，等调度员做好了再看要不要接一个聊天入口 |

## 离商业产品还差什么（v0.24）

v0.24 可以自用、可以演示：服务端单元测试 57 个、客户端单元测试 31 个、端到端自测 64 项，在 Linux 和 Windows 上自动跑。作者的工作电脑经 Cloudflare 连到自己的服务端，日常在用。

| 方面 | 现在有 | 还缺 |
|---|---|---|
| agent | /goal 长任务、后台任务、权限模式、记忆（项目、个人、全局）、子 agent 和批量派活、待办清单、斜杠命令、技能、钩子、MCP、回退、联网和下载、浏览器、Office、读图和画图、思考、可调上下文 | 命令在沙箱里跑（Codex 的做法）；用真实模型衡量 agent 干活的效果（现在的自测用假模型，只能证明管道通） |
| 服务端 | 增量同步、组装提示词、选模型、Claude 原生接口和提示词缓存、OpenAI Responses 接口、多服务商分配和切换、限流和回退、服务端写摘要、用量和费用、管理页 | 按人的用量上限 |
| 可靠性 | 缓存丢失自动恢复、版本协商、自动跟进 pi 更新 | 多实例部署（目前是单机 SQLite）、数据备份 |
| 安全 | 多用户隔离、每台电脑一个令牌、恒定时间令牌比较、拒绝弱密钥、日志不含正文、管理页只限本机 | 登录尝试限速、令牌过期、客户端令牌存进系统凭据库 |
| 真实环境 | Linux 和 Windows 上用假模型、假代理、假网关验证；作者的工作电脑实际使用 | 更多公司网络环境下的验证 |
| 交付 | 离线安装包、一条命令安装和更新、自动发版 | 代码签名、安装向导（.msi） |
