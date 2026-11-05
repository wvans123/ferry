# Ferry

在受限的公司电脑上用的编码 agent。用法和 Claude Code、Cursor CLI 差不多：在 cmd 里输入 `ferry`，用中文说要做什么，它读代码、改文件、跑命令，也能查网页、读写 Office 文件。

A Claude-Code-style coding agent for locked-down Windows PCs. The agent runs on the work computer; a small server you control holds the API keys, builds the prompt and calls the model. Every request leaving the PC stays under 1 MB.

[![test and release](https://github.com/wvans123/ferry/actions/workflows/ci.yml/badge.svg)](https://github.com/wvans123/ferry/actions/workflows/ci.yml)

```
C:\my-project> ferry

  Ferry v0.30.0  server ferry.example.com
  Files and history stay on this machine. The server builds the prompt and calls the model.
  memory: 3 (/memory)  ·  subagents on  ·  /help for commands (/goal /tasks /cost /rewind)

> 登录接口在密码错误时返回 500，帮我查一下原因并修好
  ● search "password" in src ... read AuthController.java ... edit AuthService.java
    Allow edit?  → Allow once / Allow all file changes / Deny
  原因是 ……，已改 AuthService.java 第 42 行，并补了一个测试，mvn test 通过。
                                                           ask before edits and commands (shift+tab)
```

适合这样的环境：

- 公司电脑对外的单个请求不能太大。Ferry 每个请求都不超过 1 MB。
- 公司电脑上不想放模型的 API Key。
- 想自己决定用哪个模型：Claude、GPT、DeepSeek、Kimi、通义、智谱，或者任何 OpenAI 兼容接口。

## 它是怎么工作的

```
工作电脑                                       Ferry 服务端（你自己的电脑或服务器）             模型
┌──────────────────────────────┐   只传新增部分   ┌──────────────────────────────┐            ┌──────────┐
│ ferry（agent）                │ ── 每次 ≤ 1MB ──> │ 拼回完整对话、加团队提示词、   │ ─────────> │ Claude   │
│ 读写文件、执行命令、记忆、权限 │ <── 逐字返回 ──── │ 选模型、存 Key                │ <───────── │ DeepSeek │
└──────────────────────────────┘                  └──────────────────────────────┘            └──────────┘
```

- agent 在工作电脑上干活。引擎是开源的 [pi](https://github.com/earendil-works/pi)，Ferry 在上面加了权限、记忆、子 agent、联网、Office、斜杠命令等扩展。代码、对话记录、记忆都留在工作电脑上。
- 服务端只负责问模型：把工作电脑传来的新增内容拼回完整对话，加上团队提示词，选模型，然后调用。API Key 只在服务端。
- 长对话的上下文很快超过 1 MB，所以每轮只上传新增的消息，太大的拆成 512 KB 的小块，服务端再拼起来。服务端丢了缓存也没关系，工作电脑会整段重传。

## 安装

需要 Node.js 22+。所有命令在 cmd 里执行。

| 你的情况 | 怎么装 |
|---|---|
| 一台电脑，能直接访问模型 API | [单机](#单机5-分钟)：服务端由 ferry 自动在本机启动 |
| 公司电脑受限，另有一台自己的电脑或服务器 | 先在那台电脑上装服务端（[SERVER.md](docs/SERVER.md)），再[在工作电脑上装客户端](#工作电脑连到远程服务端) |

### 单机（5 分钟）

另外需要 Python 3.11–3.14。

1. 下载 [Releases](https://github.com/wvans123/ferry/releases/latest) 里的 `ferry-windows-x.y.z.zip`，右键"全部解压"。安装包是离线的，不需要 npm、PyPI，也不需要 venv。
2. 安装：
   ```bat
   cd /d %USERPROFILE%\Downloads\ferry-x.y.z
   node client\bin\ferry.mjs install
   ```
3. 设置 API Key，然后重新打开 cmd：
   ```bat
   setx DEEPSEEK_API_KEY sk-你的key
   ```
4. 检查，然后开始用：
   ```bat
   ferry doctor
   cd /d C:\你的项目
   ferry
   ```

每次运行 `ferry`，它在本机后台启动一个服务端，退出时一起关掉。截图式的详细步骤见 [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md)。

### 工作电脑连到远程服务端

工作电脑上只装客户端，不需要 Python。

```bat
cd /d 解压出的 ferry-x.y.z 文件夹
node client\bin\ferry.mjs install --client-only
```

不用安装包也可以 `git clone` 后 `npm ci`，再运行同一条 install 命令（需要能访问 npm；公司网络要走代理的话，先 `npm config set https-proxy http://代理:端口`）。

然后在服务端管理页的"概览"里复制登录命令，贴到工作电脑的新 cmd 窗口里运行，再检查一遍：

```bat
ferry login https://ferry.example.com 你的令牌
ferry doctor
```

`ferry doctor` 全是 OK 就能用了。以后更新都用 `ferry update`。

如果服务端地址被公司网关拦下、要你先确认（"访问提醒"页），ferry 会自动在浏览器里打开那一页，你点"继续"后它自己接着跑。

## 用起来

在项目文件夹里输入 `ferry`，直接说要做什么。最常用的几样：

| 想做的事 | 怎么做 |
|---|---|
| 少点确认 / 只看不改 | Shift+Tab 切换权限模式：默认、自动改文件、只读规划、全部放行 |
| 中途改主意 | agent 干活时按 Enter 排队一句话；空行再按 Enter 立即打断并插话；Esc 停下 |
| 大活一直做到完 | `/goal 把 docs 里的术语统一成术语表的写法` |
| 退回去重来 | `/rewind`：对话、agent 改过的文件，或两样一起退 |
| 让它记住 | 说"记住……"，或 `/memory 内容` |
| 接着昨天的对话 | `ferry -c`，或 `ferry -r` 挑一个 |
| 看花了多少 | `/cost`；底栏一直显示 |
| 不知道有什么 | 输入 `?` 或 `/help` |

agent 自己会用的能力：

- 读、搜、改代码，跑命令；长输出存成文件，只给模型看头尾。
- 多步的活先列待办清单，做一步勾一步；大的搜索交给子 agent，几十个文件可以批量派给多个子 agent。
- 后台跑开发服务器、长时间的测试。
- 上网查资料，和 Claude Code 一样：搜索由服务端去做（模型自带的搜索或搜索 API，见[网页搜索](docs/SERVER.md#网页搜索)），网页在工作电脑上读、走公司代理和证书，带着问题读时只把回答放进对话；大问题交给调研子 agent 并行查。用 curl 下载文件，断了能续。
- 用电脑上的 Edge 打开靠 JavaScript 生成内容的网页，点击、填表、登录后操作。
- 读写 Word（含修订和批注）、Excel、PowerPoint、PDF，不需要装 Office。
- 看图片，画图片。
- 拿不准时弹出选项问你。
- 跨对话的记忆：这个项目的、你个人的，以及所有电脑共用的。
- 能接 MCP 服务器，也能组成 [agent 团队](docs/TEAM.md)。

全部按键、命令、设置和排错见 [使用手册](docs/USAGE.md)。

## 出问题了

先运行 `ferry doctor`。它逐项检查网络、令牌、模型和搜索工具，并告诉你下一步做什么。常见的报错和办法见 [使用手册 · 出问题了怎么办](docs/USAGE.md#出问题了怎么办)。

是 Ferry 自己的毛病，就在出问题的对话里输入 `/report 哪里不对`：agent 写一份不含你工作内容的报告，你看过同意后，由你的服务端发到 GitHub issue（[报告问题](docs/USAGE.md#报告问题)）。

## 安全须知

- 服务端能看到对话原文（`session_store = "none"` 时处理完就丢），所以服务端必须是你信得过的机器，并且只用 HTTPS 访问。
- Ferry 不替换对话里的敏感内容，交给 agent 的东西都会发给模型。公司明确不许外发的内容，就不要交给 agent。
- 联网在工作电脑上执行，受公司网关管，Ferry 不会替你点掉网关的确认页。
- 令牌存在工作电脑的 `%USERPROFILE%\.ferry\config.json`。泄露了就在管理页换一个；用"添加设备"发的令牌，作废那一台即可。
- 全局记忆存在服务端，agent 被要求只放你的偏好，不放工作内容。管理页里能看到每一条，随时可删。
- 第一次试用，先拿一个测试文件夹和编出来的内容。

## 文档

| 文档 | 写给谁、讲什么 |
|---|---|
| [使用手册](docs/USAGE.md) | 用 ferry 的人：按键、命令、权限、各项能力、设置、排错 |
| [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md) | 第一次在 Windows 上装，一步一步来 |
| [SERVER.md](docs/SERVER.md) | 管服务端的人：放在哪、接哪家模型、管理页、缓存和费用、限流 |
| [DEPLOY-WINDOWS](docs/DEPLOY-WINDOWS.md) · [MAC](docs/DEPLOY-MAC.md) · [LINUX](docs/DEPLOY-LINUX.md) | 在这三种机器上部署服务端 |
| [CUSTOMIZE.md](docs/CUSTOMIZE.md) | 自己写命令、技能、子 agent、钩子、权限规则、MCP |
| [TEAM.md](docs/TEAM.md) | 用 Paperclip 组 agent 团队 |
| [DESIGN.md](docs/DESIGN.md) | 增量同步协议、提示词组装、代码地图 |
| [MODULES.md](docs/MODULES.md) | 模块怎么写、现在有哪些模块（加功能、删功能都从这里开始） |
| [CONTEXT-AND-MEMORY.md](docs/CONTEXT-AND-MEMORY.md) | 上下文和记忆的方案，以及和 Cursor、Claude Code、Codex 的对比 |
| [ROADMAP.md](docs/ROADMAP.md) | 接下来做什么、离商业产品还差什么 |
| [GOAL.md](GOAL.md) | 验收标准：端到端自测的每一项和最近一次结果 |
| [evals/](evals/README.md) | 用真模型跑一组日常任务，发版前比较做对了几个、花了多少 |

## 开发

```bash
git clone https://github.com/wvans123/ferry && cd ferry
npm ci
pip install -e server pytest
pytest server/tests                     # 服务端单元测试
node --test "client/test/*.test.mjs"    # 客户端单元测试
python selftest/run.py                  # 端到端：假模型 + 服务端 + 客户端 + 假代理 + 假网关，不需要 Key
python selftest/run.py --only F66,F67   # 只跑这几项检查所在的那几步；--list 看每步有哪些检查
python evals/run.py                     # 真模型跑日常任务（要 DEEPSEEK_API_KEY），见 evals/README.md
node client/bin/ferry.mjs               # 直接从源码运行
```

- 每个 PR，GitHub Actions 在 Linux 和 Windows 上各跑一遍全部测试（只改文档时不跑）。合进 main 时，PR 上已经测过的不再重测，直接打包发布。
- main 上 `package.json` 的版本号一变，测试通过后自动打包 Windows 离线安装包并发布，`ferry update` 就能取到。
- 每周一自动检查 pi 的新版本（[update-pi.yml](.github/workflows/update-pi.yml)），换上后全部测试通过才发布。Ferry 只用 pi 公开的扩展接口，不 fork。

```
client/      ferry 命令行（Node.js）
  bin/       入口 ferry.mjs
  lib/       每个功能一个模块：同步 sync、权限 permissions + guard、系统提示 prompt、记忆 memory、
             子 agent subagent、联网 web、公司网关 gateway、Office office、/goal goal ……
  skills/    内置技能
  test/      客户端单元测试
server/      ferry-server（Python / FastAPI）：会话缓存、提示词组装、模型适配、管理页
selftest/    端到端自测
evals/       真实任务评测
examples/    自己扩展用的例子：命令、技能、子 agent、钩子、权限、MCP
deploy/      部署：Mac 开机自启、Linux systemd、Caddy
scripts/     打包 Windows 离线安装包、跟进 pi 版本
docs/        使用手册、部署指南、设计文档
```

每个模块做什么、为什么这么做，见 [DESIGN.md 的代码地图](docs/DESIGN.md#代码地图)。

## 致谢

[pi](https://github.com/earendil-works/pi)（MIT）· [agent-browser](https://github.com/vercel-labs/agent-browser) · [Paperclip](https://github.com/paperclipai/paperclip) · [ripgrep](https://github.com/BurntSushi/ripgrep) · [fd](https://github.com/sharkdp/fd) · [FastAPI](https://fastapi.tiangolo.com/) · [HTTPX](https://www.python-httpx.org/) · [undici](https://github.com/nodejs/undici)
