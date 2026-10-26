# 在 Windows 上安装和使用 Ferry

装好以后的用法和 Cursor CLI 一样：在 cmd 里进入项目文件夹，输入 `ferry`，就进入对话界面。

| 步骤 | 做什么 | 用时 |
|---|---|---|
| 一 | 解压安装包，运行一条安装命令 | 3 分钟 |
| 二 | `ferry doctor` 检查环境 | 1 分钟 |
| 三 | 在测试文件夹里运行 `ferry`，开始对话 | — |
| 以后 | `ferry update` 一条命令更新到 GitHub 上的最新版 | 1 分钟 |

不需要虚拟环境（venv），不需要 Docker，不需要 npm 和 PyPI：安装包里已经带好全部依赖，服务端直接装进电脑上现有的 Python。

**所有命令都在"命令提示符"（cmd）里执行。** 开始菜单搜索 `cmd` 打开。公司电脑常禁止 PowerShell 运行脚本，cmd 没有这个限制。

**试用时请用一个空的测试文件夹和自己编的内容**，不要直接拿公司真实代码试。

---

## 先了解：这一版在你电脑上是怎么跑的

```
cmd 窗口里的 ferry ──(本机 127.0.0.1)──> Ferry 服务端 ──(≤ 900KB/次，敏感词已替换)──> 模型 API
   读写文件、执行命令                        拼完整上下文、脱敏、压缩                  DeepSeek / Claude / OpenAI
   保存对话记录                              从环境变量读 API Key
```

- 你只运行 `ferry`。它会在后台自动启动一个 Ferry 服务端，窗口关掉时服务端一起退出。每个 cmd 窗口各用各的，互不影响。
- 服务端从环境变量读取 Key，不用写任何配置文件：设了 `DEEPSEEK_API_KEY` 就用 DeepSeek，设了 `ANTHROPIC_API_KEY` 就多一个 Claude，设了 `OPENAI_API_KEY` 就多一个 OpenAI（见文末"换成 Claude 或 OpenAI"）。
- 这种用法服务端和客户端在同一台电脑上，所以是这台电脑直接访问模型 API。脱敏和"单次请求不超过 1MB"照样生效。以后有了单独的服务器，只要在工作电脑上执行一次 `ferry login 服务器地址 令牌`，Key 和对话就都放到服务器那边，用法不变。

---

## 第一步：安装

需要：

- Node.js 22 或更高（你已有 v25.8.1）。
- Python 3.11 到 3.14 之一。在 cmd 里输入 `python --version` 能看到版本号即可；提示"不是内部或外部命令"时试 `py -3 --version`。都没有的话，从 python.org 安装，安装时勾选 "Add python.exe to PATH"。

1. 从 GitHub 发布页 https://github.com/wvans123/ferry/releases/latest 下载 `ferry-windows-0.7.0.zip`（版本号以页面上的为准，下面的命令里换成对应的数字）。工作电脑打不开 GitHub 的话，在别的电脑下载后拷过去。
2. 右键 → 全部解压，比如解压到"下载"文件夹，得到 `ferry-0.7.0` 文件夹。
3. 在 cmd 里进入这个文件夹，运行安装命令：

   ```bat
   cd /d %USERPROFILE%\Downloads\ferry-0.7.0
   node client\bin\ferry.mjs install
   ```

   正常输出：

   ```
   Installing Ferry 0.7.0
     files     C:\Users\你\AppData\Local\Ferry\versions\0.7.0
     server    python -m pip install ... ferry-server
     ...（pip 的安装输出，最后是 Successfully installed ... ferry-server-0.7.0 ...）
     command   C:\Users\你\AppData\Roaming\npm\ferry.cmd

   Done. Open a NEW cmd window, go to a project folder and run:  ferry
   ```

   安装做了三件事：把程序复制到 `%LOCALAPPDATA%\Ferry`；用 pip 把服务端装进现有的 Python（离线，用安装包里带的文件）；在 Node.js 的命令目录里放一个 `ferry` 命令。解压出来的文件夹之后可以删掉。

4. **关掉这个 cmd 窗口，重新打开一个**，新窗口才认识 `ferry` 命令。

## 第二步：检查环境

```bat
ferry doctor
```

全部正常时：

