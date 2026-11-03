# 真实任务评测

`selftest/run.py` 用假模型，只能证明各部分连得通。这里用真模型跑一组有标准答案的日常任务，看 Ferry 做对了几个、走了多少步、用了多少 token。发版前跑一遍，和上一版比。

## 在 Windows 上跑

需要 Node.js 22+、Python 3.11+，环境变量里有 `DEEPSEEK_API_KEY`。在 ferry 的 git 文件夹里：

```bat
git pull
python evals\run.py
```

第一次运行时，脚本会自己执行 `npm ci`（装客户端的依赖）和 `pip install -e server`（给这个 Python 装上服务端），以后就跳过。

- 每个任务在 `evals\runs\` 下有自己的文件夹，用自己的 `FERRY_HOME`，并且每次运行都临时起一个 Ferry 服务端（`FERRY_SERVER_HOME` 也是临时的），所以不会碰你平时的设置和服务端。agent 在"全部放行"模式下跑。
- 结果存进 `evals\results\<时间>-<版本>.json`，屏幕上打印一张表，并和上一次的结果比较。把这个 json 提交推送上来，下一个会话就能看到。
- 任务每次都一样，模型的回答每次会有些不同，所以同一个任务这次过、下次不过是正常的。要比较两个版本，用 `--repeat 3` 看通过率，比只跑一次可靠。
- 没通过的任务保留文件夹：`answer.txt` 是 agent 的回答，`ferry.log` 是运行记录，`project\` 是它改过的文件。

常用的参数：

| 参数 | 作用 |
|---|---|
| `--only fix_bug,explore` | 只跑这几个 |
| `--repeat 3` | 每个跑 3 次（模型每次不一样，看通过率更准） |
| `--skip-network` | 跳过要上网的任务（下载 3GPP 规范） |
| `--model deepseek-v4-pro` | 换一个 DeepSeek 模型（默认用 Ferry 给 DeepSeek 设的默认模型） |
| `--provider claude` | 改用 Claude（要有 `ANTHROPIC_API_KEY`），`openai` 同理 |
| `--ferry D:\ferry\app\client\bin\ferry.mjs` | 测装好的那一份 Ferry，而不是这个文件夹里的 |
| `--verify` | 不调模型，只检查每个任务的判分写得对不对 |

## 现在的任务

| 任务 | 考什么 |
|---|---|
| `fix_bug` | 跑测试、找出 bug、只改代码不改测试 |
| `rename` | 跨文件改函数名，改完跑测试 |
| `explore` | 在一堆相似的数字里找到真正的 HTTP 超时设置 |
| `word_tracked` | 用修订方式改 Word 里的一个数字，别的不动 |
| `word_report` | 按笔记写 Word 报告，三个小节、数字不丢 |
| `excel_summary` | 按地区汇总 Excel，写 summary.md，说出最高的地区 |
| `browser_page` | 用浏览器打开脚本生成内容的页面，填表、点按钮，读出结果（agent-browser 加电脑上的 Edge） |
| `gpp_download` | 从 3GPP 网站找到并下载 TS 23.501，解压，读出 5.15 节标题（要上网） |

## 加一个任务

在 `evals\tasks\` 里放一个 `.py` 文件，写这几样：

- `TITLE`、`PROMPT`（就像你在 ferry 里输入的那句话）、`TIMEOUT`（秒）、`NETWORK`（要不要上网）；
- `setup(work)`：在空文件夹 `work` 里放好任务要用的文件；
- `check(work, answer)`：判分，返回 `(是否通过, 一句说明)`；`answer` 是 agent 最后的回答；
- `solve(work)`：标准答案，给 `--verify` 用，证明判分本身没写错。

最好的任务来自真实的失败：工作中 Ferry 哪里没做好，就把那件事（换成编的内容）做成一个任务。修好之后，它就一直守着这个问题。
