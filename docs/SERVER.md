# 服务端：放在哪、接哪家模型、怎么管

Ferry 服务端负责"问模型"这一步：拼回完整对话、加团队提示词、选模型、保管 API Key。这份文档给运行服务端的人看。只在一台电脑上自己用的话，按 [README 的单机安装](../README.md#单机5-分钟) 来就行，服务端由 ferry 自动启动，不用读这里。

## 放在哪

| 你的情况 | 服务端放在 | 步骤 |
|---|---|---|
| 公司电脑受限，家里有一台 Windows 电脑 | 家里的 Windows + Cloudflare 域名 | [DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md)：用安装包装服务端，桌面图标打开管理页，填 API Key，Cloudflare Tunnel 给它一个域名 |
| 同上，手边是 Mac | Mac + Cloudflare 域名 | [DEPLOY-MAC.md](DEPLOY-MAC.md)：`pipx install`，开机自启脚本，Cloudflare Tunnel |
| 要一直在线，或要用 Claude / OpenAI | Linux 云服务器 + HTTPS | [DEPLOY-LINUX.md](DEPLOY-LINUX.md)：`pipx install`，systemd，Caddy 自动 HTTPS |

Anthropic 和 OpenAI 的 API 不对中国大陆和香港提供服务。要用这两家，服务端得放在它们支持的地区，比如海外的云服务器。

装好后，在服务端管理页"概览"里复制登录命令，贴到工作电脑的新 cmd 窗口里运行，再 `ferry doctor` 检查一遍。

## 管理页

只能在服务端那台电脑上打开：Windows 上双击桌面的 Ferry Server，或者运行 `ferry-server --ui`。

![服务商和模型](images/admin-providers.png)

| 页面 | 能做什么 |
|---|---|
| 概览 | 工作电脑用的登录命令（带令牌，一键复制）、流量图、最近的调用 |
| 服务商和模型 | 选预设（DeepSeek、Kimi、智谱、通义、火山、硅基流动、各家编程套餐、Claude、OpenAI、OpenRouter、本机 Ollama、自定义），只填 API Key；读出服务商的模型列表，勾选要用的；选默认模型、写摘要用的模型、生成图片用的模型；每个模型的上下文、最大输出和价格；测试按钮 |
| 提示词 | 所有工作电脑都会带上的团队提示词，可以按项目写 |
| 调用记录 | 每次调用的项目、模型、大小、token、耗时，可以点开看详情 |
| 用量和费用 | 按天、项目、模型汇总，能看到每个模型的缓存命中 |
| 设备和记忆 | 给每台电脑一个令牌；全局记忆（所有电脑共用） |
| 设置 | 外网地址、服务端存不存对话、请求上限、并发、手机通知（Bark）、问题报告（GitHub）、开机启动、换令牌 |

API Key 存在服务端的 `secrets.toml` 里，任何接口都只显示最后 4 位。

**好几台电脑要登录**：在"设备和记忆"里给每台电脑添加一个设备，各拿自己的令牌和登录命令（令牌只显示一次）。某台丢了或不用了，点"作废"，只有它连不上。

## 用哪家模型

在管理页里选，工作电脑不用管。工作电脑上只看到一个 `auto`，由服务端把干活的请求发给默认模型、把写摘要的请求发给摘要模型。管理页里允许的话，工作电脑也能用 `/model` 自己挑。

- **Claude**（Opus 5.5 / Sonnet 5.5 / Haiku 5.5）走 Anthropic 自己的接口，带提示词缓存。Opus 5.5 缓存命中的价格是正常输入的 1/20。
- **GPT**（gpt-6.1-sol 等）走 OpenAI 接口（也支持 Responses 接口），OpenAI 会自动缓存。
- 也可以用 DeepSeek、Kimi、通义、智谱，或者任何 OpenAI 兼容接口。

### 为什么每次调用都有几十上百 k token

模型不记得上一轮。agent 每走一步（读个文件、跑条命令）都要把整段对话重新发一遍，Claude Code、Cursor、Codex 都一样。省钱靠这几件事：

- 提示词缓存：重复的那部分按缓存价算（Claude 是原价的 1/20，GPT、DeepSeek 约 1/10）。缓存命中一直是 0 的模型最贵，"用量和费用"里能看到。
- Claude 走中转：Claude 只缓存请求里标记过的部分。服务端会自动给 OpenAI 兼容中转后面的 Claude 加上标记，中转不认就自动去掉。中转如果也支持 `/v1/messages`，在管理页把它的"接口格式"改成 Anthropic 更好，点"测试"会告诉你支不支持。
- 上下文设小一些（工作电脑上 `/context 200k`），会更早写摘要，每次发的也就少。

### 同一个模型有几家服务商

比如 Claude 既走官方又走中转。名字一样的模型自动合成一组，工作电脑上只看到一个，管理页上标着"⇄ 2 家"。

- 每个会话固定用一家，这样提示词缓存有效。
- 同时有几个会话时，新会话分给当前最闲的那家。
- 一家出错（限流、超载、Key 失效、连不上）就自动换另一家，那家先歇一会儿。

### 限流

每个服务商可以设每分钟调用次数和并发上限。遇到 429，按 Retry-After（或设置里的时间）冷却。可以给它设一个回退模型，接口格式不同也行（比如 Claude 限流时改用 GPT），工作电脑会按回退模型的格式重发这一轮；没设回退时，请求在服务端排队等，工作电脑的状态栏会显示。

### 上下文长度

每个模型能装多少，在管理页"服务商和模型"→ 编辑里改（"上下文"和"最大输出"两栏）。预设值：Claude 1M；GPT 400k（gpt-6.1-sol 最多能收约 92 万输入 token，但一次请求超过 27.2 万时输入价翻倍）；deepseek-flash 1M。这是上限，工作电脑上用 `/context` 在上限以内挑一个常用的。

请求比模型的上下文还大时，服务端回 `context_length_exceeded`，工作电脑会先写摘要再重试。摘要由服务端写：模型拒绝时带说明再问一次，再不行换摘要模型或默认模型；太大就分段写。

## 服务端设置

大多在管理页里改，存在服务端数据目录的 `server.toml`，立即生效。也可以用环境变量（优先于管理页）：

| 环境变量 | 作用 |
|---|---|
| `FERRY_SERVER_HOME` | 数据放哪，比如 `D:\ferry\server`（令牌、Key、models.toml、日志） |
| `DEEPSEEK_API_KEY` 等 | 用环境变量给 Key，优先于管理页里填的 |
| `FERRY_SESSION_STORE` | 服务端存不存对话：`memory`（默认）/ `disk` / `none` |
| `FERRY_GITHUB_TOKEN` / `FERRY_GITHUB_REPO` | 问题报告用的 GitHub 令牌和仓库（优先于管理页） |

多用户的服务器改用完整配置文件 `ferry-server.toml`，参考 [server/ferry-server.example.toml](../server/ferry-server.example.toml)。模型和服务商写在数据目录的 `models.toml` 里，改了不用重启；只认文字的模型加一行 `vision = false`。

## 问题报告

工作电脑上的 `/report`（见[使用手册](USAGE.md#报告问题)）把问题报告发到服务端，由服务端在 GitHub 上开 issue。工作电脑只和服务端说话，所以公司电脑上不了 GitHub 也能报。

设置一次就行：

1. 在 GitHub 上建一个 fine-grained personal access token：Settings → Developer settings → Fine-grained tokens，Repository access 只选 `wvans123/ferry`，Permissions 里只给 Issues 读写。
2. 管理页 → 设置 → 问题报告，填仓库（默认 `wvans123/ferry`）和这个令牌，保存。令牌存在数据目录的 `github-token` 文件里，管理页不再显示它。

发出前，服务端会隐去这些内容：问题报告卡片里列的词（公司名、产品名、项目代号、主机名，一行一个）、内网 IP、邮箱、手机号、Key、路径里的用户名（`C:\Users\<user>\...`）。每份报告都存在数据目录的 `data/reports/` 里，管理页列出最近 30 份：发成功的带 issue 链接，没发出的写着原因，可以再发一次。

公开仓库的 issue 谁都能看。不想公开，就建一个私有仓库专门收报告，把仓库名填成它。