```
Ferry 0.7.0, Node v25.8.1, win32, settings in C:\Users\你\.ferry
  info  commands run with: PowerShell (Git Bash not found)
  info  proxy: none
  info  no remote server set: using a Ferry server on this computer
  OK    server installed for python
  OK    server running at http://127.0.0.1:5xxxx
  OK    server reachable in 3 ms (server 0.7.0, protocol 1)
  OK    token accepted; the server picks the model: auto -> deepseek (deepseek-chat)
  info  conversation on the server: cached in memory only; the full history stays on this computer
  info  asking each model for a two-word answer (a few tokens)...
  OK    model deepseek (deepseek-chat) answered in 900 ms
```

| 看到 | 处理 |
|---|---|
| `model deepseek has no API key` | 没读到 Key。执行 `setx DEEPSEEK_API_KEY 你的key`，**重新打开 cmd** 再试。`echo %DEEPSEEK_API_KEY%` 能显示出 key 才算设好 |
| `model ... HTTP 401` | Key 不对或已失效 |
| `model ... HTTP 402` | 账户余额不足 |
| `model ... HTTP 403` | 服务商拒绝：通常是它不服务请求发出的地区（见文末），或 Key 没有权限 |
| `model ... ConnectError` / `ConnectTimeout` | 这台电脑连不上模型 API，多半要走公司代理，见第三步后面的"连不上模型时" |
| `the Ferry server is not installed for Python here` | 第一步第 3 条的 pip 没成功，把那一步的输出发给我 |
| `ferry` 不是内部或外部命令 | 没有重开 cmd；或者安装输出最后提示了 "is not on PATH yet"，按提示把那个文件夹加到 Path |

`doctor` 是"体检"命令：从本机环境查到服务端、令牌，最后给每个模型发一个只要回答两个字的请求（花几个 token），所以全是 OK 就说明 Key、网络和模型名都没问题。不想花这几个 token 时用 `ferry doctor --no-model`。

## 第三步：开始对话

```bat
mkdir C:\ferry-test
cd /d C:\ferry-test
echo 服务器 test-host-01 的地址是 10.9.8.7 > notes.txt
ferry
```

进入界面后，顶部显示 `Ferry v0.7.0  server on this computer`，底部是输入框。直接打字，回车发送，比如：

```
读一下 notes.txt，然后新建 summary.md，用一句话总结它的内容
```

你会看到它先读文件，再要求写文件。**修改文件和执行命令之前会弹出确认框**，用方向键选 `Allow` 回车才会执行。

常用操作：

| 操作 | 方法 |
|---|---|
| 退出 | 快速连按两次 Ctrl+C（输入框为空时也可以按 Ctrl+D） |
| 换行（不发送） | Shift+Enter；cmd 窗口里不灵时用 Ctrl+J |
| 新开一段对话 | 输入 `/new` |
| 只问一句、打印回答后退出 | `ferry -p "这个文件夹里有什么"` |
| 查看全部选项 | `ferry --pi-help` |

### 连不上模型时

`doctor` 或对话时出现 `ConnectError`、`ConnectTimeout`、`fetch failed`，说明这台电脑访问模型 API 要走公司代理：

1. 查代理地址：`netsh winhttp show proxy`，或者 Windows 设置 → 网络和 Internet → 代理。
2. 设置一次（Ferry 和它启动的服务端都会用这个代理，访问本机不走代理）：

   ```bat
   setx HTTPS_PROXY http://代理地址:端口
   ```

3. 重新打开 cmd，再运行 `ferry`。

## 以后更新

```bat
ferry update
```

它会访问 GitHub 发布页，有新版本就下载、安装，旧版本保留一个以便回退；已经是最新就提示 `is the latest version`。更新后重开正在运行的 ferry 窗口。

工作电脑访问不了 GitHub 时：在别的电脑上从发布页下载 `ferry-windows-x.y.z.zip`，拷过来后执行

```bat
ferry update C:\路径\ferry-windows-x.y.z.zip
```

## 把服务端单独跑起来（为以后放到别的电脑上做准备）

上面的用法里，`ferry` 会自己在后台启动服务端。想先体验"服务端是一台独立的机器"，可以在同一台电脑上开两个 cmd 窗口：

**窗口 1：服务端**（一直开着）

```bat
python -m ferry_server
```

它会打印模型、端口（默认 8787）和各个文件的位置。令牌在 `%USERPROFILE%\.ferry-server\token`。

**窗口 2：客户端**

```bat
for /f "usebackq" %t in ("%USERPROFILE%\.ferry-server\token") do ferry login http://127.0.0.1:8787 %t
ferry doctor
cd /d C:\ferry-test
ferry
```

这时 `ferry` 连的就是窗口 1 里的服务端，和以后连远程服务端完全一样，只是地址换了。想回到自动模式：`ferry logout`。

