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

## 搜索评测

`evals/search_eval.py` 只量搜索，不跑 agent。`evals/search/queries.json` 里有 27 个真实的查询（3GPP 规范、电信术语、技术文档、报错信息、中文资讯和产品文档），每个写了"前 5 条里要有哪个网站"。脚本把每个查询发给每个搜索来源各搜一遍，再走一遍服务端的组合搜索（几家一起查、合并、摘段落），打印每种方式的命中率、耗时中位数和出错次数，组合搜索还打印平均字数和段落数。

在服务端那台电脑上，ferry 的 git 文件夹里：

```bat
python evals\search_eval.py
```

- 用的是服务端自己的设置和 Key（`FERRY_SERVER_HOME`，默认 `~/.ferry-server`）：管理页填的 Key、`FERRY_SEARCH_KEY_<来源>`、模型的 DeepSeek Key。没有 Key 的来源跳过；Exa 免费搜索不用 Key。`bing` 是在这台电脑上读 Bing 的结果页，相当于工作电脑没有服务端时的做法，当作基线。
- `--sources exa,bing` 只测这几家，`--only ts38331,cn_5ga` 只跑这几个查询，`--no-combined` 不跑组合搜索。
- 结果存进 `evals\search\results\<时间>.json`，提交上来，以后改搜索先跑一遍，和上一次比。
- Exa 免费搜索同时搜得太多会被限流（429），所以默认一次只跑 2 个查询。
