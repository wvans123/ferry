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

## 在电脑上装（工作电脑或 Mac 都一样）

1. **Node.js 24.11 或更新版本**。Paperclip 需要它，Ferry 在 Node 24 上也能用。用 `node --version` 看版本，不够就装 nodejs.org 上的 LTS 版本（公司电脑可以走软件中心）。
2. 运行：
   ```
   ferry team start
   ```
   第一次它会从 npm 下载 Paperclip 并完成设置（一分钟左右，数据放在 `~/.paperclip`，自带数据库，不用另装），以后每次就是启动。看板在 http://127.0.0.1:3100 ，只在本机打开、不用登录。这个窗口开着团队就在，Ctrl+C 停止。
   它会自动关掉 Paperclip 的统计上报和公告拉取。用的是 Ferry 测过的 Paperclip 版本；想用最新版：`ferry team start --version latest`。

Paperclip 自己不调用模型；所有模型调用都由 ferry 发给你的 Ferry 服务端。

## 三步用起来

需要两个终端窗口。

**窗口 1：开看板**（这个窗口一直开着）
```
ferry team start
```

**窗口 2：在项目文件夹里建团队、给目标**
```
cd 你的项目文件夹
ferry team init
ferry team goal "调研 6G 数据开放的三种方案，比较利弊，写一份汇报 PPT"
```

**然后在浏览器打开 http://127.0.0.1:3100 看进度。**

`ferry team init` 建一个现成的四人团队，都在这个项目文件夹里干活：

| 成员 | 做什么 | 交付 |
|---|---|---|
| Lead（负责人） | 拆目标，把各部分派给下面三个，等他们做完后检查、补漏、汇总 | 最终交付物 |
| Researcher（调研） | 查资料、找数据，写明出处 | `research/*.md` |
| Analyst（方案分析） | 比较方案利弊、风险、成本；缺资料就给 Researcher 派任务 | `analysis.md` |
| Writer（汇报撰写） | 写 Word 或 PPT | `deliverables/` |

你在网页上能做的：
- 看每个人在干什么（仪表盘），点进任务看子任务、留言、每次运行的完整记录（调了哪些工具、写了什么）；
- 在任何任务下留言，相当于插话，会叫醒负责这个任务的成员；
- 改成员的说明（成员页 → Instructions），或者新建任务直接派给某个成员；
- 需要网页版 ChatGPT/Claude 做的部分：新建任务派给你自己，做完把结果贴在留言里。

想换团队组成：`ferry team add <英文名> --title "中文职位" --about "做什么、交付什么"`（第一个加的是负责人，后面的默认向负责人汇报），也可以在网页里 New agent（选 Pi → Advanced 里选 Legacy runner，command 填 ferry 的完整路径，model 填 `ferry/auto`）。

加完成员，Paperclip 会让每人先回一句 hello，确认能通过你的 Ferry 服务端调到模型；通过后状态变成 idle，才会接活。

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

成员在后台运行，没人在终端前点确认，所以默认"自动改文件"：项目里改文件、只读命令直接做；其他要确认的命令不做，成员会在任务里说明卡在哪，你在留言里回复或者自己处理。想全部放行：在成员的设置里加环境变量 `FERRY_PERMISSION_MODE=bypass`。

## 花费和并发

- 每次叫醒就是一次 ferry 运行，3 个成员同时干活，token 大约是 3 倍。
- Ferry 服务端的"同时调用上限"（管理页 → 设置）照样管着：超过就排队，不会压垮服务端。
- 成员默认不定时醒来，只有派活、评论、子任务完成时才醒。

## 出问题时

- 成员一直 paused / verifying：加成员时的 hello 检查没通过。先在同一台电脑运行 `ferry -p "Respond with hello"` 看能不能答。
- `ferry team start` 说 Node 版本不够：装 Node.js 24.11+ 后重开终端。
- 任务卡在 blocked：打开任务看最后的评论，成员会写原因；你回复评论就会叫醒它。
- 看某次运行到底做了什么：成员页面 → Runs。

## 验证情况

在 Linux 上用测试模型跑通了真实的 Paperclip（2026.1023.0）：Lead 拆出子任务给 Researcher、自己进入等待；Researcher 写文件并完成；Lead 被自动叫醒，读结果、写计划、完成。自测 F54 检查 ferry 按 Paperclip 的参数启动时 team 工具的每个请求。还没在 Windows 和真实模型上试过。
