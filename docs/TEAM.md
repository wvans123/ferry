# Agent 团队：Paperclip 当看板，成员跑 Ferry

[Paperclip](https://github.com/paperclipai/paperclip)（MIT 开源）是一个管 agent 团队的网页：组织架构、任务、评论、运行记录、仪表盘。它本身不带 agent，每个成员要接一个"干活的程序"。这里让每个成员都跑 Ferry：

```
你（浏览器 http://127.0.0.1:3100）
   │ 发任务、评论、看进度
   ▼
Paperclip（工作电脑上，只在本机打开）
   │ 有活了就叫醒对应成员：启动一次 ferry
   ▼
ferry（Lead / Researcher / Writer …）── 读写项目文件、跑命令、改 Office 文件
   │ 模型调用照常走
   ▼
Ferry 服务端（家里电脑）── 每次上传不超过 1 MB，key 只在服务端
   ▼
模型
```

成员之间靠任务和评论协作：
- 负责人（Lead）把目标拆成子任务派给成员；派完自己的任务进入"等待"，子任务都完成后 Paperclip 自动叫醒它接着做。
- 成员在任务下留言，`@名字` 提到别人；完成时写明结果放在哪。
- 你在任何任务下留言，相当于插话；网页版 ChatGPT、Claude 的活，可以把任务派给你自己（"人"也是任务的负责人），做完把结果贴回评论。

## 在工作电脑上装

1. **Node.js 24.11 或更新版本**。Paperclip 需要它，Ferry 在 Node 24 上也能用。在 PowerShell 里用 `node --version` 看版本。
2. **第一次**，在一个普通文件夹里运行：
   ```powershell
   $env:PAPERCLIP_TELEMETRY_DISABLED = "1"; $env:DO_NOT_TRACK = "1"; $env:PAPERCLIP_ANNOUNCEMENTS_ENABLED = "false"
   npx paperclipai onboard --yes
   ```
   它会把数据放在 `%USERPROFILE%\.paperclip`（自带数据库，不用另装），然后启动并打开 http://127.0.0.1:3100 。前面三个变量用来关掉统计上报和公告拉取，工作电脑上建议设。
3. **以后**每次用之前运行（同样先设那三个变量）：
   ```powershell
   npx paperclipai run
   ```
   这个窗口开着，团队就在；关掉窗口，团队就停。

Paperclip 默认只在本机（127.0.0.1）打开，不需要登录。它自己不调用模型；所有模型调用都由 ferry 发给你的 Ferry 服务端。

## 建团队

在项目文件夹里运行（成员会在这个文件夹里干活）：

```powershell
ferry team add Lead --title "负责人" --about "拆解目标，派活给成员，检查结果，最后汇总"
ferry team add Researcher --title "调研" --about "查资料、找竞品和数据，结果写成 research/*.md"
ferry team add Analyst --title "方案分析" --about "比较方案的利弊和风险，写 analysis.md"
ferry team add Writer --title "PPT 撰写" --about "根据调研和分析写汇报材料（用 office 工具生成 pptx/docx）"
ferry team status
```

- 第一个加的是负责人（CEO），后面的默认向它汇报（`--boss` 可以改）。
- 名字建议用英文（`@Researcher` 好打），中文写在 `--title`、`--about` 里。`--about` 会成为这个成员的说明；想写长一点，用 `--instructions 说明.md`。
- 加完 Paperclip 会让每个成员先回一句 hello，确认能通过你的 Ferry 服务端调到模型；通过后状态变成 idle。
- 也可以在网页里加：New agent → 选 Pi → Advanced 里选 Legacy runner，command 填 `ferry.cmd` 的完整路径（`where ferry` 能查到），model 填 `ferry/auto`。

## 下达目标

在网页里 New Task，负责人选 Lead；或者：

```powershell
ferry team task "调研 6G 数据开放的三种方案，写一份对比和汇报 PPT" --to Lead --text "交付物放在 deliverables/ 下"
```

然后在网页上看：仪表盘显示谁在干什么，任务页能看到子任务、评论和每次运行的完整记录（ferry 做了什么、调了哪些工具）。

## 成员能做什么

每次被叫醒，成员就是一次完整的 Ferry：读写文件、跑命令、Office、联网（按你的 Ferry 设置）、子 agent。另外多一个 `team` 工具操作看板：

| 动作 | 作用 |
|---|---|
| board | 我被分配的任务、团队成员和状态 |
| read | 读一个任务和它的评论 |
| take | 认领任务 |
| comment | 留言（`@名字` 提到别人） |
| update | 改状态：done / blocked（等别的任务）/ in_review，可附留言 |
| create | 新建子任务派给某个成员；`wait: true` 时自己的任务等它完成后再被叫醒 |

## 记忆

- **项目记忆**：同一个项目文件夹的成员共用，相当于团队的共享记忆（背景、术语、决定）。
- **角色记忆**：每个成员自己的，记"我这个角色怎么做事、踩过什么坑"，别人看不到。
- **用户记忆**：你这台电脑上所有 Ferry 共用（你的偏好）。

都在 `%USERPROFILE%\.ferry\memory\` 下，Markdown 文件，可以直接看、改。

## 权限

成员在后台运行，没人在终端前点确认，所以默认用 auto 模式：项目里改文件、只读命令直接做；拿不准的命令交给服务端的判断模型，它明确说安全才做；危险命令（比如 `rm -rf`）直接拒绝，成员会在任务里说明卡在哪。想换：在成员的设置里加环境变量 `FERRY_PERMISSION_MODE`（`acceptEdits`、`auto`、`bypass`）。

## 花费和并发

- 每次叫醒就是一次 ferry 运行，3 个成员同时干活，token 大约是 3 倍。
- Ferry 服务端的"同时调用上限"（管理页 → 设置）照样管着：超过就排队，不会压垮服务端。
- 成员默认不定时醒来，只有派活、评论、子任务完成时才醒。

## 出问题时

- 成员一直 paused / verifying：加成员时的 hello 检查没通过。先在同一台电脑运行 `ferry -p "Respond with hello"` 看能不能答。
- 任务卡在 blocked：打开任务看最后的评论，成员会写原因；你回复评论就会叫醒它。
- 看某次运行到底做了什么：成员页面 → Runs。

## 验证情况

在 Linux 上用测试模型跑通了真实的 Paperclip（2026.1023.0）：Lead 拆出子任务给 Researcher、自己进入等待；Researcher 写文件并完成；Lead 被自动叫醒，读结果、写计划、完成。自测 F54 检查 ferry 按 Paperclip 的参数启动时 team 工具的每个请求。还没在 Windows 和真实模型上试过。