服务端放在家里的 Mac 上、通过 Cloudflare 域名连接的完整步骤见 [docs/DEPLOY-MAC.md](docs/DEPLOY-MAC.md)。放在别的 Windows 电脑上时，那台电脑运行 `python -m ferry_server --host 0.0.0.0`（允许别的电脑连进来），工作电脑上把地址换成那台电脑的地址再 `ferry login` 一次。

### 要不要 HTTPS

- **同一台电脑、家里的局域网**：用 `http://` 就行。`ferry doctor` 会提示 plain http，可以忽略。
- **经过公司网络或公网**：要加密。用 `http://` 时，令牌和代码内容都是明文，公司代理能直接看到、记录；而且很多公司代理只放行 HTTPS。加密不一定要买域名，可以用 Caddy 的自签证书，或者用加密的隧道（比如 frp 开启 TLS），等确定网络方案后再选。

### 要不要脱敏

不是必须的。默认只替换内网 IP 和邮箱（词表里的词默认为空），关掉的方法：

```bat
setx FERRY_REDACT 0
```

重新打开窗口后，启动的服务端会显示 `redaction: OFF`。用配置文件时写 `redact = false`（放在 `[server]` 下）。

## 可选：在这台电脑上跑自测

想确认这台 Windows 上一切正常（不需要 Key，不访问外网），在解压出来的文件夹里运行：

```bat
cd /d %USERPROFILE%\Downloads\ferry-0.7.0
python selftest\run.py
```

它会依次启动假模型、Ferry 服务端、客户端和假代理，跑 10 组场景，最后一行是 `结果: 25/25 通过`。长会话那一组要几分钟。用到本机端口 8787、8899、9100、9200。有 `FAIL` 时把整个窗口的输出发给我。

## 文件都在哪

| 位置 | 内容 |
|---|---|
| `%LOCALAPPDATA%\Ferry\versions\` | 程序本身（当前版本和上一个版本） |
| `%USERPROFILE%\.ferry\` | 客户端设置 `config.json`、对话记录 `agent\sessions\`、服务端日志 `server.log` |
| `%USERPROFILE%\.ferry-server\` | 服务端数据：会话缓存、审计日志、规则 `rules\_global.md`、脱敏词表 `dictionary.toml` |

脱敏词表 `%USERPROFILE%\.ferry-server\dictionary.toml` 里可以加你们公司的项目名、主机名等，保存后下次启动 ferry 生效。规则文件改完下一轮对话就生效。

## 卸载

1. 删除 `%LOCALAPPDATA%\Ferry` 和 `%APPDATA%\npm\ferry.cmd`；
2. `python -m pip uninstall ferry-server`；
3. 需要的话再删除 `%USERPROFILE%\.ferry` 和 `%USERPROFILE%\.ferry-server`。

## 换成 Claude 或 OpenAI

不用改代码。服务端第一次启动时会在它的数据目录里（默认 `%USERPROFILE%\.ferry-server\`）生成 **`models.toml`**，所有模型都在这里配，**改完保存就生效，不用重启**：

1. 设好对应的 Key：`setx ANTHROPIC_API_KEY 你的key`（或 `OPENAI_API_KEY`、`DEEPSEEK_API_KEY`），重启服务端让它读到新的环境变量；
2. 打开 `models.toml`，把想用的模型那几行开头的 `#` 去掉，型号写在 `model = "..."` 里；
3. `[routing]` 里：`default` 是客户端选 `auto` 时用的模型，`summary` 是写摘要用的（可以填便宜的），`expose = true` 时客户端可以自己挑。

在 `ferry` 里：默认用 `auto`（服务端选），输入 `/model` 可以切到具体模型。`ferry doctor` 会显示 `auto -> 实际用的模型`，并给每个模型发一个小请求确认能用。

`base_url` 不限于官方 API，任何 OpenAI 兼容接口都可以，比如你自己的中转或本机的模型服务。

**注意地区限制**：Anthropic（Claude）和 OpenAI 的 API 不服务中国大陆和香港。从这些地方直接请求通常会被拒（doctor 里看到 HTTP 403），用海外中转去绕也可能违反服务条款。所以要用 Claude 或 OpenAI，Ferry 服务端应该放在它们支持的地区的服务器上（比如新加坡、日本或美国的云服务器），工作电脑执行一次 `ferry login https://服务器地址 令牌` 连过去。DeepSeek 没有这个问题，可以继续在本机模式下用。
