# Ferry

**一个能在受限的公司电脑上用的编码 agent，用法像 Claude Code / Cursor CLI：在 cmd 里输入 `ferry`，用中文说要做什么，它读代码、改文件、跑命令。**

A Claude-Code-style coding agent for locked-down Windows PCs: the agent runs on the work computer, a small server you control holds the API keys, builds the prompt and calls the model, and every request leaving the PC stays under 1 MB.

[![test and release](https://github.com/wvans123/ferry/actions/workflows/ci.yml/badge.svg)](https://github.com/wvans123/ferry/actions/workflows/ci.yml)

```
C:\my-project> ferry

  Ferry v0.12.0  server ferry.example.com
  Files and history stay on this machine. The server builds the prompt and calls the model.
  memory: 3 (/memory)  ·  subagents on  ·  type / for commands (/init /review /undo /status)

> 登录接口在密码错误时返回 500，帮我查一下原因并修好
  ● search "password" in src ... read AuthController.java ... edit AuthService.java
    Allow edit?  → Allow once / Allow all file changes / Deny
  原因是 ……，已改 AuthService.java 第 42 行，并补了一个测试，mvn test 通过。
                                                           ask before edits and commands (shift+tab)
```

**适合这样的环境**：
- 公司电脑对外的单个请求不能太大（Ferry 每个请求都不超过 1 MB）；
- 公司电脑上不想放模型的 API Key；
- 用哪个模型想由自己决定，比如 DeepSeek、Kimi、通义、智谱，或者任何 OpenAI 兼容接口。

## 目录

- [它是怎么工作的](#它是怎么工作的)
- [先选一种部署方式](#先选一种部署方式)
- [服务端：装在哪、怎么装](#服务端装在哪怎么装)
- [工作电脑：装客户端](#工作电脑装客户端)
- [日常使用](#日常使用)：命令、斜杠命令、权限、记忆、子 agent、联网、浏览器、撤销
- [自己动手扩展](#自己动手扩展)
- [设置一览](#设置一览)
- [出问题了怎么办](#出问题了怎么办)
- [安全须知](#安全须知)
- [设计](#设计)、[开发](#开发)、[离商业级还差什么](#离商业级还差什么)

## 它是怎么工作的

```
工作电脑                                       Ferry 服务端（你自己的电脑或服务器）             模型
┌──────────────────────────────┐   只传新增部分   ┌──────────────────────────────┐            ┌──────────┐
│ ferry（agent）                │ ── 每次 ≤ 1MB ──> │ 拼回完整对话、加团队提示词、   │ ─────────> │ DeepSeek │
│ 读写文件、执行命令、记忆、权限 │ <── 逐字返回 ──── │ 选模型、（可选）脱敏、存 Key  │ <───────── │ Kimi ... │
└──────────────────────────────┘                  └──────────────────────────────┘            └──────────┘
```

- **干活的在工作电脑上**：agent 引擎是开源的 [pi](https://github.com/earendil-works/pi)，Ferry 在它上面加了权限、记忆、子 agent、联网、浏览器、斜杠命令等扩展。代码、对话记录、记忆都留在工作电脑上。
- **服务端只负责"问模型"这一步**：把工作电脑传来的新增内容拼回完整对话，加上团队提示词，选模型，然后调用。API Key 只在服务端。
- **为什么每次只传一点**：长对话的上下文会超过 1 MB，所以 Ferry 每轮只上传新增的消息，太大的拆成 512 KB 的小块，服务端再拼起来。

## 先选一种部署方式

| 你的情况 | 部署方式 | 要多久 |
|---|---|---|
| 就一台电脑，能直接访问模型 API | **单机**：装好就用，服务端由 ferry 自动在本机启动 | 5 分钟 |
| 公司电脑受限，家里或自己有一台 Windows 电脑 | **家里电脑当服务端** + Cloudflare 域名，工作电脑连过来 | 30 分钟 |
| 同上，但手边是 Mac | **Mac 当服务端** + Cloudflare 域名 | 30 分钟 |
| 要一直在线，或要用 Claude / OpenAI | **Linux 云服务器** + HTTPS | 30 分钟 |

Anthropic（Claude）和 OpenAI 的 API 不服务中国大陆和香港。要用这两家，服务端要放在它们支持的地区。

## 服务端：装在哪、怎么装

### 单机（服务端和客户端在同一台电脑）

需要 Node.js 22+ 和 Python 3.11–3.14。所有命令在 **cmd** 里执行。

1. 下载 [Releases](https://github.com/wvans123/ferry/releases/latest) 里的 `ferry-windows-x.y.z.zip`，右键"全部解压"。安装包是离线的，不需要 npm、PyPI，也不需要 venv。
2. 安装：
   ```bat
   cd /d %USERPROFILE%\Downloads\ferry-x.y.z
   node client\bin\ferry.mjs install
   ```
3. 设置 API Key，然后**重新打开 cmd**：
   ```bat
   setx DEEPSEEK_API_KEY sk-你的key
   ```
4. 检查并开始用：
   ```bat
   ferry doctor
   cd /d C:\你的项目
   ferry
   ```

每次运行 `ferry`，它都会在本机后台启动一个服务端，退出时一起关掉。截图式的详细步骤见 [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md)。

### 家里的 Windows 电脑 / Mac / Linux 服务器

| 服务端在 | 步骤 |
|---|---|
| Windows | [docs/DEPLOY-WINDOWS.md](docs/DEPLOY-WINDOWS.md)：用安装包装服务端 → 桌面图标打开管理页 → 填 API Key → Cloudflare Tunnel 给它一个域名 |
| Mac | [docs/DEPLOY-MAC.md](docs/DEPLOY-MAC.md)：`pipx install` → 开机自启脚本 → Cloudflare Tunnel |
| Linux | [docs/DEPLOY-LINUX.md](docs/DEPLOY-LINUX.md)：`pipx install` → systemd → Caddy 自动 HTTPS |

都装好后，服务端有一个**管理页**，只能在服务端那台电脑上打开：Windows 上双击桌面的 Ferry Server，或者运行 `ferry-server --ui`。

![服务商和模型](docs/images/admin-providers.png)

| 管理页 | 能做什么 |
|---|---|
| 概览 | 工作电脑要用的登录命令（一键复制，带令牌）、流量图、最近的调用 |
| 服务商和模型 | 选预设（DeepSeek、Kimi、智谱、通义、火山、硅基流动、各家编程套餐、Claude、OpenAI、OpenRouter、本机 Ollama、自定义），**只填 API Key**；读出服务商的模型列表，勾选要用的；选默认模型和写摘要用的模型 |
| 提示词 | 所有工作电脑都会带上的团队提示词，可以按项目写 |
| 脱敏 | 默认关闭。打开后，敏感词表和内网 IP、邮箱、手机号、Key 这类内容会先换成占位符再发给模型，回复里再换回来 |
| 调用记录 | 每次调用的项目、模型、大小、token、耗时，可以点开看详情 |
| 设置 | 外网地址、服务端存不存对话、请求上限、联网代办、开机启动、换令牌 |

API Key 存在服务端的 `secrets.toml` 里，任何接口都只显示最后 4 位。

## 工作电脑：装客户端

工作电脑上只装客户端，需要 Node.js 22+，不需要 Python。

**方式一：安装包**（推荐，离线，已经带好全部依赖和 fd、rg）

```bat
cd /d 解压出的 ferry-x.y.z 文件夹
node client\bin\ferry.mjs install --client-only
```

**方式二：git clone**（要能访问 npm）

```bat
git clone https://github.com/wvans123/ferry && cd ferry
npm ci
node client\bin\ferry.mjs install --client-only
```

公司网络要走代理的话，先执行 `npm config set https-proxy http://代理:端口`。

**然后连到服务端**：在服务端管理页的"概览"里复制登录命令，粘贴到工作电脑的**新** cmd 窗口里运行，再检查一遍：

```bat
ferry login https://ferry.example.com 你的令牌
ferry doctor
```

`ferry doctor` 全是 OK 就可以用了。

**更新**：用安装包装的执行 `ferry update`；git clone 的执行 `git pull`、`npm ci`，再跑一遍 `install`。有新版本时，ferry 启动时会提醒你。

**公司网关先要你确认**：如果服务端地址被公司网关拦下，要你先确认一下（"访问提醒"页），ferry 会自动在浏览器里打开那一页。你点"继续"后，它自己接着启动。想一劳永逸，就请 IT 把服务端地址加进白名单。

## 日常使用

在项目文件夹里输入 `ferry`，然后直接用中文说要做什么。

### 键盘

| 按键 | 作用 |
|---|---|
| Enter | 发送；Shift+Enter 或 Ctrl+J 换行 |
| **Shift+Tab** | 切换权限模式（见下文） |
| Esc | 打断 agent 正在做的事 |
| Ctrl+C 连按两次 | 退出 |
| `/` | 列出所有斜杠命令 |
| `@` | 引用文件（输入文件名会自动补全） |
| `!命令` | 自己执行一条命令，输出也会给 agent 看，比如 `!git status` |

### 命令行

| 命令 | 作用 |
|---|---|
| `ferry` | 在当前文件夹开始对话 |
| `ferry -c` / `ferry -r` | 接着上次的对话 / 从以前的对话里选一个 |
| `ferry -p "问题"` | 只问一句，打印回答后退出（适合放进脚本） |
| `ferry doctor` | 逐项检查：网络、令牌、模型、搜索工具 |
| `ferry config` | 查看和修改客户端设置 |
| `ferry login <地址> <令牌>` / `ferry logout` | 连到远程服务端 / 改回本机服务端 |
| `ferry update` | 更新到最新版 |
| `ferry --version --all` | 显示 Ferry 和 pi 的版本 |

### 斜杠命令

| 命令 | 作用 |
|---|---|
| `/init` | 读一遍项目，写出 AGENTS.md（项目说明，以后每次对话都会带上）。**新项目先运行这个** |
| `/review [范围]` | 审查当前改动（或某个分支、文件），按严重程度列问题 |
| `/commit` | 按仓库的风格写提交信息并提交（不推送） |
| `/explain <文件或问题>` | 讲清楚一段代码 |
| `/test [范围]` | 跑测试，修好失败的 |
| `/fix <报错>` | 找到根本原因并修好 |
| `/pr`、`/doc <对象>` | 写合并请求说明、写文档 |
| `/plan <任务>` | 切到只读规划模式，先出方案，不动文件 |
| `/undo` | 把 agent 改过的文件恢复到某次请求之前的样子 |
| `/remember [user] <内容>` | 直接记进记忆（加 `user` 表示所有项目都记得） |
| `/memory`、`/permissions`、`/hooks`、`/agents` | 查看记忆、权限规则、钩子、子 agent |
| `/status` | 服务端、延迟、模型、模式、工具一览 |
| `/compact`、`/new`、`/resume`、`/model` | 压缩上下文、新对话、换对话、换模型（pi 自带） |

自己写斜杠命令，见[自己动手扩展](#自己动手扩展)。

### 权限：该问的才问

**Shift+Tab** 在四种模式之间切换，底栏显示当前模式：

| 模式 | 改文件 | 执行命令 |
|---|---|---|
| 默认 | 问 | 只读命令（`git status`、`dir`、`rg`……）不问，其他问 |
| 自动改文件 | 项目文件夹里的不问 | 同上 |
| 只读规划 | 不允许 | 只允许只读命令 |
| 全部放行 | 不问 | 不问 |

- 确认框里可以选"以后都允许这类命令"，比如以 `npm test` 开头的命令。Ferry 会按项目记住。
- 危险操作（删整个目录、`git push --force`、`git reset --hard`、`curl … | sh`……）在除"全部放行"以外的模式下都会问，并说明危险在哪。
- 改项目文件夹以外的文件，总要先确认。
- `.env`、`.ssh` 这类路径永远不碰（`ferry config set blockedPaths ...` 可改）。
- 启动时用哪种模式：`ferry config set permissionMode acceptEdits`。

### agent 还能做什么

| 能力 | 说明 |
|---|---|
| 任务清单 | 多步任务先列计划，输入框上方显示进度 |
| 记忆 | 跨对话记住你的偏好、纠正和项目里的决定。说"记住……"或"忘掉……"即可。分你个人（所有项目）和这个项目两层，存在工作电脑 `%USERPROFILE%\.ferry\memory`，都是可以直接改的 Markdown 文件 |
| 子 agent | "在整个代码库里找……"这类活交给上下文全新的子 agent，只把结论带回来，主对话不会被撑大。几个子 agent 可以同时跑 |
| 联网 | `web_search`（Bing）、`web_fetch`（读网页），在工作电脑上执行，走公司代理，受公司网关管。读网页时按网站询问 |
| 浏览器 | `ferry config set browser true` 后，agent 能操作电脑上的 Edge：打开网页、点击、填表、读页面 |
| 长输出 | 命令输出太长时，全文存到文件，只给模型看开头和结尾，需要时它自己去读 |
| 压缩和找回 | 对话太长时自动写摘要；之后需要原文时，用 `history_search` 在本地完整记录里找回 |
| 撤销 | `/undo` 把文件恢复到某次请求之前。只管 agent 用 edit/write 改的文件，命令造成的改动请用 git |
| 提醒 | 一个请求超过 30 秒才做完时，会响一声并弹出 Windows 通知 |

## 自己动手扩展

不用写代码，放几个文本文件就行。仓库的 [examples/](examples/) 里每样都有现成的例子，详细说明见 [docs/CUSTOMIZE.md](docs/CUSTOMIZE.md)。

| 想做的事 | 放一个文件 |
|---|---|
| 让 agent 了解项目 | 项目根目录的 `AGENTS.md`（`/init` 自动生成） |
| 加一个斜杠命令 | `.ferry\commands\standup.md` → `/standup` |
| 教它一类任务的做法 | `.ferry\skills\release-notes\SKILL.md` |
| 加一个专门的子 agent | `.ferry\agents\security-reviewer.md` |
| 改完文件自动格式化、检查 | `.ferry\hooks.json` |
| 哪些命令不用问、哪些禁止 | `.ferry\permissions.json` |
| 接数据库、Jira、内部系统 | `%USERPROFILE%\.ferry\agent\mcp.json`（MCP） |

- 放在项目的 `.ferry\` 下只管这个项目，可以提交进仓库给团队用；放在 `%USERPROFILE%\.ferry\` 下对你所有项目生效。
- Claude Code 的 `.claude\commands`、`.claude\agents`、`.claude\skills`、`CLAUDE.md` 也直接能用。

## 设置一览

**客户端**：`ferry config` 查看，`ferry config set <名字> <值>` 修改。

| 名字 | 默认 | 作用 |
|---|---|---|
| `permissionMode` | `default` | 启动时的权限模式：`default` / `acceptEdits` / `plan` / `bypass` |
| `memory` | `true` | 跨对话的记忆 |
| `subagents` | `true` | 子 agent（task 工具） |
| `web` | `client` | 联网工具在哪执行：`client`（这台电脑）/ `server`（服务端代办，需服务端开启）/ `off` |
| `browser` | `false` | 让 agent 操作本机浏览器（Edge / Chrome）；`browserPath` 指定别的浏览器，`browserHeadless` 不显示窗口 |
| `blockedPaths` | `.env,.ssh,id_rsa,secrets,credentials` | 永远不读、不改、不在命令里出现的路径 |
| `bigOutputBytes` | `8192` | 输出超过多少字节就存文件（0 = 不存） |
| `notify` / `notifyAfterSeconds` | `true` / `30` | 长请求结束时响铃加通知 |
| `updateCheck` | `true` | 每天看一次 GitHub 上有没有新版本 |
| `proxy` | 空 | 连服务端用的代理，空 = 用 `HTTPS_PROXY` 环境变量 |

界面、上下文压缩这类 agent 本身的设置，在 ferry 里输入 `/settings`，或改 `%USERPROFILE%\.ferry\agent\settings.json`。

**服务端**：大多在管理页里改，存在服务端数据目录的 `server.toml`。也可以用环境变量：

| 环境变量 | 作用 |
|---|---|
| `FERRY_SERVER_HOME` | 数据放哪，比如 `D:\ferry\server`（令牌、Key、models.toml、日志） |
| `DEEPSEEK_API_KEY` 等 | 也可以用环境变量给 Key（优先于管理页里填的） |
| `FERRY_SESSION_STORE` | 服务端存不存对话：`memory`（默认）/ `disk` / `none` |
| `FERRY_REDACT` | `1` 打开脱敏（默认关闭） |
| `FERRY_WEB` | `1` 允许服务端替工作电脑联网（默认关闭） |

多用户的服务器改用完整配置文件 `ferry-server.toml`，参考 [server/ferry-server.example.toml](server/ferry-server.example.toml)。

## 出问题了怎么办

先运行 `ferry doctor`，它会逐项检查，并告诉你下一步该做什么。

| 看到 | 原因和办法 |
|---|---|
| `the company network gateway wants a confirmation` | 公司网关要你先确认。运行 `ferry`，它会在浏览器里打开确认页；长期办法是请 IT 加白名单 |
| `cannot reach the server` | 浏览器能打开但 ferry 连不上，通常是浏览器走了公司代理。执行 `setx HTTPS_PROXY http://代理:端口`，然后重开 cmd |
| `unable to get local issuer certificate` | 公司代理会解开 HTTPS 再加密。把公司根证书导出成 .pem，执行 `setx NODE_EXTRA_CA_CERTS C:\路径\证书.pem` |
| `a Cloudflare Access login page answered` | 服务端地址前挡着 Cloudflare 的登录页，见 [DEPLOY-MAC.md](docs/DEPLOY-MAC.md#关于那个-cloudflare-登录页) |
| `token rejected` | 令牌不对或换过了。到管理页复制新的登录命令 |
| `HTTP 502 / 530` | 服务端那台电脑睡眠了，或者服务端、cloudflared 没在运行 |
| `model ... HTTP 401 / 402 / 403` | Key 不对 / 账户没余额 / 服务商不服务你所在的地区 |
| `fd and rg not found` | 用安装包装一次，或者把安装包里 `vendor\win32-x64\` 下的两个 exe 拷到 `%USERPROFILE%\.ferry\agent\bin\` |
| 命令输出是乱码 | 告诉我是哪条命令。PowerShell 和 Python 已经强制 UTF-8 |
| 联网返回 `000` 或连不上 | 工作电脑的命令行上不了外网。让 agent 用 `web_fetch`，不要用 curl |

## 安全须知

- **服务端能看到对话原文**（`session_store = "none"` 时处理完就丢），所以服务端必须是你信得过的机器，并且只用 HTTPS 访问。
- **脱敏默认关闭**。打开后，也只有词表和内置规则命中的内容会被替换，其他信息照样会发给模型。脱敏能降低风险，但不是保证。公司明确不允许外发的内容，就不要交给 agent。
- **联网默认在工作电脑上执行**，受公司网关管，Ferry 不会替你点掉网关的确认页。改成服务端代办（`web = server`），等于让工作电脑经你的服务端访问外网，开启前请确认公司规定允许。
- **令牌**存在工作电脑的 `%USERPROFILE%\.ferry\config.json` 里。泄露了就在管理页换一个新的。
- 试用时请先拿一个测试文件夹和编的内容。

## 设计


| 问题 | 做法 | 代码位置 |
|---|---|---|
| 单个请求 ≤ 1MB，但长会话的上下文会超过 1MB | 客户端每轮只上传新增消息，用哈希链校验双方一致；超过 512KB 的内容拆块上传；服务端拼回完整上下文再发给模型 | `client/lib/sync.mjs`、`server/ferry_server/store.py` |
| 服务端缓存丢了怎么办 | 客户端始终保存完整记录；服务端只是缓存。校验不一致时返回 409，客户端自动全量重传 | 同上 |
| 提示词由谁决定 | 和 Cursor 一样由服务端完成最终组装：通用规则 + 按项目的规则，改完下一轮即生效，不用动客户端 | `server/ferry_server/prompt.py` |
| 敏感信息不外发（可选，默认关闭） | 词表和正则命中的内容替换成确定性占位符 `[FERRY-XXXXXXXX]`（HMAC），同一个值始终对应同一个占位符，模型看到的对话前后一致 | `server/ferry_server/redact.py` |
| 模型回复里的占位符 | 正文逐字转发，只暂扣可能是占位符开头的最多 15 个字符；工具调用参数在该轮结束时一次性还原后发出，客户端永远拿到真实路径和命令 | `server/ferry_server/stream.py` |
| 用哪个模型由服务端决定 | 客户端只看到一个 `auto` 模型；服务端按设置把干活的请求和写摘要的请求分别发给不同模型。统一走 OpenAI 兼容接口：DeepSeek、OpenAI、Claude（Anthropic 的兼容接口） | `server/ferry_server/app.py`、`config.py` |
| 服务端存不存对话 | 设置项 `session_store`：存磁盘（省流量）、只存内存、完全不存（每轮整段重传，仍按 512KB 分块，单个请求不超过 1MB） | `server/ferry_server/store.py` |
| 本地安全底线 | 禁止目录、执行前确认都在客户端执行，服务端无法绕过；拦截原因里不含受保护的名字 | `client/lib/guard.mjs` |
| 可审计 | 访问日志和审计日志只记大小、模型、脱敏计数、用量，不记对话内容 | `server/ferry_server/app.py` |
| 上下文太长 | 三层：长输出在客户端写文件，只给模型开头结尾；pi 在接近模型窗口时把旧历史写成摘要，压缩后能用 `history_search` 找回原文；服务端在发给模型前封顶（默认 900KB），从最旧的工具输出开始删 | `client/lib/tools.mjs`、`server/ferry_server/prompt.py` |
| 记忆放哪 | 客户端：内容本来就是关于这台电脑上的代码和你的习惯；服务端只转发，换服务端不丢记忆。只有目录进系统提示，正文按需读取 | `client/lib/memory.mjs` |
| 子 agent | 在同一个进程里另起一个 pi 会话（内存里，不存盘），作为一个独立对话同步到服务端；审批对话框借用主窗口 | `client/lib/subagent.mjs` |
| 权限 | 每次工具调用先过 `decide()`：受保护路径 → 禁止规则 → 模式 → 危险命令 → 询问规则 → 只读命令 → 允许规则；复合命令按 `&&` `;` `|` 拆开逐段判断。几个工具同时要确认时排队一个一个问，前一个回答存下的规则后面的直接用 | `client/lib/permissions.mjs`、`guard.mjs` |
| 系统提示 | 用 Ferry 自己的开场和工作方式代替 pi 的（不再提 pi 文档，避免模型去翻 agent 自己的配置），保留 pi 的工具说明，加上操作系统、shell、日期、是否 git 仓库 | `client/lib/prompt.mjs` |
| 联网 | 默认在客户端执行，走公司代理，识别网关的确认页（按地址和页面文字）并报告，不点击通过；可选服务端代办：只允许 http(s)，拒绝本机和内网地址（管理页信任本机来的请求，不能让网页请求绕到它），每次跳转都重新检查，可设网站白名单 | `client/lib/web.mjs`、`server/ferry_server/web.py` |
| 公司网关要先确认 | 启动时发现服务端地址被网关转到确认页，就用浏览器打开那一页，每 2.5 秒检查一次，你确认后自动继续；会话中途确认过期，也会重新打开并提示重发 | `client/lib/gateway.mjs` |
| 跟着 pi 更新 | Ferry 只用 pi 公开的扩展接口，不改 pi 本身，所以不 fork。每周一自动检查 pi 新版本：换上新版本后在 Linux 和 Windows 上跑全部测试（含终端界面冒烟测试），都通过才提交并发布 Ferry 新版本 | `.github/workflows/update-pi.yml`、`scripts/bump_pi.mjs` |
| 斜杠命令和自定义 | 内置命令是 Markdown 模板（`client/commands/`）；用户和项目的命令、技能目录通过 pi 的 `resources_discover` 事件加进去，同名时项目覆盖用户、用户覆盖内置 | `client/lib/commands.mjs` |
| 撤销 | 每次请求里第一次 edit/write 一个文件前，把原内容按哈希存一份；`/undo` 选一个请求，把它和之后改过的文件恢复，并告诉模型这些文件变了 | `client/lib/checkpoint.mjs` |
| 钩子 | `afterEdit` 在工具结果出来后运行，失败输出追加到工具结果里交给模型；项目的钩子文件按内容哈希征得同意，改了要重新同意 | `client/lib/hooks.mjs` |
| 公司代理 | 客户端所有请求统一走代理（环境变量或配置项），支持 NO_PROXY | `client/lib/config.mjs` |
| 好装、好更新 | 离线安装包 + `ferry install`；`ferry update` 从 GitHub 发布页取最新版；没登录远程服务端时自动在本机启动服务端 | `client/lib/setup.mjs` |
| 不重复造轮子 | Agent 循环、工具和终端界面直接用开源的 [pi](https://github.com/earendil-works/pi)（MIT），通过它公开的 `main()` 和扩展接口嵌入，不 fork 内核 | `client/bin/ferry.mjs` |

更细的协议和取舍见 [docs/DESIGN.md](docs/DESIGN.md)。


更细的协议和取舍：[docs/DESIGN.md](docs/DESIGN.md)；上下文和记忆的方案：[docs/CONTEXT-AND-MEMORY.md](docs/CONTEXT-AND-MEMORY.md)；客户端 agent 的目标和进度：[docs/AGENT-GOAL.md](docs/AGENT-GOAL.md)；管理页的设计：[docs/ADMIN-DESIGN.md](docs/ADMIN-DESIGN.md)。

### 和 Cursor 的对应关系

| | Cursor | Ferry |
|---|---|---|
| 对话记录 | 存在客户端，每次请求带上 | 存在客户端；服务端额外缓存一份，所以每次只需传新增部分 |
| 工具执行（读写文件、命令） | 客户端 | 客户端 |
| 最终提示词组装 | 服务端（官方文档说明即使用自己的 API Key 也经服务端） | 服务端 |
| 模型调用和 API Key | 服务端 | 服务端 |
| 代码库语义检索 | 服务端索引 | 不做（要把代码上传建索引）；用 grep + 子 agent 搜索 |
| 记忆 | Memories（服务端生成，需批准） | 客户端文件，模型用 `memory` 工具读写，你可以直接改 |
| 子 agent | 有 | `task` 工具，内置 explore / general，可自定义 |
| 权限 | 有 | 四种模式、按项目记住的规则、只读命令白名单、危险命令总是问（参考 Claude Code） |
| 读网页、搜索 | 服务端执行 | 默认在工作电脑上执行（受公司网关管），可选服务端代办 |


## 开发

```bash
git clone https://github.com/wvans123/ferry && cd ferry
npm ci
pip install -e server pytest
pytest server/tests                     # 服务端单元测试
node --test "client/test/*.test.mjs"    # 客户端单元测试（权限、联网、钩子、撤销……）
python selftest/run.py                  # 端到端：假模型 + 服务端 + 客户端 + 假代理 + 假网关，跑完 GOAL.md 里的全部检查，不需要 Key
node client/bin/ferry.mjs               # 直接从源码运行
```

- 每次推送，GitHub Actions 在 Linux 和 Windows 上各跑一遍全部测试。
- main 上 `package.json` 的版本号变了，测试通过后自动打包 Windows 离线安装包并发布，`ferry update` 就能取到。
- **跟着 pi 更新**：每周一自动检查 pi 的新版本（[update-pi.yml](.github/workflows/update-pi.yml)，也可以手动运行）。有新版本就换上，跑全部测试（含终端界面测试），都通过才发布；没通过什么都不改，GitHub 会发邮件通知。Ferry 只用 pi 公开的扩展接口，不 fork、不改 pi 本身。

```
client/      ferry 命令行（Node.js）
  bin/       入口 ferry.mjs
  lib/       同步 sync · 权限 permissions + guard · 系统提示 prompt · 记忆 memory · 子 agent subagent
             任务清单和长输出 tools · 联网 web · 公司网关 gateway · 浏览器 browser · 撤销 checkpoint
             钩子 hooks · 斜杠命令 commands · fd/rg toolbins · 安装和更新 setup
  commands/  内置斜杠命令（Markdown）
  test/      客户端单元测试
server/      ferry-server（Python / FastAPI）：会话缓存、提示词组装、脱敏、流式还原、模型适配、管理页、联网代办
examples/    自己扩展用的例子：命令、技能、子 agent、钩子、权限、MCP
selftest/    端到端自测：假模型、假代理、run.py
deploy/      部署：Mac 开机自启、Linux systemd、Caddy
scripts/     打包 Windows 离线安装包、跟进 pi 版本
docs/        部署指南、扩展指南、设计文档
```

## 离商业级还差什么

v0.12 是一个可以自用、可以演示的原型：46 个单元测试（服务端 31、客户端 15）和 40 项端到端测试覆盖，在 Linux 和 Windows 上自动跑。离商业产品还差这些：

| 方面 | 现状 | 还缺 |
|---|---|---|
| agent | 权限模式、记忆、子 agent、任务清单、斜杠命令、技能、钩子、撤销、联网、浏览器、三层上下文管理 | 命令在沙箱里跑（Codex 的做法）、图片输入、IDE 插件 |
| 服务端 | 增量同步、组装提示词、选模型、可逆脱敏、流式还原、管理页 | Claude 原生接口（提示词缓存）、服务端摘要、用量和费用统计 |
| 可靠性 | 缓存丢失自动恢复、版本协商、自动跟进 pi 更新 | 多实例部署（目前是单机 SQLite）、数据备份 |
| 安全 | 多用户隔离、恒定时间令牌比较、拒绝弱密钥、日志不含正文、管理页只限本机 | 限流、令牌过期、客户端令牌存进系统凭据库 |
| 真实环境 | Linux 和 Windows 上用假模型、假代理、假网关验证；作者的工作电脑经 Cloudflare 连通 | 更多公司网络环境下的验证 |
| 交付 | 离线安装包、一条命令安装和更新、自动发版 | 代码签名、安装向导（.msi） |

## 致谢

[pi](https://github.com/earendil-works/pi)（MIT）· [Playwright MCP](https://github.com/microsoft/playwright-mcp) · [ripgrep](https://github.com/BurntSushi/ripgrep) · [fd](https://github.com/sharkdp/fd) · [FastAPI](https://fastapi.tiangolo.com/) · [HTTPX](https://www.python-httpx.org/) · [undici](https://github.com/nodejs/undici)
