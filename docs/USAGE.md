# 使用手册

在项目文件夹里输入 `ferry`，然后用中文说要做什么。这份手册按"先会用、再细调"的顺序写：键盘和命令、长任务、权限、agent 的各项能力、团队、扩展、设置、排错。

- [键盘](#键盘)
- [命令行](#命令行)
- [斜杠命令](#斜杠命令)
- [/goal：一直做到完成](#goal一直做到完成)
- [后台任务和子 agent](#后台任务和子-agent)
- [权限](#权限)
- [agent 能做的事](#agent-能做的事)
- [Agent 团队](#agent-团队)
- [自己扩展](#自己扩展)
- [客户端设置](#客户端设置)
- [出问题了怎么办](#出问题了怎么办)
- [报告问题](#报告问题)

## 键盘

| 按键 | 作用 |
|---|---|
| Enter | 发送；Shift+Enter 或 Ctrl+J 换行 |
| Shift+Tab | 切换权限模式（见[权限](#权限)） |
| Esc | 打断 agent 正在做的事 |
| agent 干活时按 Enter | 你的话排队，等这一步做完插进去（输入框上方显示 `Steering: …`） |
| 空行再按一次 Enter | 立即插话：正在写的回答停下，还没开始的工具调用不再执行，正在跑的命令让它跑完，然后把你的话连同"你被打断了，先重新规划"的说明交给 agent |
| Alt+Enter / Alt+↑ | 等 agent 全部做完再发 / 把排队的话拿回输入框改。插话还在等命令跑完时，按 Esc 也会把话放回输入框 |
| Ctrl+C | 清空输入框；两秒内再按一次退出（Ctrl+D 也能退出） |
| `?` | 只输入一个问号回车，显示命令和快捷键 |
| Ctrl+O / Ctrl+T | 展开或收起工具输出 / 模型的思考过程 |
| Ctrl+L | 选模型 |
| `/` | 列出斜杠命令 |
| `@` | 引用文件，输入文件名会自动补全 |
| `!命令` | 自己执行一条命令，输出也给 agent 看，比如 `!git status` |

`/help` 里也有这张表。

终端标签页的标题是 `对话内容 · 项目 · Ferry`（用 `/name` 起过名就用名字，否则用你第一句话的开头）。agent 干活时前面是 ⏳，等你确认时是 ❓，开了好几个标签页也能看出哪个在等你。

## 命令行

| 命令 | 作用 |
|---|---|
| `ferry` | 在当前文件夹开始对话 |
| `ferry -c` / `ferry -r` | 接着上次的对话 / 从以前的对话里挑一个 |
| `ferry --session <id>` | 接着指定的对话（退出时会打印这一行） |
| `ferry -p "问题"` | 只问一句，打印回答后退出，适合放进脚本 |
| `ferry doctor` | 逐项检查网络、令牌、模型、搜索工具；`--upload` 测多大的上传能通过 |
| `ferry check` | 看公司网关要不要确认，要就打开确认页并等到通过。在 ferry 里输入 `!ferry check` 也行 |
| `ferry config` | 查看和修改客户端设置 |
| `ferry mcp list` / `import` | 查看用到的 MCP 服务器 / 从 Claude Desktop、Claude Code、Cursor、VS Code、Windsurf 导入 |
| `ferry login <地址> <令牌>` / `ferry logout` | 连到远程服务端 / 改回本机服务端。服务端前面有 Cloudflare Access 时加 `--header "名字: 值"` |
| `ferry update` | 更新到最新版，见下 |
| `ferry pkg install npm:<包名>` | 安装 pi 生态的扩展包（扩展、技能、命令）；`ferry pkg list` / `remove` |
| `ferry team ...` | Agent 团队，见 [Agent 团队](#agent-团队) |
| `ferry --version --all` | 显示 Ferry 和 pi 的版本 |

`ferry update` 装在哪就更新在哪：

- 用安装包装的，从 GitHub 下载新的安装包。打不开 GitHub 时，在别的电脑下载 `ferry-windows-*.zip` 拷过来，运行 `ferry update 文件.zip`。
- 用 git clone 装的，自动执行 `git pull`、`npm ci` 和重新安装。想改用安装包：`ferry update --release`。
- 本机也跑着服务端时一起升级，升级后要重启服务端。
- 有新版本时，ferry 启动时会提醒你。

## 斜杠命令

输入 `/` 只列出常用的，`/help` 列出全部和快捷键。

| 分类 | 命令 |
|---|---|
| 对话 | `/new` 新对话 · `/resume` 回到以前的对话 · `/name <名字>` 给对话起名 · `/session` 这次对话的信息 · `/compact [保留什么]` 现在就压缩上下文 · `/rewind` 回到之前某条消息 |
| 干活 | `/goal <目标>` 一直做到完成 · `/tasks` 待办、子 agent 和后台命令 |
| 知识 | `/memory` 看记住了什么 · `/memory <内容>` 记一条 · `/skills` 它会哪些技能 |
| 信息 | `/context [大小]` 上下文用了多少，带大小就改（如 `/context 400k`）· `/cost` 花了多少 token 和钱 · `/status` 连接、模型、用了哪些规则文件，并做一次快速检查 |
| 设置 | `/config` 常用设置 · `/model` 选模型 · `/mcp` MCP 服务器 · `/quit` 退出 |
| 问题 | `/report [哪里不对]` 让 agent 写一份问题报告，你看过同意后经服务端发到 GitHub（见[报告问题](#报告问题)） |

几个要多说一句的：

- `/rewind` 选你之前发的一条消息，回到它发出之前。可以只退对话、只退文件，或者两样一起退，那条消息会放回输入框，改一改再发。退回去的那段对话仍留在记录里。文件只管 agent 用 edit/write 改过的，命令造成的改动请用 git 恢复。
- `/memory` 默认存在这个项目；`/memory user 内容` 存到所有项目，`/memory global 内容` 存到服务端（见[记忆](#记忆)）。平时直接说"记住……"也行。
- 底栏的 `23%/500k (auto)` 意思是上下文用了 23%，上限 500k，快满时自动写摘要。右边的 `auto` 是模型名，表示由服务端选模型。
- `/context 400k` 改当前模型的上下文长度，马上生效并记住；`/context auto` 回到服务端的设置。不能超过模型本身支持的长度。上下文越大，压缩前能留的历史越多，每次请求也越贵。

pi 自带的其他命令（`/tree`、`/fork`、`/export`、`/share`、`/login`……）不再列出，敲出来仍然能用。写代码用的 `/init`、`/review`、`/commit`、`/test` 等放在 [examples/commands/](../examples/commands/)，需要就拷进 `%USERPROFILE%\.ferry\commands\`。

## /goal：一直做到完成

```
> /goal 把 docs 文件夹里所有文档的术语统一成《术语表.md》里的写法，改完列出改了哪些文件
```

- 设好目标后 agent 自己连续干。它每停一次，Ferry 就让它对照目标检查做完了什么，接着做下一步。
- 完成要给证据（文件内容、命令输出、测试结果）。它用 `goal_update` 报告"完成"或"卡住了，需要你"，才会停下。
- 底栏一直显示进度，比如 `◎ goal pursuing · 12m · 340k/2M tokens · 7 turns`。
- `/goal` 看状态，`/goal pause` / `resume` / `clear` 暂停、继续、清除。
- `/goal budget 2m` 设 token 预算，用完会写一份进度报告再停。另外默认最多 100 轮（`goalMaxTurns`）。
- 目标很长的话，先写进一个文件，再 `/goal 目标.md`。
- 按 Esc 会暂停目标；进行中也可以随时插话纠正方向。

做法参考了 Codex 的 goal mode 和 Claude Code 的 `/goal`。

## 后台任务和子 agent

- **后台命令**：开发服务器、监听、长时间的构建或测试，agent 用 `job_start` 放到后台，接着干别的，用 `job_output` 看进度。
- **子 agent**：agent 自己判断要不要把一件事交给子 agent（`task`）。子 agent 用全新的上下文干完，只把报告带回来，主对话不会被撑大。对话里会出现一个小框显示它在做什么。
- **后台子 agent**：`task` 加上 `background`，做完自动把报告交回来。
- **批量派活**：比如"把这个文件夹里 40 篇稿件每篇看一遍"，`task_batch` 每篇派一个子 agent，同时最多 3 个（`maxParallel`），报告汇总到一个文件。服务端也限制每个用户同时的模型请求数，多的排队。
- **待办清单**：多步的活，agent 先列待办（输入框上方的 `To-do (1/3 done)`），做一步勾一步。清单没做完就想停，会被要求接着做完（最多三次，而且清单要有进展）。

`/tasks` 一次看全：待办、子 agent（在跑的和跑完的）、后台命令，可以看输出、停止。任务结束时会通知你，agent 在你下一条消息时也会知道。退出 ferry 时后台任务一起停掉。

## 权限

Shift+Tab 在四种模式之间切换，底栏显示当前模式：

| 模式 | 改文件 | 执行命令 |
|---|---|---|
| 默认 | 问 | 只读命令（`git status`、`dir`、`rg`……）不问，其他问 |
| 自动改文件 | 项目文件夹里的不问 | 同上 |
| 只读规划 | 不允许 | 只允许只读命令 |
| 全部放行 | 不问 | 不问 |

- 确认框里可以选"以后都允许这类命令"，比如以 `npm test` 开头的命令。规则按项目记住。
- 危险操作（删整个目录、`git push --force`、`git reset --hard`、`curl … | sh`……）除了"全部放行"以外都会问，并说明危险在哪。
- 改项目文件夹以外的文件，总要先确认。
- `.env`、`.ssh` 这类路径永远不碰（`blockedPaths` 可改）。
- 启动时用哪种模式：`ferry config set permissionMode acceptEdits`。

## agent 能做的事

### 记忆

跨对话记住你的偏好、纠正和项目里的决定。说"记住……"或"忘掉……"就行。

| 层 | 存在哪 | 放什么 |
|---|---|---|
| 项目 | 工作电脑 `%USERPROFILE%\.ferry\memory` | 这个项目的决定和约定 |
| 个人（user） | 同上 | 这台电脑上所有项目都用得上的偏好 |
| 全局（global） | 服务端，管理页"设备和记忆"里打开 | 你所有电脑共用的偏好、习惯、术语。工作内容不放这里 |

都是能直接改的 Markdown 文件。系统提示里只放目录，正文按需读。

### 联网和下载

- `web_search`（Bing）和 `web_fetch`（读网页）在工作电脑上执行，走公司代理，受公司网关管，每个网站第一次会问你。
- 下载文件（比如 3GPP 的规范和文稿）和在 Cursor 里一样直接交代：agent 用 `web_fetch` 读 https://www.3gpp.org/ftp/ 下的目录页找到文件，用 `curl -L -o` 下载、解压，再用 `office_read` 读。命令也走公司代理，并且和 ferry 用同一份证书（`%USERPROFILE%\.ferry\ca-bundle.pem`，公司检查 HTTPS 用的证书也在里面）。下完它会确认拿到的不是网关的确认页。
- 不许打开的网站：`ferry config set blockedSites mail.corp.com,chat.corp.com,pan.corp.com`。这些网站和它们的子域名 `web_fetch` 都不打开，跳转过去的也拦下。
- 浏览器：`ferry config set browser true` 之后，agent 能操作电脑上的 Edge，打开网页、点击、填表、读页面。

### Office 文件

读 Word（含修订痕迹和批注）、Excel、PowerPoint、PDF；按修订方式改 Word，像 change request 那样显示删了什么、加了什么；改 Excel 单元格；从 Markdown 新建 Word、从表格新建 Excel。直接处理文件，不需要装 Office，也不会去操作屏幕上的窗口。

### 图片

告诉它图片的路径，它用 read 工具读出来交给模型。几 MB 的图片也没问题：发出前缩小到长边 1568 像素、约 300 KB 以内，超过上传上限还会分块发。对话里只保留最近 4 张（`keepImages`）。默认每个模型都能看图，只认文字的模型在服务端给它加 `vision = false`。

`image_create` 可以画图：服务端交给"生成图片用"的模型，PNG 存进项目文件夹。

### 上下文和找回

- 命令输出太长时，全文存到文件，只给模型看开头和结尾，需要时它自己去读。
- 上下文超过 80k（`trimOldOutputs`）后，很久以前的长工具输出换成一行说明，最近 6 个保留。
- 用到 90%（`compactAt`）时自动写摘要压缩，最近 20k（`compactKeep`）原样保留。之后需要原文，agent 用 `history_search` 在本地完整记录里找回。
- 说"看看我昨天那个对话里定了什么"，它会用 `past_conversations` 列出、搜索、读取这台电脑上以前的对话（默认这个文件夹的，也可以搜全部）。

### 其他

| 能力 | 说明 |
|---|---|
| 提问 | `ask_user`：agent 拿不准时弹出选项让你选，推荐项排在最前，最后一项"其他"可以自己写，按 Esc 不回答。没有终端时（`-p`、团队成员）按推荐项继续并说明 |
| 思考 | Claude 和 GPT 默认中等思考，难的活可以调高：`/config` → `thinking` |
| 花费 | 底栏显示这次对话花了多少钱，`/cost` 看明细，服务端管理页"用量和费用"按天、项目、模型汇总 |
| 提醒 | 一个请求超过 30 秒才做完，响一声并弹出 Windows 通知 |
| 手机通知 | 用 Bark 推到手机（管理页 → 设置 → 手机通知，贴上 Bark 地址）。这几种情况会推：做了 5 分钟以上的活做完了，或者因为出错停下（带一句原因）；目标完成或卡住；确认框等你超过 5 分钟。只发一句话，不带对话内容。你自己按 Esc 停下的不推 |

## Agent 团队

想要"负责人派活，调研、分析、写 PPT 各管一摊，互相留言"，用 [Paperclip](https://github.com/paperclipai/paperclip) 当看板（组织架构、任务、评论、仪表盘，在工作电脑本机打开）。每个成员都跑 Ferry，模型调用照样走你的 Ferry 服务端。

```powershell
ferry team start                            # 窗口 1：启动看板（第一次会自动装好，需要 Node 24.11+）
ferry team init                             # 窗口 2，在项目文件夹里：建一个负责人 + 调研 + 分析 + 撰写的团队
ferry team goal "调研三种方案并写汇报 PPT"     # 给负责人一个目标，然后在 http://127.0.0.1:3100 看进度
```

成员有 `team` 工具：派子任务，等它完成后被自动叫醒，留言，改状态。项目记忆全队共享，每个成员另有自己的角色记忆。详见 [TEAM.md](TEAM.md)。

## 自己扩展

不用写代码，放几个文本文件就行。仓库的 [examples/](../examples/) 里每样都有现成的例子，详细说明见 [CUSTOMIZE.md](CUSTOMIZE.md)。

| 想做的事 | 放一个文件 |
|---|---|
| 让 agent 了解项目 | 项目根目录的 `AGENTS.md`（也可以让 agent 读完项目自己写） |
| 你自己的通用规则 | `%USERPROFILE%\.ferry\AGENTS.md` |
| 加一个斜杠命令 | `.ferry\commands\standup.md` → `/standup` |
| 教它一类任务的做法 | `.ferry\skills\release-notes\SKILL.md` |
| 加一个专门的子 agent | `.ferry\agents\security-reviewer.md` |
| 改完文件自动格式化、检查 | `.ferry\hooks.json` |
| 哪些命令不用问、哪些禁止 | `.ferry\permissions.json` |
| 接数据库、Jira、内部系统 | MCP：`%USERPROFILE%\.ferry\agent\mcp.json`（你的），或项目里的 `.ferry\mcp.json`、`.mcp.json`；`ferry mcp import` 从别的应用导入 |

- 放在项目的 `.ferry\` 下只管这个项目，可以提交进仓库给团队用；放在 `%USERPROFILE%\.ferry\` 下对你所有项目生效。
- Claude Code 的 `.claude\commands`、`.claude\agents`、`.claude\skills`、`CLAUDE.md` 直接能用。
- 系统提示里只放 Ferry 自己的和项目自己的 `AGENTS.md` / `CLAUDE.md`，上层文件夹里的不放（`rulesFromParents` 可以打开）。

## 客户端设置

在 ferry 里输入 `/config` 挑着改；或者 `ferry config` 查看，`ferry config set <名字> <值>` 修改。

| 名字 | 默认 | 作用 |
|---|---|---|
| `permissionMode` | `default` | 启动时的权限模式：`default` / `acceptEdits` / `plan` / `bypass` |
| `thinking` | `medium` | Claude 和 GPT 想多久再回答：`low` / `medium` / `high` / `xhigh`。越高越适合难题，也越慢越贵 |
| `memory` | `true` | 跨对话的记忆 |
| `web` | `client` | 联网工具在哪执行：`client`（这台电脑）/ `server`（服务端代办，需服务端开启）/ `off` |
| `browser` | `false` | 让 agent 操作本机浏览器（Edge / Chrome） |
| `goalMaxTurns` / `goalBudget` | `100` / `0` | `/goal` 最多轮数和 token 预算（如 `2m`，0 表示不限） |
| `notify` | `true` | 长请求结束时响铃加通知 |
| `phoneNotify` | `true` | 让服务端推手机通知（服务端要先在管理页设好 Bark） |
| `blockedSites` | 空 | 永远不打开的网站（含子域名），比如邮箱、通讯、网盘 |
| `blockedPaths` | `.env,.ssh,id_rsa,secrets,credentials` | 永远不读、不改、不在命令里出现的路径 |
| `proxy` | 空 | 连服务端用的代理，空表示用 `HTTPS_PROXY` 环境变量 |
| `compactAt` | `90%` | 上下文用到多少时自动压缩：`50%`～`90%`，或 `off`（只在快超限时压缩）。越低每次请求越便宜，也越早丢细节 |
| `compactKeep` | `20k` | 压缩时最近多少内容原样保留 |
| `keepImages` | `4` | 对话里保留最近几张图片，更早的换成一句说明 |
| `systemCerts` | `true` | 同时信任这台电脑信任的 HTTPS 证书。公司代理用自己的证书检查 HTTPS 时，靠它让 ferry 和命令都能连上 |
| `caFile` | 空 | 再加一个证书文件（.pem），比如找 IT 要的公司代理证书；电脑自己的证书不够时才需要 |

很少需要改的，用 `ferry config --all` 或 `/config` → More settings 查看：`trimOldOutputs`（默认 80k，0 表示不省略）、`maxParallel`（默认 3）、`phoneAfterSeconds`（默认 300 秒）、`subagents`、`bigOutputBytes`、`notifyAfterSeconds`、`updateCheck`、`browserPath`、`browserHeadless`、`chunkBytes`、`rulesFromParents`。上下文长度用 `/context` 改，存在同一个文件里。

服务端的设置见 [SERVER.md](SERVER.md#服务端设置)。

## 出问题了怎么办

先运行 `ferry doctor`，它逐项检查，并告诉你下一步该做什么。

| 看到 | 原因和办法 |
|---|---|
| `the company network gateway wants a confirmation` | 公司网关要你先确认。运行 `ferry` 或 `ferry check`，它会在浏览器里打开确认页，你点"继续"后自己接着跑。确认过一阵会过期，干活中途碰到也会自动打开确认页、等确认后重发。长期办法是请 IT 把服务端地址加进白名单 |
| `cannot reach the server` | 浏览器能打开但 ferry 连不上，通常是浏览器走了公司代理。执行 `setx HTTPS_PROXY http://代理:端口`，然后重开 cmd |
| `unable to get local issuer certificate` | 公司代理会解开 HTTPS 再加密。`systemCerts` 默认已打开；还不行，把公司根证书导出成 .pem，`ferry config set caFile C:\路径\证书.pem` |
| `The Ferry server did not get this request: ...` | 请求在半路被挡了，服务端的调用记录里看不到。后面那句会说是谁挡的：Cloudflare 的机器人防护（在 Cloudflare 后台关掉 Bot Fight Mode，或给 Ferry 的域名加一条跳过规则）、公司网关（Ferry 会打开确认页，确认后重发），或公司代理。详情记在 `%USERPROFILE%\.ferry\logs\blocked.log`。`ferry doctor --upload` 测多大的上传能通过，小的能过、大的不行，就按它的提示把 `chunkBytes` 调小 |
| `a Cloudflare Access login page answered` | 服务端地址前挡着 Cloudflare 的登录页，见 [DEPLOY-MAC.md](DEPLOY-MAC.md#关于那个-cloudflare-登录页) |
| `token rejected` | 令牌不对或换过了，到管理页复制新的登录命令 |
| `HTTP 502 / 530` | 服务端那台电脑睡眠了，或者服务端、cloudflared 没在运行 |
| `model ... HTTP 401 / 402 / 403` | Key 不对 / 账户没余额 / 服务商不服务你所在的地区 |
| `fd and rg not found` | 用安装包装一次，或者把安装包里 `vendor\win32-x64\` 下的两个 exe 拷到 `%USERPROFILE%\.ferry\agent\bin\` |
| 命令里的 curl、git、pip 连不上外网（curl 打印 `000`） | ferry 已经把代理和证书传给命令。还不行就先 `ferry check`（可能是网关要确认）；读网页让 agent 改用 `web_fetch` |
| 命令输出是乱码 | 记下是哪条命令，提个 issue。PowerShell 和 Python 已经强制 UTF-8 |

## 报告问题

Ferry 哪里没做好，在出问题的那个对话里输入：

```
/report web_fetch 一直超时
```

1. agent 根据这个对话写一份问题报告：你想做什么、Ferry 做了什么、哪里出错、报错原文、它认为的原因。它被要求不写你的工作内容：不放文件内容和代码，不写文件名、项目名、公司名、人名、内部地址，只用"一个 3 MB 的 Word 文件"这类说法。
2. 发出前，报告全文连同自动附上的版本号和工具使用次数（只有次数，比如 `bash 12 (2 failed)`）显示给你，你选 Send 才发。
3. 报告只发到你自己的 Ferry 服务端，工作电脑不需要能上 GitHub。服务端再隐去敏感词表里的词、内网 IP、邮箱、手机号、Key 和路径里的用户名，然后用它自己的 GitHub 令牌开一个 issue。服务端怎么设见 [SERVER.md](SERVER.md#问题报告)。
4. 服务端没设令牌或连不上 GitHub 时，报告留在服务端，管理页里能看到、能再发一次。工作电脑连不上服务端时，报告存在 `%USERPROFILE%\.ferry\reports`，下一次 `/report` 时一起发。

仓库是公开的，issue 谁都能看到。发之前请把报告从头看一遍。

