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
| 空行再按一次 Enter | 立即插话：正在写的回答停下，还没开始的工具调用不再执行，正在跑的命令最多等 3 秒（很快能跑完的就让它跑完，跑不完的直接停掉，已有输出留着），然后把你的话交给 agent，附上你原来的要求和它当时在做什么 |
| Alt+Enter / Alt+↑ | 等 agent 全部做完再发 / 把排队的话拿回输入框改。插话还在等那 3 秒时，按 Esc 也会把话放回输入框 |
| Ctrl+C | 清空输入框；两秒内再按一次退出（Ctrl+D 也能退出） |

插话可以是三种话，agent 会自己分辨：
- 问一句（"这个参数是什么意思？"）：它简单回答，然后接着干；
- 纠正方向（"别改测试，改实现"）：它先说一句现在怎么理解、改做什么，做错的改回来，再接着干；
- 补充忘了说的（"对了，结果要中文"）：它记上，已经做完的部分受影响的也一起改。

不管哪种，原来要求里没被改到的部分照旧。
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
| `ferry browser login [地址]` | 打开 agent 用的浏览器让你登录（Google、Microsoft 这类不让程序控制的浏览器登录的网站），登录好后 agent 在这个窗口里接着做；`ferry browser hide` 关掉窗口 |
| `ferry check` | 看公司网关要不要确认，要就打开确认页并等到通过。在 ferry 里输入 `!ferry check` 也行 |
| `ferry config` | 查看和修改客户端设置 |
| `ferry mcp list` / `import` | 查看用到的 MCP 服务器 / 从 Claude Desktop、Claude Code、Cursor、VS Code、Windsurf 导入 |
| `ferry login <地址> <令牌>` / `ferry logout` | 连到远程服务端 / 改回本机服务端。服务端前面有 Cloudflare Access 时加 `--header "名字: 值"` |
| `ferry update` | 更新到最新版，见下 |
| `ferry pkg install npm:<包名>` | 安装 pi 生态的扩展包（扩展、技能、命令）；`ferry pkg list` / `remove` |
| `ferry team ...` | Agent 团队，见 [Agent 团队](#agent-团队) |
| `ferry --version --all` | 显示 Ferry 和 pi 的版本 |

`ferry update` 装在哪就更新在哪：

- 用安装包装的，从 GitHub 下载新版本。依赖没变时（大多数版本）只下载几百 KB 的小包 `ferry-app-*.zip`，依赖沿用已装的那份；依赖变了才下载完整的 `ferry-windows-*.zip`（几十 MB）。打不开 GitHub 时，在别的电脑下载拷过来，运行 `ferry update 文件.zip`：先试小包，它会说依赖对不对得上，对不上再拷完整包。
- 用 git clone 装的，自动执行 `git pull`、`npm ci` 和重新安装。想改用安装包：`ferry update --release`。
- 这台电脑上装着服务端的话，一起升级：装过服务端的每个 Python 都换成新版（桌面图标用的 Python 不是 PATH 上第一个也能找到），正在运行的旧版服务端会自动换成新版重启。输出里 `server` 开头的几行写着每一步。
- 有新版本时，ferry 启动时会提醒你。

## 斜杠命令

输入 `/` 只列出常用的，`/help` 列出全部和快捷键。

| 分类 | 命令 |
|---|---|
| 对话 | `/new` 新对话 · `/resume` 回到以前的对话 · `/name <名字>` 给对话起名 · `/session` 这次对话的信息 · `/compact [保留什么]` 现在就压缩上下文 · `/rewind` 回到之前某条消息 · `/btw <问题>` 旁问一句，不打断、不进对话 |
| 干活 | `/goal <目标>` 一直做到完成 · `/tasks` 待办、子 agent 和后台命令 |
| 知识 | `/memory` 看记住了什么 · `/memory <内容>` 记一条 · `/skills` 它会哪些技能 |
| 信息 | `/context [大小]` 上下文用了多少，带大小就改（如 `/context 400k`）· `/cost` 花了多少 token 和钱 · `/status` 连接、模型、用了哪些规则文件，并做一次快速检查 |
| 设置 | `/config` 常用设置 · `/model` 选模型 · `/mcp` MCP 服务器 · `/quit` 退出 |
| 问题 | `/report [哪里不对]` 让 agent 写一份问题报告，你看过同意后经服务端发到 GitHub（见[报告问题](#报告问题)） |

几个要多说一句的：

- `/rewind` 选你之前发的一条消息，回到它发出之前。可以只退对话、只退文件，或者两样一起退，那条消息会放回输入框，改一改再发。退回去的那段对话仍留在记录里。文件只管 agent 用 edit/write 改过的，命令造成的改动请用 git 恢复。
- `/memory` 默认存在这个项目；`/memory user 内容` 存到所有项目，`/memory global 内容` 存到服务端（见[记忆](#记忆)）。平时直接说"记住……"也行。
- 底栏的 `23%/500k (auto)` 意思是上下文用了 23%，上限 500k，到 `compactAt` 或 `compactLimit` 时自动写摘要。右边的 `auto` 是模型名，表示由服务端选模型。
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

## 旁问、顾问和回顾

这三样都是服务端用当前对话回答的小问题。回答不进对话，也不会让 agent 停下。

- **`/btw <问题>`**：agent 正在干活时想问一句，比如“刚才那个文件是哪个版本”。直接输入 `/btw 问题`，agent 不会被打断，答案作为一条提示出现在屏幕上。回答用你现在的模型，只凭对话里已有的内容，不能读文件、不能搜索。需要查东西的，它会告诉你去问 agent。问题和答案都不会写进对话，agent 看不到。
- **顾问（`advisor`）**：服务端有一个更强的模型时，agent 多一个 `advisor` 工具。多于几步的活，它会在定方案前问一次，在说做完之前再问一次：更强的模型看一遍到目前为止的对话，指出哪里不对、少了什么、下一步做什么。agent 会认真对待，但它自己查到的事实和建议冲突时，会把冲突说出来。用哪个模型在管理页“服务商和模型”里的“顾问模型”选；不选就用最贵的那个，最贵的正好是默认模型时不开。每问一次多花一次调用的钱。`/goal` 也一样：说目标达成之前先问一次顾问。关掉用 `ferry config set advisor false`。
- **回顾**：做了 `phoneAfterSeconds`（默认 5 分钟）以上的请求做完时，服务端用最便宜的模型写一两句话：在做什么、下一步是什么。它放在手机通知里，终端状态栏也显示一行，你下次发消息时消失。15 秒内没写出来就用原来的“做完了”。关掉用 `ferry config set recap false`。

## 交付前检查

做 Word、PPT、PDF 这类给人看的东西，agent 的系统提示里有几条要求：先把资料收集齐（调研、数据、原文件）再开始做文档；长文档先出提纲，再一节一节写；最后一项待办是检查：把做出来的文件读回来（`office_read`）、核对事实和数字、对照你的要求逐条看。重要的交付物，agent 会交给内置的 `review` 子 agent 检查：它没参与制作，只读，对照你最初的要求，列出具体问题和位置，不改文件。想让它检查，也可以直接说“用 review 检查一下这份文件”。

现在没有把幻灯片渲染成图片的功能，PPT 只能读回文字检查，版式要自己看。

## 后台任务和子 agent

- **后台命令**：开发服务器、监听、长时间的构建或测试，agent 用 `job_start` 放到后台，接着干别的，用 `job_output` 看进度。
- **子 agent**：agent 自己判断要不要把一件事交给子 agent（`task`）。子 agent 用全新的上下文干完，只把报告带回来，主对话不会被撑大。对话里会出现一个小框显示它在做什么。
- **后台子 agent**：`task` 加上 `background`，做完自动把报告交回来。
- **接着问子 agent**：子 agent 交了报告以后，agent 还能用 `task` 的 `resume` 再问它（报告末尾写着它的编号）。它带着原来的上下文接着干，读过的文件和网页不用再读一遍。比如调研子 agent 查完了，agent 让它"再看看 X"。追问也可以放到后台。只保留这个 ferry 窗口里最近做完的 5 个子 agent；被停掉的、退出 ferry 或开新对话以后的，都要重新派。还在跑的子 agent 不能追问，等它交报告。
- **批量派活**：比如"把这个文件夹里 40 篇稿件每篇看一遍"，`task_batch` 每篇派一个子 agent，同时最多 3 个（`maxParallel`），报告汇总到一个文件。服务端也限制每个用户同时的模型请求数，多的排队。
- **调研子 agent**（`research`）：要上网查的问题，agent 交给它。它换几种说法搜，打开来源读，顺着链接找到原始出处，核对日期，最后把结论和每条的出处带回来。读过的网页留在它自己的上下文里，主对话只拿到报告。问题能拆成几块时，几个调研子 agent 同时查。
- **子 agent 用哪个模型**：默认和主对话用同一个模型、同样的思考程度。想让调研固定用某个会思考的模型（比如 DeepSeek 的推理模型），在 `%USERPROFILE%\.ferry\agents\research.md` 里写这几行，提示词和工具照旧：
  ```
  ---
  name: research
  model: deepseek-think
  ---
  ```
  `model` 填服务端列出的模型名（`/model` 里能看到）。`explore`、`general` 也一样。
- **待办清单**：三步以上的活，agent 先列待办（输入框上方的 `To-do (1/3 done)`），开始一项、做完一项马上更新，清单上标着的就是它正在做的。小活不列。清单没做完就想停，会被要求接着做完（最多三次，而且清单要有进展）。

`/tasks` 一次看全：待办、子 agent（在跑的和跑完的）、后台命令，可以看输出、停止。退出 ferry 时后台任务一起停掉。

后台任务结束时会通知你，agent 也马上拿到结果，不用你再发消息：它已经停下来了，就自己接着开一轮，用上结果或者把结果告诉你；它还在干别的，就在下一步看到。比如你说"把这几篇稿件各自读一遍，读完汇总"，然后去干别的，回来时汇总已经写好了。你自己停掉的任务不会叫醒它。不想让它自己接着干：`ferry config set wakeOnJobEnd false`，这时 agent 在你下一条消息时才知道结果。`ferry -p` 也是这样。

## 权限

Shift+Tab 在四种模式之间切换，底栏显示当前模式：

| 模式 | 改文件 | 执行命令 |
|---|---|---|
| 默认 | 问 | 只读命令（`git status`、`dir`、`rg`……）不问，其他问 |
| 自动改文件 | 项目文件夹里的不问 | 同上 |
| 只读规划 | 不允许 | 只允许只读命令 |
| 全部放行 | 不问 | 不问，上传和删除除外（见下） |

- 确认框里可以选"以后都允许这类命令"，比如以 `npm test` 开头的命令。规则按项目记住。
- 危险操作（删整个目录、`git push --force`、`git reset --hard`、`curl … | sh`……）除了"全部放行"以外都会问，并说明危险在哪。
- 把本机文件或数据发到网络上的命令，每次都问，"全部放行"也问，已有的 `bash(curl*)` 这类规则也放不过去，确认框里没有"以后都允许"。比如 `curl -d/-F/-T/--json`、`wget --post-file`、PowerShell 的 `Invoke-WebRequest -InFile/-Body/-Method Post`、往远程主机的 `scp`/`rsync`/`sftp`/`ftp`。提示是"Careful: this sends data from this computer to 主机名"。普通下载（`curl -L -o 文件 网址`）和发给本机 `localhost` 的请求不算。
- 删除文件（`rm`、`rmdir`/`rd /s`、`del`、`Remove-Item`）：所有模式下规则都一样。要删的东西都是这次对话里 agent 自己新建的，就直接删，不问，不管在项目文件夹、%TEMP% 还是 D:\tmp。Ferry 会把路径列出来再判断：通配符（`rm tmp_*.txt`、`Remove-Item .\out\*.json`）展开成现在匹配到的文件，每一个都得是新建的，没有匹配就当什么都不删；`%TEMP%`、`%USERPROFILE%`、`%LOCALAPPDATA%`、`%APPDATA%`、`$env:TEMP`、`$TEMP`、`$HOME`、开头的 `~` 换成真实路径；`cd 目录 && rm x`（或用 `;`）按这个目录算。只要有一个不是新建的（原来就有的文件、不认识的变量、一个通配符匹配超过 2000 个文件、没法跟着走的 `cd`、`git clean`，以及列不出要删什么的写法，比如 `find -delete`、`xargs rm`、`rimraf`、`python -c`/`node -e` 里删文件），就每次都问，也没有"以后都允许"。提示里会写明是哪一个目标不是新建的，或者什么没法列出来。删文件夹时，里面每个文件都得是新建的。重新打开 ferry 接着以前的对话（`ferry -c`、`/resume`），之前在这个对话里新建的文件仍然算。命令里除了删除还有别的操作时，其余部分按当前模式判断。计划模式仍然只读。子 agent 要你批准时，主窗口会留一行"哪个子 agent 要做什么、为什么"，你回答后再留一行结果（只显示，不发给模型）。
- 改项目文件夹以外的文件，总要先确认。
- `.env`、`.ssh` 这类路径永远不碰（`blockedPaths` 可改）。read、write、edit 这类文件工具：路径里任何地方出现这个词就拦（比如 `Project Titan/notes.txt` 含 `titan`）。bash 命令：只看像路径的写法，`.env`、`config/.env`、`~/.ssh/id_rsa`、`secrets/key.pem`、`secrets.json` 这样名字是完整的一段或文件名的才拦；普通文字和代码不拦，比如引号里一段话里的 secrets、`fetch(url, {credentials:'include'})`、heredoc 里的正文。
- 启动时用哪种模式：`ferry config set permissionMode acceptEdits`。

## agent 能做的事

### 记忆

跨对话记住你的偏好、纠正和项目里的决定。说"记住……"或"忘掉……"就行。

| 层 | 存在哪 | 放什么 |
|---|---|---|
| 项目 | 工作电脑 `%USERPROFILE%\.ferry\memory` | 这个项目的决定和约定 |
| 个人（user） | 同上 | 这台电脑上所有项目都用得上的偏好 |
| 全局（global） | 服务端，管理页"设备和记忆"里打开 | 你所有电脑共用的偏好、习惯、术语。工作内容不放这里 |

都是能直接改的 Markdown 文件。系统提示里只放目录，正文按需读。agent 用已有的名字再存一条不同的内容时，旧记忆不会被盖掉：它会先拿到旧内容，合并后再确认覆盖，或者换个名字存。

### 联网和下载

- `web_fetch`（读网页）：公开的网页由服务端去读，工作电脑只发地址，拿回结果；公司内网、私有地址（`10.x`、`192.168.x`、没有点的主机名、`.corp` 之类）和 `localSites` 里的网站，以及服务端读不到的网页，在工作电脑上读，走公司代理和网关。要在网站上登录或操作的，用浏览器。
- 和 Claude Code 的 WebFetch 一样，agent 可以带一个问题去读（比如"5.1 节规定了什么"）：读到的文字（最多 10 万字）交给服务端的模型，对话里只放它的回答。这样一次能读十几个网页，对话也不会被撑满。要原文（代码、表格、原话、页面里的链接）时不带问题，拿到的是网页文字，长的分段读。读网页用服务端"写摘要用"的模型，没设就用默认模型。
- 只在工作电脑上读的网站：`ferry config set localSites wiki.corp.com,jira.corp.com`，这些地址不会发给服务端。
- 15 分钟内读过的网页不再重新下载。`web_fetch` 碰到 PDF、Word、Excel、PowerPoint 文件，存进项目的 `downloads` 文件夹，agent 接着用 `office_read` 读。
- `web_search`：由服务端去搜，工作电脑只把搜索词发过去，拿回标题、地址、日期和摘要。服务端接了 DeepSeek 时默认用 DeepSeek 自家的搜索 API，不用另外设置；也可以换成别的（管理页 → 设置 → 网页搜索，见 [SERVER.md](SERVER.md#网页搜索)）。服务端没有搜索来源时，工作电脑读 Bing 的结果页，质量差很多。服务端搜索出错时自动改用 Bing，并告诉 agent。agent 可以只搜某些网站（`allowed_domains`，比如 3gpp.org），或者排除某些网站（`blocked_domains`）。
- 查资料的方法写在 agent 的系统提示里：换几种说法搜，中英文都试，限定权威网站；查会变的东西时搜索词里带上今年的年份；只看摘要不算数，要打开来源读，顺着链接找到原始出处；核对日期和版本，重要的事找第二个来源；回答末尾列出处。问题大的交给调研子 agent。没设搜索来源、Bing 的结果又不对题时，agent 会用本机浏览器打开搜索引擎去搜，和你自己搜一样。
- 下载文件和在 Cursor 里一样直接交代：agent 用 `curl -L --retry 3 -C - -o` 下载（断了能续上），大文件放到后台下。放哪：你说了放哪就放哪；没说就放在合适的地方（和它相关的文件旁边，或者当前文件夹）；都不合适就放项目里的 `downloads` 文件夹。下完删掉没用的临时文件。命令也走公司代理，并且和 ferry 用同一份证书（`%USERPROFILE%\.ferry\ca-bundle.pem`，公司检查 HTTPS 用的证书也在里面）。下完它会确认拿到的不是网关的确认页。
- 不许打开的网站：`ferry config set blockedSites mail.corp.com,chat.corp.com,pan.corp.com`。这些网站和它们的子域名，`web_fetch`、浏览器和命令（比如 curl）都不打开，`web_fetch` 跳转过去的也拦下。

### 浏览器

web_fetch 只把网页的 HTML 转成文字，读不到靠 JavaScript 生成的内容，也不能登录、点击。要在网站上操作（在站内搜索、一页页点下去、填表、登录后办事），agent 用电脑上的 Edge（没有 Edge 就用 Chrome）：打开网页、读脚本跑完后的内容、点击、填表、截图，一直做到拿到要的结果，中途卡住会说清卡在哪。

- 用的是 Vercel 开源的 [agent-browser](https://github.com/vercel-labs/agent-browser)，随 Ferry 一起装好。agent 用命令调用它（`agent-browser open 网址`、`snapshot -i`、`click @e3`……），不需要另外装东西。
- 默认在后台跑，不弹窗口。想一直看着它操作：`ferry config set browserHeadless false`。
- 它用自己的浏览器资料夹（`%USERPROFILE%\.ferry\browser-profile`），和你平时用的浏览器分开，登录过的网站会记住。
- 碰到要登录的网站，agent 先告诉你要登录哪里，然后弹出一个窗口（同一个浏览器和资料夹，按普通方式打开）。你在里面登录，登录好后 agent 直接在这个窗口里接着做，不用敲命令，也不用关窗口。用完它把窗口关掉，回到后台，登录还在。密码只由你自己输入。
- 为什么要"按普通方式打开"：Google、Microsoft 等网站能看出浏览器正被程序控制，会拒绝登录（提示"此浏览器或应用可能不安全"），防机器人盗号。所以登录用的窗口不受程序控制，你登录好之后 agent 才连上去。
- 这两步对应的命令是 `ferry browser login 地址` 和 `ferry browser hide`，你也可以自己运行，比如提前登录好 Google。
- 只看页面（`snapshot`、`get`、`screenshot`）不问你；打开网页、点击、填表要先确认，选"以后都允许"就是 `bash(agent-browser*)`。
- 碰到你隐私的命令每次都问，"全部放行"模式和"以后都允许"也一样：读写 cookie 和网站存储、保存或载入登录状态、读写剪贴板、上传文件、用保存的密码、连到别的浏览器、录网络流量，以及换浏览器资料夹的选项。提交、发送、下单、发帖、改账户设置、删除这类撤不回的操作，agent 会先问你。网站要摄像头、位置等权限时，agent 不会替你同意。
- 走公司代理，用这台电脑信任的证书。碰到公司网关的确认页，agent 会告诉你，不会替你点过去。
- ferry 退出时把浏览器关掉。不想让 agent 用浏览器：`ferry config set browser false`。用别的浏览器：`ferry config set browserPath C:\路径\chrome.exe`。
- 浏览器用不了时（没找到 Edge 或 Chrome、从源码运行没跑 `npm ci`），agent 一用就会告诉你原因和怎么修。`ferry doctor` 里 `browser:` 那一行也写着。

### Office 文件

读 Word（含修订痕迹和批注）、Excel、PowerPoint、PDF；按修订方式改 Word，像 change request 那样显示删了什么、加了什么；改 Excel 单元格；从 Markdown 新建 Word、从表格新建 Excel。直接处理文件，不需要装 Office，也不会去操作屏幕上的窗口。

- 旧版文件也能读：Word 97-2003 的 .doc 读出文字（保留分段，表格按行列出），.xls 读出单元格的值，.ppt 按页读出文字。
- 按文件内容判断格式，不看扩展名。扩展名是 .docx、实际是旧版 .doc 或 PDF 的文件，照样能读。
- 用 IRM（权限管理）或密码加密的文件读不了，agent 会直接告诉你，不会换别的办法反复试。
- 文件多的时候用批量模式：给一个文件夹（或 `D:/docs/**/*.doc*` 这样的通配符）和一个输出文件夹，每个文件转成一个 .txt，放在输出文件夹里相同的相对位置。对话里只回一份汇总：成功、失败、加密各几个，失败的是哪些、为什么。几百个文件也不用 agent 自己写脚本。批量模式会写文件，所以和改文件一样：默认模式下先问你，自动改文件模式下直接做，计划模式下不做；输出文件夹在项目外面时也会问。
- agent 不会用 COM 去操作 Word、Excel、PowerPoint（win32com、PowerShell 的 `New-Object -ComObject`）。很多公司电脑禁止这样做，也用不着。

### 图片

告诉它图片的路径，它用 read 工具读出来交给模型。几 MB 的图片也没问题：发出前缩小到长边 1568 像素、约 300 KB 以内，超过上传上限还会分块发。对话里只保留最近 4 张（`keepImages`）。默认每个模型都能看图，只认文字的模型在服务端给它加 `vision = false`。

`image_create` 可以画图：服务端交给"生成图片用"的模型，PNG 存进项目文件夹。

### 上下文和找回

- 命令输出太长时，全文存到文件，只给模型看开头和结尾，需要时它自己去读。
- 上下文超过 80k（`trimOldOutputs`）后，很久以前的长工具输出换成一行说明，最近 6 个保留。
- 上下文用到 90%（`compactAt`）或 40 万 token（`compactLimit`），哪个先到就自动写摘要压缩，最近 20k（`compactKeep`）原样保留。每次请求模型之前都会查，所以一个很长的任务做到一半也会压缩，不用等请求结束。之后需要原文，agent 用 `history_search` 在本地完整记录里找回。
- 摘要一定会留下：你说过的话（短的原文，长的如实概括）、保密要求和"不要"类的要求（原文）、`/goal` 的目标和进度、产出文件的路径和完成程度、下一步。服务端 `rules/_summary.md` 里还可以再加自己的要求。
- 压缩之后，agent 收到一条短提示（记在对话里，不显示）：之前建过或改过的文件路径、用过的技能、现在的待办清单（只有路径，没有文件内容），让它先重读再动手，压缩不会把任务状态丢掉。
- 连续两次写摘要失败，这次请求里就不再自动压缩，底部有提示，开了手机通知也会推一条；你发下一条消息后恢复。想马上试可以用 `/compact`。
- 说"看看我昨天那个对话里定了什么"，它会用 `past_conversations` 列出、搜索、读取这台电脑上以前的对话（默认这个文件夹的，也可以搜全部）。

### 其他

| 能力 | 说明 |
|---|---|
| 提问 | `ask_user`：agent 拿不准时弹出选项让你选，推荐项排在最前，最后一项"其他"可以自己写，按 Esc 不回答。没有终端时（`-p`、团队成员）按推荐项继续并说明 |
| 思考 | Claude 和 GPT 默认中等思考，难的活可以调高：`/config` → `thinking` |
| 花费 | 底栏显示这次对话花了多少钱，`/cost` 看明细，服务端管理页"用量和费用"按天、项目、模型汇总 |
| 提醒 | 一个请求超过 30 秒才做完，响一声并弹出 Windows 通知 |
| 手机通知 | 用 Bark 推到手机（管理页 → 设置 → 手机通知，贴上 Bark 地址）。这几种情况会推：做了 5 分钟以上的活做完了，或者因为出错停下（带一句原因）；目标完成或卡住；确认框等你超过 5 分钟。你自己按 Esc 停下的不推。做完的那条里是一句话回顾（见[旁问、顾问和回顾](#旁问顾问和回顾)），内容来自这次对话；不想让对话内容出现在手机通知里，把 `recap` 设成 `false`，通知就只写“做完了，用了几分钟” |

## Agent 团队

想要"负责人派活，调研、分析、写 PPT 各管一摊，互相留言"，用 [Paperclip](https://github.com/paperclipai/paperclip) 当看板（组织架构、任务、评论、仪表盘，在工作电脑本机打开）。每个成员都跑 Ferry，模型调用照样走你的 Ferry 服务端。

```powershell
ferry team start                            # 窗口 1：启动看板（第一次会自动装好，需要 Node 24.11+）
ferry team init                             # 窗口 2，在项目文件夹里：建一个负责人 + 调研 + 分析 + 撰写的团队
ferry team goal "调研三种方案并写汇报 PPT"     # 给负责人一个目标，然后在看板上看进度
```

`ferry team start` 等看板起来后自动在浏览器里打开 http://127.0.0.1:3100 （不想自动打开：`--no-open`）。

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
| `web` | `client` | 联网工具（`web_fetch`、`web_search`）：`client` 在这台电脑上执行，`off` 关掉 |
| `browser` | `true` | 让 agent 操作本机浏览器（Edge / Chrome），见[浏览器](#浏览器) |
| `goalMaxTurns` / `goalBudget` | `100` / `0` | `/goal` 最多轮数和 token 预算（如 `2m`，0 表示不限） |
| `notify` | `true` | 长请求结束时响铃加通知 |
| `phoneNotify` | `true` | 让服务端推手机通知（服务端要先在管理页设好 Bark） |
| `advisor` | `true` | 顾问工具：服务端有顾问模型时，agent 可以请更强的模型检查工作 |
| `recap` | `true` | 长请求做完后，手机通知和状态栏里放一句话回顾 |
| `blockedSites` | 空 | 永远不打开的网站（含子域名），比如邮箱、通讯、网盘 |
| `blockedPaths` | `.env,.ssh,id_rsa,secrets,credentials` | 永远不读、不改、不在命令里出现的路径（文件工具按路径里是否含这个词；命令里按路径的一段或文件名匹配，文字里出现不拦） |
| `proxy` | 空 | 连服务端用的代理，空表示用 `HTTPS_PROXY` 环境变量 |
| `compactAt` | `90%` | 上下文用到多少时自动压缩：`50%`～`90%`，或 `off`（只在快超限时压缩，这时 `compactLimit` 也不起作用）。越低每次请求越便宜，也越早丢细节 |
| `compactLimit` | `400k` | 上下文最多到多少 token 就压缩，和 `compactAt` 哪个先到听哪个。100 万上下文的模型用到 400k 时请求已经又慢又贵。`0` 表示不设上限，只看 `compactAt`。改后下次启动 ferry 生效；`/context` 改了大小会马上按新大小算 |
| `compactKeep` | `20k` | 压缩时最近多少内容原样保留 |
| `showModel` | `true` | 屏幕右下角是否显示模型名。设成 `false` 就不显示，也不会换成别的名字；`/model` 和 `/status` 仍然会写出真实的模型 |
| `keepImages` | `4` | 对话里保留最近几张图片，更早的换成一句说明 |
| `systemCerts` | `true` | 同时信任这台电脑信任的 HTTPS 证书。公司代理用自己的证书检查 HTTPS 时，靠它让 ferry 和命令都能连上 |
| `caFile` | 空 | 再加一个证书文件（.pem），比如找 IT 要的公司代理证书；电脑自己的证书不够时才需要 |

很少需要改的，用 `ferry config --all` 或 `/config` → More settings 查看：`trimOldOutputs`（默认 80k，0 表示不省略）、`maxParallel`（默认 3）、`phoneAfterSeconds`（长任务做完多久算久，默认 300 秒）、`phoneApprovalSeconds`（确认框多久没人点就推到手机，默认 60 秒，每个确认框只推一次）、`subagents`、`bigOutputBytes`、`notifyAfterSeconds`、`updateCheck`、`browserPath`、`browserHeadless`、`chunkBytes`（单个请求的最大字节数，默认 512 KB；被网关挡下时会自己减半，见下面的报错说明）、`rulesFromParents`。上下文长度用 `/context` 改，存在同一个文件里。

服务端的设置见 [SERVER.md](SERVER.md#服务端设置)。

## 出问题了怎么办

先运行 `ferry doctor`，它逐项检查，并告诉你下一步该做什么。

| 看到 | 原因和办法 |
|---|---|
| `the company network gateway wants a confirmation` | 公司网关要你先确认。运行 `ferry` 或 `ferry check`，它会在浏览器里打开确认页，你点"继续"后自己接着跑。确认过一阵会过期，干活中途碰到也会自动打开确认页、等确认后重发。长期办法是请 IT 把服务端地址加进白名单 |
| `cannot reach the server` | 浏览器能打开但 ferry 连不上，通常是浏览器走了公司代理。执行 `setx HTTPS_PROXY http://代理:端口`，然后重开 cmd |
| `unable to get local issuer certificate` | 公司代理会解开 HTTPS 再加密。`systemCerts` 默认已打开；还不行，把公司根证书导出成 .pem，`ferry config set caFile C:\路径\证书.pem` |
| `The Ferry server did not get this request: ...` | 请求在半路被挡了，服务端的调用记录里看不到。后面那句会说是谁挡的：Cloudflare 的机器人防护（在 Cloudflare 后台关掉 Bot Fight Mode，或给 Ferry 的域名加一条跳过规则）、公司网关（Ferry 会打开确认页，确认后重发），或公司代理。详情记在 `%USERPROFILE%\.ferry\logs\blocked.log`。`ferry doctor --upload` 测多大的上传能通过：先试几个大小，再在能过和不能过之间折半查找，精确到 8 KB，并建议一个略小的 `chunkBytes`。Ferry 每个请求都不超过 `chunkBytes`，被网关挡下（403）或被 Cloudflare 挡下（502、530 等）、连接断开时，会等一下再发，最多三次，403 时还把单个请求减半并提示一次。子 agent 遇到同样的情况也会先重试，仍然不行才停，报错里写明原因和已做的步骤 |
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
3. 报告只发到你自己的 Ferry 服务端，工作电脑不需要能上 GitHub。服务端再隐去你在管理页列的词、内网 IP、邮箱、手机号、Key 和路径里的用户名，然后用它自己的 GitHub 令牌开一个 issue。服务端怎么设见 [SERVER.md](SERVER.md#问题报告)。
4. 服务端没设令牌或连不上 GitHub 时，报告留在服务端，管理页里能看到、能再发一次。工作电脑连不上服务端时，报告存在 `%USERPROFILE%\.ferry\reports`，下一次 `/report` 时一起发。

仓库是公开的，issue 谁都能看到。发之前请把报告从头看一遍。

