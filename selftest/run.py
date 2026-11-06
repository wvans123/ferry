"""Ferry end-to-end self-test: starts a fake model, the Ferry server and the Ferry client, and checks every item
in GOAL.md. Exit code 0 only when all pass. No real model or API key needed; everything listens on 127.0.0.1.

usage: python selftest/run.py          (needs: node + `npm install` in client/, `pip install -e server/`)
"""
from __future__ import annotations

import argparse
import inspect
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = os.environ.get("PYTHON_BIN", sys.executable)
NODE = os.environ.get("NODE_BIN", "node")
FERRY = [NODE, str(ROOT / "client" / "bin" / "ferry.mjs")]
LIMIT = 1_000_000
TOKEN = "ferry-selftest-token"
TOKEN_BOB = "ferry-selftest-token-bob"
SECRET = "ferry-selftest-secret-0123456789"
CONTENT = ["internal-host-01", "10.1.2.3", "bob@corp.example", "EMP-12345"]  # what notes.txt says
LONG_FILES, FILE_BYTES = 36, 45 * 1024
PROMPT = "请读取 Project Titan 目录下的 notes.txt 并告诉我内容"
results: list[tuple[str, bool]] = []


def check(name: str, ok: bool, detail: str) -> None:
    results.append((name, bool(ok)))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}  {detail}", flush=True)


DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for _stream in (sys.stdout, sys.stderr):  # a console or pipe that cannot show Chinese must not crash the test
    try:
        _stream.reconfigure(errors="backslashreplace")
    except (AttributeError, ValueError):
        pass
WINDOWS = os.name == "nt"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_PROBE = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)


def wait_http(url: str, timeout: float = 60) -> None:
    """Up as soon as anything answers over HTTP (a login-page redirect counts too)."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            _PROBE.open(url, timeout=2)
            return
        except urllib.error.HTTPError:
            return
        except Exception:
            time.sleep(0.5)
    raise RuntimeError(f"{url} did not come up")


def jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def make_work(work: Path) -> Path:
    (work / "Project Titan").mkdir(parents=True)
    (work / "Project Titan" / "notes.txt").write_text(
        "Server internal-host-01 at 10.1.2.3, owner bob@corp.example, ticket EMP-12345.\n", encoding="utf-8")
    (work / "data").mkdir()
    for i in range(LONG_FILES):
        line = f"FILE-{i:02d} line with internal-host-01 and some filler text to make it longer.\n"
        (work / "data" / f"f{i:02d}.txt").write_text(line * (FILE_BYTES // len(line)), encoding="utf-8")
    return work


class Stack:
    """fake model + Ferry server + a fresh Ferry client home"""

    def __init__(self, root: Path, work: Path, mode: str, drop_every: int = 0, context_window: int = 128000,
                 drop_before_chat: int = 0, server_host: str = "127.0.0.1", max_upstream: int = 0,
                 start_server: bool = True, extra_toml: str = "", session_store: str = "",
                 server_env: dict | None = None):
        self.root, self.work, self.procs = root, work, []
        self.base = f"http://{server_host}:8787"
        self.upstream = root / "upstream.jsonl"
        self.data = root / "server-data"
        srv = root / "server"
        (srv / "rules").mkdir(parents=True)
        shutil.copy(ROOT / "server" / "rules" / "_global.md", srv / "rules" / "_global.md")
        (srv / "rules" / "work.md").write_text("- Project rule v1: answer briefly.\n", encoding="utf-8")
        self.rules = srv / "rules"
        cfg = (ROOT / "server" / "ferry-server.example.toml").read_text(encoding="utf-8")
        cfg = cfg.replace('host = "127.0.0.1"', f'host = "{server_host}"').replace('data_dir = "data"', f'data_dir = "{self.data.as_posix()}"')
        cfg = cfg.replace("max_body_bytes = 1000000", f"max_body_bytes = 1000000\nmax_upstream_bytes = {max_upstream}"
                          + (f'\nsession_store = "{session_store}"' if session_store else ""))
        cfg = cfg.replace("https://api.deepseek.com/v1", "http://127.0.0.1:9100/v1")
        cfg = cfg.replace("context_window = 128000", f"context_window = {context_window}", 1)
        cfg = cfg.replace('token_env = "FERRY_TOKEN_WESLEY"',
                          'token_env = "FERRY_TOKEN_WESLEY"\n\n[[users]]\nname = "bob"\ntoken_env = "FERRY_TOKEN_BOB"')
        (srv / "ferry-server.toml").write_text(cfg + extra_toml, encoding="utf-8")
        self.config = srv / "ferry-server.toml"
        self.home = root / "ferry-home"
        if mode.startswith("long:"):  # these check the transport with a really big context: keep every tool output
            self.home.mkdir(parents=True, exist_ok=True)
            (self.home / "config.json").write_text(json.dumps({"trimOldOutputs": "0"}), encoding="utf-8")
        self.env = {**os.environ, "FERRY_SECRET": SECRET, "FERRY_TOKEN_WESLEY": TOKEN, "FERRY_TOKEN_BOB": TOKEN_BOB,
                    "DEEPSEEK_API_KEY": "x", "FERRY_TEST_DROP_EVERY": str(drop_every), "FERRY_HOME": str(self.home),
                    "FERRY_TEST_DROP_BEFORE_CHAT": str(drop_before_chat), "FERRY_AUTO_APPROVE": "1",
                    "FERRY_SERVER_HOME": str(root / "zero-config-home"), "FERRY_PYTHON": PY,
                    "FERRY_UPSTREAM_BASE_URL": "http://127.0.0.1:9100/v1", "FERRY_NO_UPDATE_CHECK": "1",
                    "FERRY_SEARCH_API_EXA": "http://127.0.0.1:9100/exa"}  # never the real Exa
        self.env.update(server_env or {})
        local = "127.0.0.1,localhost"
        for k in ("NO_PROXY", "no_proxy"):
            self.env[k] = f"{self.env[k]},{local}" if self.env.get(k) else local
        self.spawn([PY, "-I", str(ROOT / "selftest" / "fake_llm.py"), str(self.upstream), mode])
        if start_server:
            self.spawn([PY, "-m", "ferry_server", "--config", str(srv / "ferry-server.toml")])
            try:
                wait_http(f"{self.base}/health")
            except Exception:
                self.close()  # never leave a fake model or server behind for the next scenario
                raise

    def spawn(self, cmd):
        log = open(self.root / f"proc{len(self.procs)}.log", "w", encoding="utf-8")
        extra = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if WINDOWS else {"start_new_session": True}
        self.procs.append(subprocess.Popen(cmd, env=self.env, stdout=log, stderr=subprocess.STDOUT, **extra))

    def ferry(self, *args, token=TOKEN, timeout=600, local=False, cwd=None, env_extra=None) -> tuple[int, str]:
        env = {**self.env, "FERRY_SERVER": self.base, "FERRY_TOKEN": token, **(env_extra or {})}
        if local:  # like a fresh install: no server configured, nothing but DEEPSEEK_API_KEY in the environment
            env = {k: v for k, v in self.env.items() if k not in ("FERRY_SERVER", "FERRY_TOKEN", "FERRY_SECRET",
                                                                   "ANTHROPIC_API_KEY", "OPENAI_API_KEY")}
        p = subprocess.run([*FERRY, *args], cwd=cwd or self.work, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout, stdin=subprocess.DEVNULL, env=env)
        (self.root / "client.out").write_text(p.stdout + "\n--- stderr ---\n" + p.stderr, encoding="utf-8")
        return p.returncode, p.stdout + p.stderr

    def http(self, method: str, path: str, body=None, token=TOKEN, headers=None) -> tuple[int, dict | str]:
        data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
        req = urllib.request.Request(f"{self.base}{path}", data=data, method=method,
                                     headers={"Authorization": f"Bearer {token}", **(headers or {})})
        try:
            with DIRECT.open(req, timeout=30) as r:
                raw = r.read().decode()
                return r.status, (json.loads(raw) if raw.startswith("{") else raw)
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            return e.code, (json.loads(raw) if raw.startswith("{") else raw)

    def close(self):
        for p in self.procs:
            try:
                p.terminate() if WINDOWS else os.killpg(p.pid, signal.SIGTERM)
            except (ProcessLookupError, OSError):
                pass
        for p in self.procs:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill() if WINDOWS else os.killpg(p.pid, signal.SIGKILL)


def system_text(body: dict) -> str:
    m = body["messages"][0]
    c = m.get("content")
    return c if isinstance(c, str) else json.dumps(c, ensure_ascii=False)


def check_agent_features(root: Path, work: Path) -> None:
    s = Stack(root, work, "agent")
    try:
        c1, o1 = s.ferry("-p", "MEMTEST-SAVE: remember that tests use the real database")
        c2, o2 = s.ferry("-p", "MEMTEST-RECALL: what do you remember?")  # a new conversation
        mem = list((s.home / "memory" / "projects").glob("*/test-db.md"))
        index = list((s.home / "memory" / "projects").glob("*/MEMORY.md"))
        check("F28 记忆跨会话、存在客户端", c1 == 0 and "Saved project memory" in o1 and c2 == 0 and "INDEX HAS test-db" in o2
              and len(mem) == 1 and index and "[test-db](test-db.md)" in index[0].read_text(encoding="utf-8"),
              "模型用 memory 工具记下一条；记忆文件在工作电脑的 FERRY_HOME/memory；下一次新对话的系统提示里带着记忆索引")

        before = len(jsonl(s.upstream))
        c3, o3 = s.ferry("-p", "TASKTEST: explore the data folder")
        ups = jsonl(s.upstream)[before:]
        sub = [u for u in ups if "<ferry_subagent>" in system_text(u)]
        main = [u for u in ups if "<ferry_subagent>" not in system_text(u)]
        purposes = [a.get("purpose") for a in jsonl(s.data / "audit.jsonl") if a.get("event") == "chat"]
        main_tools = [m for m in main[-1]["messages"] if m.get("role") == "tool"] if main else []
        check("F29 子 agent", c3 == 0 and "EXPLORE REPORT" in o3 and len(sub) >= 3 and len(main) == 2
              and len(main_tools) == 1 and "subagent" in purposes,
              f"主对话调用 task，子 agent 用自己的上下文跑了 {len(sub)} 次模型（ls、read、写报告），"
              f"主对话只多了 1 条结果；服务端调用记录标为 subagent")

        before = len(jsonl(s.upstream))
        c9, o9 = s.ferry("-p", "RESUMETEST: ask a subagent, then ask it more")
        ups = jsonl(s.upstream)[before:]
        second = [u for u in ups if "<ferry_subagent>" in system_text(u) and "RESUMESECOND" in json.dumps(u["messages"][-1])]
        carried = bool(second) and "MARK-7Q2" in json.dumps(second[0]["messages"]) and "FIRST REPORT" in json.dumps(second[0]["messages"])
        check("F89 子 agent 接着问", c9 == 0 and "RESUMED: SECOND REPORT marker=True read=True first=True" in o9 and carried,
              "主对话先用 task 派子 agent 读文件写报告，再用 task 的 resume 追问同一个子 agent；第二次请求带着第一次的任务、"
              "读到的文件和报告，主对话拿到第二份报告" if c9 == 0 and carried else o9[-400:])

        logs = {p.name: p.read_text(encoding="utf-8") for p in (s.home / "subagents").glob("*/*.md")}
        first = next((t for n, t in logs.items() if "-explore-look-at-the-data-folder" in n), "")
        resumed = next((t for n, t in logs.items() if "-explore-first-look" in n), "")
        ok = ("List the data folder" in first and "### Tool call: ls" in first and "Result (ls)" in first
              and "## Report" in first and "EXPLORE REPORT" in first
              and resumed.count("## Task") == 2 and "RESUMESECOND" in resumed and "SECOND REPORT" in resumed)
        check("F91 子 agent 过程记录", ok, "子 agent 的整个过程写进 FERRY_HOME/subagents/日期/编号-agent-描述.md："
              "任务、工具调用和结果、报告都在；用 resume 追问时接着写在同一个文件里" if ok else f"{list(logs)} | {first[:300]}")

        c4, o4 = s.ferry("-p", "BIGTEST: print a long output")
        saved = list((s.home / "outputs").rglob("bash-*.txt"))
        lines = saved[0].read_text(encoding="utf-8").count("\n") if saved else 0
        size = re.search(r"size=(\d+)", o4)
        check("F30 长输出写文件", c4 == 0 and "saved=True" in o4 and "last=True" in o4 and size and int(size.group(1)) < 9000
              and lines >= 2999, f"3000 行输出全文存到客户端文件；模型只收到开头、结尾和路径，约 {size.group(1) if size else '?'} 字符")

        c4b, o4b = s.ferry("-p", "DENOISETEST: print colours and a progress bar")
        ok = c4b == 0 and "DENOISE: esc=False cr=False red=True bar=True old=False repeated=True same=1" in o4b
        check("F92 命令输出去噪", ok, "命令输出的颜色代码去掉了，\\r 重画的进度条只留最后一次，连续五行相同的只留一行加一句重复了几次"
              if ok else o4b[-400:])

        c5, o5 = s.ferry("-p", "TODOTEST: plan it")
        check("F31 任务清单", c5 == 0 and "[x] step one | [>] step two" in o5, "todo 工具记下两步，一步完成、一步进行中")

        ask = {"FERRY_AUTO_APPROVE": "0"}  # the stack auto-approves; these runs use the real permission check
        c6, o6 = s.ferry("-p", "PERMTEST: touch a file", env_extra=ask)
        blocked = c6 == 0 and "needs the user's approval" in o6 and not (work / "perm-ok.txt").exists()
        perm_file = s.home / "permissions.json"
        perm_file.write_text(json.dumps({"allow": ["bash(touch*)"]}), encoding="utf-8")
        c7, o7 = s.ferry("-p", "PERMTEST: touch a file", env_extra=ask)
        by_rule = c7 == 0 and "PERM: touched" in o7
        perm_file.unlink()
        (work / "perm-ok.txt").unlink(missing_ok=True)
        (s.home / "config.json").write_text(json.dumps({"permissionMode": "plan"}), encoding="utf-8")
        c8, o8 = s.ferry("-p", "PERMTEST: touch a file", env_extra=ask)
        planned = c8 == 0 and "Plan mode is on" in o8 and not (work / "perm-ok.txt").exists()
        (s.home / "config.json").write_text(json.dumps({"permissionMode": "bypass"}), encoding="utf-8")
        c9, o9 = s.ferry("-p", "PERMTEST: touch a file", env_extra=ask)
        (s.home / "config.json").unlink()
        check("F32 权限模式和规则", blocked and by_rule and planned and c9 == 0 and "PERM: touched" in o9,
              "没有终端时需要确认的命令被拦下；允许规则放行同类命令；只读规划模式拒绝改动；全部放行模式不问")

        ups = jsonl(s.upstream)
        sys0 = system_text(ups[-1]) if ups else ""
        check("F33 Ferry 自己的系统提示", "You are Ferry" in sys0 and "Pi documentation" not in sys0
              and "PI_" not in sys0 and "<environment>" in sys0 and "Today's date" in sys0,
              "不再提 pi 和它的文档，带上操作系统、shell、日期")

        cn = work.parent / "中文 项目"
        cn.mkdir(exist_ok=True)
        c10, o10 = s.ferry("-p", "TODOTEST: plan it", cwd=cn)
        projects = [a.get("project") for a in jsonl(s.data / "audit.jsonl") if a.get("event") == "chat"]
        check("F34 中文文件夹名", c10 == 0 and "[x] step one" in o10 and "中文 项目" in projects,
              "在名字含中文和空格的文件夹里运行正常，服务端记录的项目名正确")
    finally:
        s.close()


CLAUDE_TOML = ('\n[models.claude]\nbase_url = "http://127.0.0.1:9100"\napi = "anthropic"\napi_key_env = "DEEPSEEK_API_KEY"\n'
               'model = "claude-opus-5-5"\ncontext_window = 1000000\nmax_tokens = 64000\nvision = true\n'
               'price = { input = 4, output = 20, cache_read = 0.2, cache_write = 5 }\n\n[routing]\ndefault = "claude"\n')
PNG_1PX = __import__("base64").b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


def check_goal_todo(root: Path, work: Path) -> None:
    """/goal agrees on completion criteria (assumed without a terminal) and checks them; a stalled to-do list is noticed."""
    s = Stack(root, work, "agent")
    try:
        c1, o1 = s.ferry("-p", "/goal CRITTEST write crit-a.txt and crit-b.txt")
        made = (work / "crit-a.txt").exists() and (work / "crit-b.txt").exists()
        ok = c1 == 0 and made and "recorded=True continued=True" in o1
        check("F95 /goal 先定完成标准", ok, "没有终端（ferry -p）时，系统提示要 agent 先自己写下完成标准并注明是假设的；"
              "agent 用 goal_update 记下两条，之后每条继续消息都带着这两条" if ok else o1[-400:])
        ok = c1 == 0 and "rejected=True accepted=True" in o1
        check("F97 /goal 按标准验收", ok, "报告完成时只给了第 1 条标准的证据：被退回，说明第 2 条缺证据；"
              "补上每条的证据后才算完成" if ok else o1[-400:])
        c2, o2 = s.ferry("-p", "TODOSTALE: work without updating the list")
        ok = c2 == 0 and "STALE reminded after=12 item=True count=1" in o2
        check("F96 待办不动时提醒", ok, "待办清单有一项进行中，agent 连续调用 12 次工具都没更新清单：模型收到一条隐藏提醒，"
              "写明哪一项还标着进行中" if ok else o2[-400:])
    finally:
        s.close()
        for n in ("crit-a.txt", "crit-b.txt"):
            (work / n).unlink(missing_ok=True)


def check_memory_overwrite(root: Path, work: Path) -> None:
    """Saving a memory under an existing name does not silently replace it."""
    s = Stack(root, work, "agent")
    try:
        code, out = s.ferry("-p", "MEMTEST-OVERWRITE: save the database note three times")
        files = list((s.home / "memory" / "projects").glob("*/test-db.md"))
        final = files[0].read_text(encoding="utf-8") if files else ""
        ok = (code == 0 and "nothing was saved" in out and "Port 5433" in out and len(files) == 1
              and "mailer" in final and "Use mocks for everything" not in final)
        check("F78 记忆不会被同名覆盖", ok, "同名再存一条不同内容：旧内容原样保留并返回给 agent，让它合并后加 replace 再存；带 replace 才覆盖"
              if ok else f"code={code} files={len(files)} final={final!r} out={out[-300:]!r}")
    finally:
        s.close()


def check_memory_review(root: Path, work: Path) -> None:
    """A full memory index still shows a new memory; memories proposed from the previous conversation; /memory tidy."""
    s = Stack(root, work, "agent")
    try:
        c1, _ = s.ferry("-p", "MEMTEST-SAVE: remember that tests use the real database")
        folder = next((p for p in (s.home / "memory" / "projects").glob("*") if p.is_dir()), None)
        index = folder / "MEMORY.md" if folder else root / "missing"
        if folder:  # an index that filled up the old way (new lines at the end) before this memory was saved
            index.write_text("".join(f"- [old-{i}](old-{i}.md): an old note {i}\n" for i in range(210)), encoding="utf-8")
            (folder / "test-db.md").unlink()
        c2, o2 = s.ferry("-p", "MEMTEST-SAVE: remember that tests use the real database")
        c3, o3 = s.ferry("-p", "MEMTEST-RECALL: what do you remember?")
        sys3 = system_text(jsonl(s.upstream)[-1])
        saved = (folder / "test-db.md").read_text(encoding="utf-8") if folder and (folder / "test-db.md").exists() else ""
        ok = (c1 == 0 and c2 == 0 and "Saved project memory" in o2 and c3 == 0 and "INDEX HAS test-db" in o3
              and "This index is nearly full: 211 lines" in sys3 and index.read_text(encoding="utf-8").startswith("- [test-db]")
              and re.match(r"---\nupdated: \d{4}-\d{2}-\d{2}\n---\nIntegration tests", saved) is not None)
        check("F105 记忆目录满了也看得到新记忆", ok, "目录已有 210 行时再存一条：新的一行放在最前面，下一次对话的系统提示里看得到它；"
              "目录超过八成时提示里让模型合并记忆；记忆文件开头记着更新日期" if ok
              else f"c={c1},{c2},{c3} o3={o3[-200:]!r} full={'nearly full' in sys3} saved={saved[:80]!r}")
        if WINDOWS:
            print("  SKIP  F106 记忆候选、F107 /memory tidy（Windows 上没有伪终端，Linux 上检查）")
            return
        import pty
        import select

        s.ferry("-p", "MEMSEED: always use pnpm here, never npm")
        s.ferry("-c", "-p", "MEMSEED: now run the build")
        s.ferry("-c", "-p", "MEMSEED: thanks")
        lines = index.read_text(encoding="utf-8")
        (folder / "tidy-a.md").write_text("Reports are Word files.\n", encoding="utf-8")
        (folder / "tidy-b.md").write_text("Reports keep tracked changes on.\n", encoding="utf-8")
        (folder / "tidy-pinned.md").write_text("---\npinned: true\n---\nThe owner signs every report.\n", encoding="utf-8")
        index.write_text("- [tidy-a](tidy-a.md): report files\n- [tidy-b](tidy-b.md): tracked changes\n"
                         f"- [tidy-pinned](tidy-pinned.md): who signs\n{lines}", encoding="utf-8")
        seen = b""
        env = {**s.env, "FERRY_SERVER": s.base, "FERRY_TOKEN": TOKEN, "TERM": "xterm-256color", "COLUMNS": "140", "LINES": "40",
               "FERRY_AUTO_APPROVE": "1"}
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(work)
            os.execvpe(NODE, [NODE, str(ROOT / "client" / "bin" / "ferry.mjs")], env)
        plain = lambda b: re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-B]|[\r]", "",  # noqa: E731
                                 b.decode("utf-8", "replace"))

        def wait_for(text: str, secs: float, since: int = 0) -> bool:
            nonlocal seen
            end = time.time() + secs
            while time.time() < end:
                r, _, _ = select.select([fd], [], [], 0.2)
                if r:
                    try:
                        seen += os.read(fd, 65536)
                    except OSError:
                        return False
                if text in plain(seen[since:]):
                    return True
            return False

        started = wait_for("shift+tab", 60)
        asked = wait_for('New project memory "uses-pnpm"', 40) and "you said: always use pnpm here" in plain(seen)
        time.sleep(0.3)
        mark = len(seen)
        os.write(fd, b"\r")  # Save
        told = wait_for("Saved 1 memory from your last conversation", 15, mark)
        pnpm = (folder / "uses-pnpm.md").read_text(encoding="utf-8") if (folder / "uses-pnpm.md").exists() else ""
        reviewed = s.home / "memory" / "reviewed.json"
        looked = list(json.loads(reviewed.read_text(encoding="utf-8")).values()) if reviewed.exists() else []
        ok106 = started and asked and told and "updated: " in pnpm and "How to apply:" in pnpm and looked == [3]
        check("F106 从上次对话提议记忆", ok106, "上次对话里说过三句以上的话：这次一打开，服务端的摘要模型读了上次对话（只发精简的文字稿），"
              "提出一条记忆，终端里问要不要记；选 Save 才写进项目记忆；这段对话记为已看过，下次不再问" if ok106
              else f"started={started} asked={asked} told={told} pnpm={pnpm[:80]!r} looked={looked} {plain(seen)[-500:]!r}")

        mark = len(seen)
        os.write(fd, b"/memory tidy")
        time.sleep(0.4)
        os.write(fd, b"\r")
        shown = wait_for('Merge project memories "tidy-a" + "tidy-b" into "tidy-ab"', 40, mark)
        time.sleep(0.3)
        mark = len(seen)
        os.write(fd, b"\r")  # Apply
        applied = wait_for("Tidy: applied 1 of 1 change", 15, mark)
        merged = (folder / "tidy-ab.md").read_text(encoding="utf-8") if (folder / "tidy-ab.md").exists() else ""
        ok107 = (shown and applied and "tracked changes on" in merged and not (folder / "tidy-a.md").exists()
                 and not (folder / "tidy-b.md").exists() and (folder / "tidy-pinned.md").exists()
                 and "[tidy-ab](tidy-ab.md)" in index.read_text(encoding="utf-8") and "[tidy-a](" not in index.read_text(encoding="utf-8"))
        check("F107 /memory tidy", ok107, "/memory tidy 把记忆发给服务端，模型提出合并两条、删一条固定的；固定的那条不会出现，"
              "合并那条问过、选 Apply 后两条变成一条，目录跟着改" if ok107
              else f"shown={shown} applied={applied} merged={merged[:80]!r} {plain(seen)[-500:]!r}")
        # keep reading while ferry quits: on macOS a full terminal buffer blocks its writes, and then it never exits
        for _ in range(2):
            os.write(fd, b"\x03")
            wait_for("\0", 0.3)
        try:
            os.kill(pid, signal.SIGTERM)
            for _ in range(50):
                if os.waitpid(pid, os.WNOHANG)[0]:
                    break
                wait_for("\0", 0.1)
            else:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
    finally:
        s.close()


def check_memory_distill(root: Path, work: Path) -> None:
    """/memory distill: a card per past conversation, one proposal applied after you confirm; -p only prints; the notice."""
    s = Stack(root, work, "agent")
    try:
        s.ferry("-p", "DISTSEED: always give the file path first")
        s.ferry("-c", "-p", "DISTSEED: next step")
        s.ferry("-p", "DISTSEED: please give the file path first next time")
        s.ferry("-c", "-p", "DISTSEED: thanks")
        user = s.home / "memory" / "user"
        user.mkdir(parents=True, exist_ok=True)
        style = user / "answer-style.md"
        style.write_text("---\nupdated: 2026-10-01\n---\nShort answers.\n", encoding="utf-8")
        (user / "MEMORY.md").write_text("- [answer-style](answer-style.md): how to answer\n", encoding="utf-8")
        reports = s.home / "memory" / "distill"
        asks = lambda phrase: sum(phrase in json.dumps(b) for b in jsonl(s.upstream))  # noqa: E731
        c1, o1 = s.ferry("-p", "/memory distill")
        ok110 = (c1 == 0 and 'Update memory "answer-style"' in o1 and "Evidence (2 conversations)" in o1 and "needs 3" in o1
                 and "Nothing was changed" in o1 and asks("Write a short card about it") == 2 and asks("Find what keeps coming up") == 1
                 and style.read_text(encoding="utf-8").endswith("Short answers.\n") and not list(reports.glob("*.md"))
                 and not (s.home / "AGENTS.md").exists())
        check("F110 /memory distill 没有终端时只列出来", ok110, "ferry -p 里 /memory distill：两段旧对话各写一张卡片（摘要模型两次），"
              "当前模型看卡片提一条记忆更新和一条规则；规则只有两段对话做证据，Ferry 自己丢掉；只打印出来，记忆、AGENTS.md、报告都不动"
              if ok110 else f"c={c1} cards={asks('Write a short card about it')} style={style.read_text(encoding='utf-8')!r} {o1[-600:]!r}")
        if WINDOWS:
            print("  SKIP  F108 /memory distill、F109 开对话时提醒（Windows 上没有伪终端，Linux 上检查）")
            return
        import pty
        import select

        fake = s.home / "agent" / "sessions" / "--elsewhere--"
        fake.mkdir(parents=True, exist_ok=True)
        for i in range(10):  # conversations elsewhere, too short for a card; they still count for the notice
            (fake / f"fake-{i}.jsonl").write_text(json.dumps({"type": "session", "version": 3, "id": f"fake-{i}", "cwd": "/elsewhere",
                                                              "timestamp": "2026-11-01T00:00:00Z"}) + "\n", encoding="utf-8")
        reports.mkdir(parents=True, exist_ok=True)
        (reports / "state.json").write_text(json.dumps({"last": (time.time() - 8 * 86400) * 1000}), encoding="utf-8")
        seen = b""
        env = {**s.env, "FERRY_SERVER": s.base, "FERRY_TOKEN": TOKEN, "TERM": "xterm-256color", "COLUMNS": "140", "LINES": "40",
               "FERRY_AUTO_APPROVE": "1"}
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(work)
            os.execvpe(NODE, [NODE, str(ROOT / "client" / "bin" / "ferry.mjs")], env)
        plain = lambda b: re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-B]|[\r]", "",  # noqa: E731
                                 b.decode("utf-8", "replace"))

        def wait_for(text: str, secs: float, since: int = 0) -> bool:
            nonlocal seen
            end = time.time() + secs
            while time.time() < end:
                r, _, _ = select.select([fd], [], [], 0.2)
                if r:
                    try:
                        seen += os.read(fd, 65536)
                    except OSError:
                        return False
                if text in plain(seen[since:]):
                    return True
            return False

        try:
            started = wait_for("shift+tab", 60)
            noticed = wait_for("conversations since the last distill (8 days)", 20) and "/memory distill looks for" in plain(seen)
            time.sleep(1)
            ok109 = started and noticed and asks("Write a short card about it") == 2 and asks("Find what keeps coming up") == 1
            check("F109 开对话时提醒 /memory distill", ok109, "上次 distill 过了 8 天、之后有 10 段以上新对话：打开 ferry 时提示一行，"
                  "建议运行 /memory distill；不会自己跑（没有多出模型调用）" if ok109
                  else f"started={started} noticed={noticed} {plain(seen)[-500:]!r}")

            mark = len(seen)
            os.write(fd, b"/memory distill")
            time.sleep(0.4)
            os.write(fd, b"\r")
            shown = wait_for("Distill (1 of 1)", 60, mark) and wait_for('Update memory "answer-style"', 5, mark)
            time.sleep(0.3)
            mark = len(seen)
            os.write(fd, b"\r")  # Apply
            applied = wait_for("Distill: applied 1 of 1", 15, mark)
            now = style.read_text(encoding="utf-8")
            report = "".join(p.read_text(encoding="utf-8") for p in reports.glob("*.md"))
            ok108 = (shown and applied and "Give the file path first." in now and "Old content:" in report and "Short answers.\n~~~~" in report
                     and '"path-rule": evidence from 2 conversations, needs 3' in report
                     and asks("Write a short card about it") == 2 and asks("Find what keeps coming up") == 2)
            check("F108 /memory distill", ok108, "终端里 /memory distill：卡片没变就复用（不再调摘要模型），当前模型提一条记忆更新，"
                  "带两段对话的原话做证据；选 Apply 后写进记忆；报告里有改之前的内容和被丢掉的那条规则" if ok108
                  else f"shown={shown} applied={applied} now={now!r} report={report[-400:]!r} {plain(seen)[-500:]!r}")
        finally:
            for _ in range(2):  # keep reading while ferry quits, or a full terminal buffer blocks it
                os.write(fd, b"\x03")
                wait_for("\0", 0.3)
            try:
                os.kill(pid, signal.SIGTERM)
                for _ in range(50):
                    if os.waitpid(pid, os.WNOHANG)[0]:
                        break
                    wait_for("\0", 0.1)
                else:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass
    finally:
        s.close()


def check_claude_goal_jobs(root: Path, work: Path) -> None:
    """Claude through the Anthropic Messages API (sync, prompt-cache markers, pictures, cost), /goal, background jobs."""
    (work / "pic.png").write_bytes(PNG_1PX)
    s = Stack(root, work, "agent", extra_toml=CLAUDE_TOML)
    try:
        c1, o1 = s.ferry("-p", "TASKTEST: explore the data folder")
        c2, o2 = s.ferry("-p", "IMGTEST: look at pic.png")
        c3, _ = s.ferry("doctor")
        ups = jsonl(s.upstream)
        audit = jsonl(s.data / "audit.jsonl")
        chats = [a for a in audit if a.get("event") == "chat"]
        commits = [a for a in audit if a.get("event") == "commit"]
        agent_calls = [u for u in ups if "Reply with OK" not in json.dumps(u)]
        valid = agent_calls and all(str(u.get("model", "")).startswith("claude-") and isinstance(u.get("system"), list) for u in agent_calls)
        thinks = agent_calls and all((u.get("thinking") or {}).get("type") == "adaptive" for u in agent_calls)
        check("F40 Claude 原生接口", c1 == 0 and "EXPLORE REPORT" in o1 and c2 == 0 and "IMG: picture received" in o2 and c3 == 0
              and valid and thinks and any((a.get("base") or 0) > 0 for a in commits)
              and all(a.get("status") == 200 and (a.get("cost") or 0) > 0 and a["tokens"]["cache_read"] > 0 for a in chats),
              "主 agent 和子 agent 都经 Anthropic Messages API，并打开思考；对话仍然增量同步（缓存标记不打乱同步）；"
              "图片文件交给模型；每次调用都算出缓存命中和费用；doctor 能测 Claude 模型")
        c4, o4 = s.ferry("-p", "/goal GOALTEST write three notes")
        notes = sorted(p.name for p in work.glob("goal-note*.txt"))
        cont = sum(1 for u in jsonl(s.upstream)[-1:] for m in u.get("messages", []) if "Continue working toward the goal" in json.dumps(m))
        check("F41 /goal 长任务", c4 == 0 and "GOAL REPORT" in o4 and notes == ["goal-note1.txt", "goal-note2.txt", "goal-note3.txt"]
              and cont == 3, "设定目标后 agent 每停一次就被催着继续（3 次），直到它用 goal_update 报告完成并给出证据")
        c5, o5 = s.ferry("-p", "JOBTEST: start a background job")
        check("F42 后台任务", c5 == 0 and "ticker-done" in o5 and "command done" in o5,
              "job_start 在后台跑命令并立即返回；job_output 看到它的输出和结束状态")
    finally:
        s.close()
        for p in work.glob("goal-note*.txt"):
            p.unlink()
        (work / "pic.png").unlink(missing_ok=True)


def check_diy(root: Path) -> None:
    """Your own slash commands (yours and the project's), skills, hooks and /memory <text>."""
    proj = root.parent / "diy-project"
    (proj / ".ferry" / "commands").mkdir(parents=True, exist_ok=True)
    (proj / ".ferry" / "commands" / "hello.md").write_text("---\ndescription: greet someone\n---\nDIYCMD greet $1\n", encoding="utf-8")
    (proj / ".ferry" / "skills" / "demo-skill").mkdir(parents=True, exist_ok=True)
    (proj / ".ferry" / "skills" / "demo-skill" / "SKILL.md").write_text(
        "---\nname: demo-skill\ndescription: Shows that project skills are offered to the model.\n---\nSay hi.\n", encoding="utf-8")
    s = Stack(root, proj, "agent")
    try:
        (s.home / "commands").mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / "examples" / "commands" / "review.md", s.home / "commands" / "review.md")
        (s.home / "AGENTS.md").write_text("- HOME-RULE-42: always answer politely.\n", encoding="utf-8")
        c1, o1 = s.ferry("-p", "/hello Wesley")
        before = len(jsonl(s.upstream))
        c2, _ = s.ferry("-p", "/review src/api")
        review = [m for m in jsonl(s.upstream)[before]["messages"] if m.get("role") == "user"] if len(jsonl(s.upstream)) > before else []
        review_ok = c2 == 0 and review and "Review src/api" in str(review[-1]) and "Report each finding" in str(review[-1])
        skill_ok = "demo-skill" in system_text(jsonl(s.upstream)[-1]) and "HOME-RULE-42" in system_text(jsonl(s.upstream)[-1])
        scaffold_ok = all((s.home / d).is_dir() for d in ("skills", "commands", "agents")) and (s.home / "README.md").exists()
        s.home.mkdir(parents=True, exist_ok=True)
        (s.home / "hooks.json").write_text(json.dumps({"afterEdit": [
            {"match": "**/*.txt", "run": "echo HOOKRAN $FERRY_FILE_REL && exit 3"}]}), encoding="utf-8")
        c3, o3 = s.ferry("-p", "EDITTEST: write a file")
        c4, o4 = s.ferry("-p", "/memory integration tests use port 9999")
        mem = list((s.home / "memory" / "projects").glob("*/*.md"))
        c5, o5 = s.ferry("-p", "PASTTEST: what did I ask in my other conversation?")
        check("F46 读以前的对话", c5 == 0 and "PAST: found greet Wesley" in o5,
              "agent 用 past_conversations 搜到另一个对话并读出里面的内容" if c5 == 0 and "PAST: found" in o5 else o5[-300:])
        check("F39 斜杠命令和自定义", c1 == 0 and "DIY: Wesley" in o1 and review_ok and skill_ok and scaffold_ok
              and c3 == 0 and "HOOKRAN made-by-agent.txt" in o3 and "exit code 3" in o3
              and c4 == 0 and any("port 9999" in m.read_text(encoding="utf-8") for m in mem),
              "项目里自己写的 /hello 命令能用；放在自己目录里的 /review 展开成审查要求；项目技能和自己目录的 AGENTS.md 出现在系统提示里；"
              "改文件后钩子运行、失败输出交给模型；/memory 加一句话直接存进记忆")
    finally:
        s.close()


def check_resume_upload(root: Path, work: Path) -> None:
    """After a restart (ferry -c), only what the server does not have yet is uploaded again."""
    (work / "big-notes.txt").write_text("".join(f"line {i:05d} of the long notes file\n" for i in range(1500)), encoding="utf-8")
    s = Stack(root, work, "agent")
    try:
        c1, o1 = s.ferry("-p", "READBIG: read big-notes.txt")
        first = sum(a.get("upload_bytes", 0) for a in jsonl(s.data / "audit.jsonl") if a.get("event") == "commit")
        n = len(jsonl(s.data / "audit.jsonl"))
        c2, o2 = s.ferry("-c", "-p", "and now a short question")
        second = sum(a.get("upload_bytes", 0) for a in jsonl(s.data / "audit.jsonl")[n:] if a.get("event") == "commit")
        c3, o3 = s.ferry("doctor", "--upload")
        ok = (c1 == 0 and "READ" in o1 and c2 == 0 and first > 40000 and second < first * 0.3
              and c3 == 0 and "900 KB gets through" in o3)
        check("F47 接着以前的对话只传新内容", ok, f"第一次上传 {first:,} 字节；重开 ferry 接着这个对话，只上传 {second:,} 字节"
              "（服务端还有的消息只发引用）；doctor --upload 测出多大的上传能通过" if ok
              else f"c1={c1} c2={c2} c3={c3} first={first} second={second} | {o1[-200:]} | {o2[-200:]} | {o3[-300:]}")
    finally:
        s.close()
        (work / "big-notes.txt").unlink(missing_ok=True)


def check_v016(root: Path, work: Path) -> None:
    """Old tool outputs left out, task_batch, Office files, auto mode, phone notifications."""
    (work / "big-notes.txt").write_text("".join(f"line {i:05d} of the long notes file\n" for i in range(400)), encoding="utf-8")
    s = Stack(root, work, "agent", server_env={"FERRY_BARK_URL": "http://127.0.0.1:9100/bark"})
    try:
        s.home.mkdir(parents=True, exist_ok=True)
        cfgf = s.home / "config.json"
        cfgf.write_text(json.dumps({"trimOldOutputs": "2k", "maxParallel": 2}), encoding="utf-8")
        c1, o1 = s.ferry("-p", "TRIMTEST: read the notes again and again")
        last = jsonl(s.upstream)[-1]
        stubs = sum("was left out to keep the context small" in json.dumps(m) for m in last.get("messages", []))
        ok = c1 == 0 and stubs >= 1 and "TRIM:" in o1
        check("F48 旧的工具输出自动省略", ok, f"上下文超过设定值后，旧的长工具输出换成一行说明（这次省略 {stubs} 段），最近的保留"
              if ok else f"c={c1} stubs={stubs} {o1[-300:]}")
        c2, o2 = s.ferry("-p", "BATCHTEST: check the four items")
        files = sorted((s.home / "batches").glob("*.md"))
        report = files[-1].read_text(encoding="utf-8") if files else ""
        ok = c2 == 0 and "4 of 4 done" in o2 and all(f"ITEM {x} ok" in report for x in ("alpha", "beta", "gamma", "delta"))
        check("F49 批量派活", ok, "task_batch 给 4 个条目各派一个子 agent（最多 2 个同时跑），报告汇总到一个文件" if ok else f"{o2[-300:]} | {report[:200]}")
        c3, o3 = s.ferry("-p", "OFFICETEST: make a change request")
        ok = c3 == 0 and "{-every 10 s-}{+every 20 s+}" in o3 and (work / "cr.docx").exists()
        check("F50 Office 文件", ok, "agent 新建 Word、按修订方式改、再读出修订痕迹" if ok else o3[-300:])
        cfgf.write_text(json.dumps({}), encoding="utf-8")
        c6, o6 = s.ferry("-p", "/goal GOALTEST write three notes")
        barks = [u for u in jsonl(s.upstream) if "group" in u and u.get("group") == "Ferry"]
        ok = c6 == 0 and any("Goal achieved" in b.get("body", "") for b in barks)
        check("F52 手机通知", ok, "目标完成后，服务端给 Bark 推了一条（只有一句话，没有对话内容）" if ok else f"{barks} | {o6[-200:]}")
    finally:
        s.close()
        for n in ("big-notes.txt", "cr.docx", "auto-made.txt"):
            (work / n).unlink(missing_ok=True)
        for p in work.glob("goal-note*.txt"):
            p.unlink()


def check_compact_mid_run(root: Path, work: Path) -> None:
    """The context is summarised in the middle of one long request, at compactLimit or compactAt, not after it."""
    (work / "big-notes.txt").write_text("".join(f"line {i:05d} of the long notes file\n" for i in range(400)), encoding="utf-8")

    bases: list[int] = []  # base of each upload after the summary: the note must not make the client send everything again

    def run(setting: dict) -> tuple[int, str, list[dict]]:
        s = Stack(root / ("at" if "compactAt" in setting else "limit"), work, "agent")
        try:
            s.home.mkdir(parents=True, exist_ok=True)
            (s.home / "config.json").write_text(json.dumps(setting), encoding="utf-8")
            code, out = s.ferry("-p", "MIDCOMPACT: read the notes again and again")
            audit = jsonl(s.data / "audit.jsonl")
            at = next((i for i, a in enumerate(audit) if a.get("purpose") == "summary"), len(audit))
            bases.clear()
            bases.extend(a.get("base") or 0 for a in audit[at:] if a.get("event") == "commit")
            return code, out, jsonl(s.upstream)
        finally:
            s.close()

    def is_summary(u: dict) -> bool:
        return "context summarization assistant" in json.dumps(u.get("messages", [])[:1])

    def verdict(setting: dict) -> tuple[bool, str]:
        code, out, ups = run(setting)
        kinds = ["summary" if is_summary(u) else "agent" for u in ups]
        first = kinds.index("summary") if "summary" in kinds else -1
        asked = json.dumps(ups[first].get("messages", [])[:1]) if first >= 0 else ""
        ok = (code == 0 and "finished after the summary" in out and 0 < first and "agent" in kinds[first + 1:]
              and "confidentiality" in asked and bases and len(bases) >= 2 and bases[-1] > 0
              and "mid-out.txt" in json.dumps(ups[-1]) and "just summarised" in json.dumps(ups[-1]))
        return ok, (f"同一次请求做到一半，上下文到线就先写摘要（第 {first + 1} 个请求），摘要请求带着\"保留用户原话、保密要求、下一步\"的要求，"
                    "摘要后接着做完，摘要后再走一步，上传仍是增量（base 大于 0）" if ok else f"code={code} kinds={kinds} bases={bases} | {out[-300:]}")

    ok, detail = verdict({"compactLimit": "20k", "compactKeep": "2k"})
    check("F81 长任务中途按 token 数压缩", ok, "compactLimit 20k：" + detail)
    ok, detail = verdict({"compactAt": "15%", "compactLimit": "0", "compactKeep": "2k"})
    check("F82 长任务中途按百分比压缩", ok, "compactAt 15%：" + detail)
    (work / "big-notes.txt").unlink(missing_ok=True)


def check_context_and_mcp(root: Path, work: Path) -> None:
    """/context changes the context size for the model; ferry mcp imports and lists servers."""
    s = Stack(root, work, "agent")
    try:
        c0, o0 = s.ferry("-p", "/context 400k")  # the server allows 128k for this model
        c1, o1 = s.ferry("-p", "/context 64k")
        saved = json.loads((s.home / "config.json").read_text(encoding="utf-8")).get("contextWindow", {})
        c2, o2 = s.ferry("-p", "/context")
        c3, o3 = s.ferry("-p", "/context auto")
        back = json.loads((s.home / "config.json").read_text(encoding="utf-8")).get("contextWindow", {})
        ok = ("at most 128.0k" in o0 and c1 == 0 and saved == {"auto": 64000} and c2 == 0 and "of 64.0k tokens" in o2
              and c3 == 0 and back == {})
        check("F43 调整上下文长度", ok, "/context 64k 改当前模型的上下文长度并保存，之后的会话按 64k 计算；超过服务端允许的 400k 被拒绝；"
              "/context auto 回到服务端的设置" if ok else f"saved={saved} back={back} | {o0[-200:]} | {o1[-300:]} | {o2[-300:]}")
        other = root / "claude_desktop_config.json"
        other.write_text(json.dumps({"mcpServers": {"notes": {"command": "node", "args": ["notes-server.js"]},
                                                    "old-sse": {"type": "sse", "url": "https://example.com/sse"}}}), encoding="utf-8")
        (work / ".mcp.json").write_text(json.dumps({"mcpServers": {"team-db": {"url": "https://mcp.example.com/db"}}}), encoding="utf-8")
        c4, o4 = s.ferry("mcp", "import", str(other))
        c5, o5 = s.ferry("mcp", "list")
        mine = json.loads((s.home / "agent" / "mcp.json").read_text(encoding="utf-8"))["mcpServers"]
        ok = (c4 == 0 and "added    notes" in o4 and "skipped  old-sse" in o4 and list(mine) == ["notes"]
              and c5 == 0 and "notes" in o5 and "team-db" in o5 and "This project" in o5)
        check("F44 MCP 导入和查看", ok, "ferry mcp import 从别的应用的配置文件导入（不支持的 SSE 说明原因跳过）；"
              "ferry mcp list 列出自己的和项目的服务器" if ok else f"{o4[-300:]} | {o5[-300:]}")
    finally:
        s.close()
        (work / ".mcp.json").unlink(missing_ok=True)


def check_project_mcp(root: Path) -> None:
    """A project's .ferry/mcp.json: Ferry asks once, then the agent can use the server's tools."""
    if WINDOWS:
        print("  SKIP  F45 项目自带的 MCP（Windows 上没有伪终端，Linux 上检查）")
        return
    import pty
    import select

    proj = root.parent / "mcp-project"
    (proj / ".ferry").mkdir(parents=True, exist_ok=True)
    (proj / ".ferry" / "mcp.json").write_text(json.dumps({"mcpServers": {"notes": {
        "command": NODE, "args": [str(ROOT / "selftest" / "fake_mcp.mjs")], "exposure": "direct"}}}), encoding="utf-8")
    s = Stack(root, proj, "agent")
    seen = b""
    try:
        env = {**s.env, "FERRY_SERVER": s.base, "FERRY_TOKEN": TOKEN, "TERM": "xterm-256color", "COLUMNS": "120", "LINES": "40"}
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(proj)
            os.execvpe(NODE, [NODE, str(ROOT / "client" / "bin" / "ferry.mjs")], env)
        plain = lambda b: re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-B]|[\r]", "",  # noqa: E731
                                 b.decode("utf-8", "replace"))

        def wait_for(text: str, secs: float) -> bool:
            nonlocal seen
            end = time.time() + secs
            while time.time() < end:
                r, _, _ = select.select([fd], [], [], 0.3)
                if r:
                    try:
                        seen += os.read(fd, 65536)
                    except OSError:
                        return False
                if text in plain(seen):
                    return True
            return False

        asked = wait_for("This project brings MCP servers", 60)
        time.sleep(0.3)
        os.write(fd, b"\r")
        time.sleep(2)
        os.write(fd, b"MCPTEST: look up the build note")
        time.sleep(0.5)
        os.write(fd, b"\r")
        used = wait_for("MCP: NOTE[build]: the build runs on port 7070", 60)
        remembered = "mcp-trust.json" in str(list(s.home.rglob("mcp-trust.json")))
        for _ in range(2):
            os.write(fd, b"\x03")
            time.sleep(0.3)
        time.sleep(1)
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
        ok = asked and used and remembered
        check("F45 项目自带的 MCP", ok, "项目 .ferry/mcp.json 里的服务器先问一次，同意后 agent 能调用它的工具，答复记住"
              if ok else f"asked={asked} used={used} remembered={remembered}: {plain(seen)[-400:]!r}")
    finally:
        s.close()


def check_tui(root: Path, work: Path) -> None:
    """The interactive terminal UI starts, takes a message, shows the answer and the task list (Linux and macOS)."""
    if WINDOWS:
        print("  SKIP  F38 交互界面（Windows 上没有伪终端，Linux 上检查）")
        return
    import pty
    import select

    s = Stack(root, work, "agent")
    seen = b""
    try:
        env = {**s.env, "FERRY_SERVER": s.base, "FERRY_TOKEN": TOKEN, "TERM": "xterm-256color", "COLUMNS": "120", "LINES": "40",
               "FERRY_AUTO_APPROVE": "1"}
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(work)
            os.execvpe(NODE, [NODE, str(ROOT / "client" / "bin" / "ferry.mjs")], env)
        plain = lambda b: re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-B]|[\r]", "",  # noqa: E731
                                 b.decode("utf-8", "replace"))

        def wait_for(text: str, secs: float) -> bool:
            nonlocal seen
            end = time.time() + secs
            while time.time() < end:
                r, _, _ = select.select([fd], [], [], 0.3)
                if r:
                    try:
                        seen += os.read(fd, 65536)
                    except OSError:
                        return False
                if text in plain(seen):
                    return True
            return False

        started = wait_for("Ferry v", 60) and wait_for("shift+tab", 20)
        os.write(fd, b"TODOTEST from the terminal")
        time.sleep(0.5)
        os.write(fd, b"\r")
        answered = wait_for("TODO: [x] step one", 60)
        widget = "To-do (1/2 done)" in plain(seen)
        os.write(fd, b"/cost")
        time.sleep(0.5)
        os.write(fd, b"\r")
        cost_shown = wait_for("Model calls:", 20)
        mark = len(seen)
        os.write(fd, b"?")
        time.sleep(0.5)
        os.write(fd, b"\r")
        help_shown = wait_for("Ferry commands", 20) and "Ferry commands" in plain(seen[mark:])
        os.write(fd, b"/tasks")
        time.sleep(0.5)
        os.write(fd, b"\r")
        tasks_shown = wait_for("To-do list:", 15)

        def typed(text: bytes, then: bytes = b"\r") -> None:
            os.write(fd, text)
            time.sleep(0.5)
            if then:
                os.write(fd, then)

        # a short "/" list: Ferry's commands are there, pi's hidden ones are not
        typed(b"/rew", b"")
        listed = wait_for("Go back to one of your messages", 10)
        typed(b"\x7f\x7f\x7f\x7f", b"")
        mark = len(seen)
        typed(b"/scoped", b"")
        time.sleep(1.5)
        hidden = "Enable/disable models" not in plain(seen[mark:])
        typed(b"\x7f" * 7, b"")
        # /context changes the size right away
        typed(b"/context 100k")
        resized = wait_for("Context size for auto: 100.0k", 15)
        mark = len(seen)
        typed(b"/context")
        shows = wait_for("of 100.0k tokens", 15) and wait_for("Keep 100.0k", 5)
        os.write(fd, b"\x1b")  # close the size picker
        time.sleep(0.5)
        # /rewind: back to before the message, which goes into the input box again
        typed(b"/rewind")
        asked = wait_for("Go back to just before which message?", 15)
        os.write(fd, b"\r")
        rewound = wait_for("Back to before that message", 15)
        time.sleep(0.5)
        os.write(fd, b"\x03")  # clear the input box (the message put back there)
        time.sleep(1.5)
        # files too: the agent writes a file, /rewind takes the conversation and the file back
        made = work / "made-by-agent.txt"
        typed(b"EDITTEST: write a file")
        wrote = wait_for("EDIT: ", 60) and made.exists()
        typed(b"/rewind")
        wait_for("file changed since]", 15)
        os.write(fd, b"\r")
        wait_for("Conversation and files", 15)
        time.sleep(0.3)
        os.write(fd, b"\r")
        files_back = wait_for("Files put back", 15) and not made.exists()
        time.sleep(1.5)
        os.write(fd, b"\x03")
        time.sleep(0.5)
        # a background command that ends after the agent has finished: the agent takes it up by itself
        typed(b"WAKETEST: start a background command")
        waited = wait_for("WAKE: waiting for the napper", 60)
        woken = wait_for("WOKEN: ended=True out=True", 30)
        time.sleep(1.5)
        os.write(fd, b"\x03")
        time.sleep(0.3)
        os.write(fd, b"\x03")
        resume = wait_for("ferry --session", 10) and "pi --session" not in plain(seen) and "Press Ctrl+C again to quit" in plain(seen)
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
        ok = (started and answered and widget and cost_shown and help_shown and tasks_shown and listed and hidden and resized and shows and asked
              and rewound and wrote and files_back and resume)
        check("F38 交互界面", ok, "终端界面能启动、显示权限模式、收发消息、显示待办清单；/cost、? (帮助)、/tasks 能用；斜杠列表只有保留的命令；"
              "/context 100k 立即生效，/context 列出可选的大小；/rewind 回到某条消息之前，对话和 agent 改过的文件一起退回；退出时提示 ferry --session" if ok
              else f"started={started} answered={answered} widget={widget} cost={cost_shown} help={help_shown} tasks={tasks_shown} listed={listed} "
                   f"hidden={hidden} resized={resized} shows={shows} asked={asked} rewound={rewound} wrote={wrote} files_back={files_back} "
                   f"resume={resume}: "
                   f"{plain(seen)[-400:]!r}")
        check("F86 后台任务做完自动接着干", waited and woken,
              "agent 回完话停下以后后台命令才结束：agent 自己接着开一轮，拿到命令的结果和输出，不用再发消息" if waited and woken
              else f"waited={waited} woken={woken}: {plain(seen)[-400:]!r}")
    finally:
        s.close()
        (work / "made-by-agent.txt").unlink(missing_ok=True)


def check_steer(root: Path, work: Path) -> None:
    """Talking to the agent while it works: Enter queues, Enter again on an empty line interrupts now."""
    if WINDOWS:
        print("  SKIP  F53 工作中插话（Windows 上没有伪终端，Linux 上检查）")
        return
    import pty
    import select

    s = Stack(root, work, "agent")
    seen = b""
    try:
        env = {**s.env, "FERRY_SERVER": s.base, "FERRY_TOKEN": TOKEN, "TERM": "xterm-256color", "COLUMNS": "140", "LINES": "40",
               "FERRY_AUTO_APPROVE": "1"}
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(work)
            os.execvpe(NODE, [NODE, str(ROOT / "client" / "bin" / "ferry.mjs")], env)
        plain = lambda b: re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-B]|[\r]", "",  # noqa: E731
                                 b.decode("utf-8", "replace"))

        def wait_for(text: str, secs: float, since: int = 0) -> bool:
            nonlocal seen
            end = time.time() + secs
            while time.time() < end:
                r, _, _ = select.select([fd], [], [], 0.2)
                if r:
                    try:
                        seen += os.read(fd, 65536)
                    except OSError:
                        return False
                if text in plain(seen[since:]):
                    return True
            return False

        def typed(text: bytes) -> None:
            os.write(fd, text)
            time.sleep(0.4)
            os.write(fd, b"\r")

        wrong = work / "steer-wrong.txt"
        wrong.unlink(missing_ok=True)
        started = wait_for("shift+tab", 60)
        # 1. a command is running: the interruption waits for it, then the agent gets the message and the note
        typed(b"STEERTEST: run the slow command")
        wait_for("sleep 3", 20)
        typed(b"TURN LEFT instead")
        hinted = wait_for("Enter on an empty line to interrupt now", 10)
        os.write(fd, b"\r")
        waiting = wait_for("Interrupting (waits 3 s for the running command, then stops it): TURN LEFT", 10)
        mark = len(seen)
        first = wait_for("STEERED slow=True order=True ran=True", 40, mark)
        time.sleep(1)
        not_run = not wrong.exists()
        # 2. the agent is writing a long answer: it is stopped at once
        typed(b"/new")
        time.sleep(1.5)
        typed(b"STEERTEST SLOWTALK: explain")
        talking = wait_for("explaining at length", 30)
        t0 = time.time()
        typed(b"TURN RIGHT now")
        time.sleep(0.5)
        os.write(fd, b"\r")
        mark = len(seen)
        second = wait_for("wrote=True gist=True wish=TURN RIGHT", 30, mark) and time.time() - t0 < 8
        # 4. a command that never finishes (sleep 60): the interruption stops it after about 3 seconds
        typed(b"/new")
        time.sleep(1.5)
        mark = len(seen)
        typed(b"STEERTEST HANG: run the hanging command")
        wait_for("sleep 60", 20, mark)
        typed(b"TURN DOWN")
        time.sleep(0.5)
        t1 = time.time()
        os.write(fd, b"\r")
        mark = len(seen)
        hung = wait_for("HUNGSTOP stopped=True marked=True finished=False", 30, mark)
        hung_secs = time.time() - t1
        # 3. Esc while the interruption waits: the agent stops and the message is back in the input box, not sent
        typed(b"/new")
        time.sleep(1.5)
        mark = len(seen)
        typed(b"STEERTEST: run the slow command again")
        wait_for("sleep 3", 20, mark)
        typed(b"TURN UP")
        time.sleep(0.5)
        os.write(fd, b"\r")
        wait_for("Interrupting (waits 3 s for the running command, then stops it): TURN UP", 10, mark)
        os.write(fd, b"\x1b")
        time.sleep(5)
        mark = len(seen)
        os.write(fd, b"\r")  # send what Esc put back
        back = wait_for("PLAIN TURN UP", 20, mark) and "STEERED" not in plain(seen[mark:])
        for _ in range(2):
            os.write(fd, b"\x03")
            time.sleep(0.3)
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
        raw = seen.decode("utf-8", "replace")
        titled = "\x1b]0;⏳ STEERTEST: run the slow command · work · Ferry" in raw and "\x1b]0;STEERTEST" in raw
        ok = started and hinted and waiting and first and not_run and talking and second and back and titled
        check("F53 工作中插话", ok, "agent 干活时按 Enter 排队、提示可立即插话；空行再按 Enter：正在跑的命令跑完、后面的工具调用不再执行，"
              "agent 收到你的话和\"被打断\"说明；正在写长回答时立刻停下改方向；等待中按 Esc，话回到输入框不发出；标签页标题显示对话内容、项目和 ⏳ 工作中" if ok
              else f"started={started} hinted={hinted} waiting={waiting} first={first} not_run={not_run} talking={talking} "
                   f"second={second} back={back} titled={titled}: {re.findall(r'\x1b]0;[^\x07]*', raw)[-5:]!r} {plain(seen)[-400:]!r}")
        hung_ok = hung and hung_secs < 15
        check("F79 打断时不等长命令", hung_ok, "正在跑 sleep 60 时空行按 Enter：约 3 秒后命令被停掉，已有输出留着，结果写明被用户打断，agent 收到你的话和\"命令已停掉\"的说明，几秒内接着干" if hung_ok
              else f"hung={hung} secs={hung_secs:.1f}: {plain(seen)[-400:]!r}")
    finally:
        s.close()
        (work / "steer-wrong.txt").unlink(missing_ok=True)


def check_server_models_only(root: Path, work: Path) -> None:
    """With the server unreachable, ferry stops and says so instead of offering a stale saved model list."""
    s = Stack(root, work, "agent", start_server=False)
    try:
        s.home.mkdir(parents=True, exist_ok=True)
        (s.home / "models-cache.json").write_text(json.dumps([{"id": "stale-model"}]), encoding="utf-8")
        code, out = s.ferry("-p", "hello", timeout=120)
        ok = code != 0 and "Refusing cached or built-in models" in out and "stale-model" not in out
        check("F92 模型只认服务端", ok, "服务端连不上时 ferry 说明原因并退出，不拿上次存下的模型列表凑合"
              if ok else f"code={code} {out[-300:]!r}")
    finally:
        s.close()


def check_plan_switch(root: Path, work: Path) -> None:
    """The agent proposes plan mode and later asks to leave it; the user answers both questions in the terminal."""
    if WINDOWS:
        print("  SKIP  F90 agent 提议计划模式（Windows 上没有伪终端，Linux 上检查）")
        return
    import pty
    import select

    s = Stack(root, work, "agent")
    seen = b""
    made = work / "plan-mode.txt"
    made.unlink(missing_ok=True)
    try:
        env = {**s.env, "FERRY_SERVER": s.base, "FERRY_TOKEN": TOKEN, "TERM": "xterm-256color", "COLUMNS": "140", "LINES": "40",
               "FERRY_AUTO_APPROVE": "1"}
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(work)
            os.execvpe(NODE, [NODE, str(ROOT / "client" / "bin" / "ferry.mjs")], env)
        plain = lambda b: re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-B]|[\r]", "",  # noqa: E731
                                 b.decode("utf-8", "replace"))

        def wait_for(text: str, secs: float, since: int = 0) -> bool:
            nonlocal seen
            end = time.time() + secs
            while time.time() < end:
                r, _, _ = select.select([fd], [], [], 0.2)
                if r:
                    try:
                        seen += os.read(fd, 65536)
                    except OSError:
                        return False
                if text in plain(seen[since:]):
                    return True
            return False

        started = wait_for("shift+tab", 60)
        os.write(fd, b"PLANTEST: a big change")
        time.sleep(0.4)
        os.write(fd, b"\r")
        proposed = wait_for("Switch to plan mode?", 30) and "PLANREASON" in plain(seen)
        time.sleep(0.3)
        mark = len(seen)
        os.write(fd, b"\r")  # Yes
        footer = wait_for("plan: read-only (shift+tab)", 15, mark)
        asked_back = wait_for("Switch to: full access", 30, mark) and "PLANREADY" in plain(seen[mark:])
        time.sleep(0.3)
        mark = len(seen)
        os.write(fd, b"\r")  # Yes
        done = wait_for("PLANMODE entered=True refused=True left=True wrote=True", 30, mark) and made.exists()
        restored = "full access: nothing asks (shift+tab)" in plain(seen[mark:])
        # keep reading while ferry quits: on macOS a full terminal buffer blocks its writes, and then it never exits
        for _ in range(2):
            os.write(fd, b"\x03")
            wait_for("\0", 0.3)
        try:
            os.kill(pid, signal.SIGTERM)
            for _ in range(50):
                if os.waitpid(pid, os.WNOHANG)[0]:
                    break
                wait_for("\0", 0.1)
            else:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
        ok = started and proposed and footer and asked_back and done and restored
        check("F90 agent 提议计划模式", ok, "agent 提议进计划模式，问你同意后底栏变成只读规划，写文件被拒；计划好后 agent 请求开始，"
              "再问你，同意后回到原来的模式，文件写成" if ok
              else f"started={started} proposed={proposed} footer={footer} asked_back={asked_back} done={done} "
                   f"restored={restored}: {plain(seen)[-600:]!r}")
    finally:
        s.close()
        made.unlink(missing_ok=True)


def check_team(root: Path, work: Path) -> None:
    """Ferry run by Paperclip (its pi adapter): the team tool works the board; only Ferry's models are listed."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    calls = []
    lead, researcher, task = "a1111111-1111-4111-8111-111111111111", "b2222222-2222-4222-8222-222222222222", \
        "c3333333-3333-4333-8333-333333333333"

    class Board(BaseHTTPRequestHandler):  # the few Paperclip endpoints the team tool uses
        def log_message(self, *a):
            pass

        def reply(self, obj, code=200):
            data = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def handle_any(self, method):
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n)) if n else None
            calls.append({"method": method, "path": self.path, "body": body, "auth": self.headers.get("Authorization"),
                          "run": self.headers.get("X-Paperclip-Run-Id")})
            if self.path.endswith("/agents"):
                return self.reply([{"id": lead, "name": "Lead", "status": "running"},
                                   {"id": researcher, "name": "Researcher", "status": "idle"}])
            if method == "POST" and self.path.endswith("/issues"):
                return self.reply({"id": "d4444444-4444-4444-8444-444444444444", "identifier": "LAB-2", "status": "todo",
                                   "title": body["title"], "assigneeAgentId": body.get("assigneeAgentId")})
            if method == "GET" and self.path == f"/api/issues/{task}":
                return self.reply({"id": task, "identifier": "LAB-1", "status": "in_progress", "title": "TEAMTEST: plan", "blockedBy": []})
            if method == "PATCH":
                return self.reply({"id": task, "identifier": "LAB-1", "status": body.get("status", "in_progress"), "title": "TEAMTEST: plan"})
            return self.reply({"ok": True})

        def do_GET(self):
            self.handle_any("GET")

        def do_POST(self):
            self.handle_any("POST")

        def do_PATCH(self):
            self.handle_any("PATCH")

    board = ThreadingHTTPServer(("127.0.0.1", 0), Board)
    threading.Thread(target=board.serve_forever, daemon=True).start()
    s = Stack(root, work, "agent")
    try:
        team_env = {"PAPERCLIP_API_URL": f"http://127.0.0.1:{board.server_address[1]}", "PAPERCLIP_API_KEY": "run-jwt",
                    "PAPERCLIP_AGENT_ID": lead, "PAPERCLIP_COMPANY_ID": "co1", "PAPERCLIP_RUN_ID": "run-1",
                    "PAPERCLIP_TASK_ID": task, "FERRY_AUTO_APPROVE": "0"}
        wake = ("## Paperclip Wake Payload\n\n- reason: issue_assigned\n- issue: LAB-1 TEAMTEST: plan the launch\n"
                f'{{"issueId":"{task}"}}')
        # exactly the arguments Paperclip's pi adapter passes (pi's seven tools only), with ferry as the command
        code, out = s.ferry("--mode", "json", "-p", "--append-system-prompt", "You are agent Lead.", "--provider", "ferry",
                            "--model", "auto", "--tools", "read,bash,edit,write,grep,find,ls", wake, env_extra=team_env)
        create = next((c for c in calls if c["method"] == "POST" and c["path"] == "/api/companies/co1/issues"), None)
        wait = next((c for c in calls if c["method"] == "PATCH" and c["path"] == f"/api/issues/{task}"), None)
        comment = next((c for c in calls if c["path"] == f"/api/issues/{task}/comments"), None)
        delegated = bool(create and create["body"].get("assigneeAgentId") == researcher and create["body"].get("parentId") == task)
        waits = bool(wait and wait["body"].get("status") == "blocked" and wait["body"].get("blockedByIssueIds") == ["d4444444-4444-4444-8444-444444444444"])
        headers = all(c["auth"] == "Bearer run-jwt" and c["run"] == "run-1" for c in calls)
        said = "LEAD: delegated" in out and bool(comment)
        code_m, models = s.ferry("--list-models")
        only_ferry = code_m == 0 and "ferry" in models and "amazon-bedrock" not in models
        ok = code == 0 and delegated and waits and headers and said and only_ferry
        check("F54 团队成员（Paperclip）", ok, "按 Paperclip 的参数启动 ferry：用 team 工具把任务派给 Researcher、自己的任务改为等待它、"
              "留言说明；请求都带运行身份；--list-models 只列 Ferry 的模型" if ok
              else f"code={code} delegated={delegated} waits={waits} headers={headers} said={said} only_ferry={only_ferry} "
                   f"calls={[(c['method'], c['path']) for c in calls]} out={out[-300:]!r}")
    finally:
        s.close()
        board.shutdown()


def check_v019(root: Path, work: Path) -> None:
    """Pictures with image_create; only the server's models in the model list."""
    pics = ('\n[models.pics]\nbase_url = "http://127.0.0.1:9100/v1"\napi_key_env = "DEEPSEEK_API_KEY"\nmodel = "gpt-image-2"\n'
            '\n[routing]\ndefault = "main"\nimage = "pics"\n')
    s = Stack(root, work, "agent", extra_toml=pics)
    try:
        made = work / "images" / "ferry.png"
        made.unlink(missing_ok=True)
        code, out = s.ferry("-p", "IMAGETEST: draw the cover")
        png = made.exists() and made.read_bytes().startswith(b"\x89PNG")
        sent = [u for u in jsonl(s.upstream) if u.get("model") == "gpt-image-2"]
        ok = code == 0 and png and "IMAGE: Saved" in out and sent and sent[0]["prompt"].startswith("a small ferry")
        check("F59 生成图片", ok, "agent 用 image_create 描述一张图，服务端交给\"生成图片用\"的模型画，PNG 存进项目文件夹"
              if ok else f"code={code} png={png} sent={len(sent)} out={out[-300:]!r}")
        code2, listed = s.ferry("--list-models", "claude", env_extra={"ANTHROPIC_API_KEY": "x", "OPENAI_API_KEY": "y"})
        code3, mine = s.ferry("--list-models", env_extra={"ANTHROPIC_API_KEY": "x"})
        ok2 = "No models matching" in listed and "ferry" in mine and "anthropic" not in mine and "pics" not in mine
        check("F60 只列服务端的模型", ok2, "电脑上有 ANTHROPIC_API_KEY 等也不会列出 pi 自带的服务商；生图模型不出现在对话模型里"
              if ok2 else f"{listed[-200:]!r} | {mine[-300:]!r}")
    finally:
        s.close()
        (work / "images" / "ferry.png").unlink(missing_ok=True)


def check_v022(root: Path, work: Path) -> None:
    """A rate-limited Claude account whose fallback speaks OpenAI's API: the client asks the fallback itself."""
    toml = ('\n[providers.kiro]\nbase_url = "http://127.0.0.1:9100"\napi = "anthropic"\napi_key_env = "DEEPSEEK_API_KEY"\n'
            'fallback = "main"\ncooldown = 30\n\n[models.claude]\nprovider = "kiro"\nmodel = "claude-opus-5-5"\n'
            'context_window = 200000\nmax_tokens = 8000\n\n[routing]\ndefault = "claude"\nexpose = true\n')
    s = Stack(root, work, "agent", extra_toml=toml)
    try:
        c1, o1 = s.ferry("-p", "LIMITTEST: say something")
        c2, o2 = s.ferry("-p", "LIMITTEST: once more")
        claude_calls = [u for u in jsonl(s.upstream) if u.get("model") == "claude-opus-5-5"]
        reroutes = [a for a in jsonl(s.data / "audit.jsonl") if a.get("event") == "reroute"]
        ok = (c1 == 0 and c2 == 0 and "LIMIT: answered by the fallback after fallback-step" in o1 and "LIMIT: answered" in o2
              and len(claude_calls) == 1 and len(reroutes) == 2)
        check("F61 限流时改用另一种接口的模型", ok, "Claude 账号 429 冷却，回退模型是 OpenAI 接口：客户端按它的格式重发，"
              "同一次运行里后面的请求直接问回退模型，冷却期间不再打扰 Claude 账号"
              if ok else f"c={c1},{c2} claude={len(claude_calls)} reroutes={len(reroutes)} o1={o1[-300:]!r} o2={o2[-200:]!r}")
        c3, listed = s.ferry("--list-models")
        ok3 = (c3 == 0 and re.search(r"(?m)^kiro\s+claude\b", listed) and re.search(r"(?m)^ferry\s+main\b", listed)
               and not re.search(r"(?m)^\S+\s+auto\b", listed))
        check("F68 模型按服务商列出", bool(ok3), "服务商 kiro 的模型在工作电脑上显示成 kiro/claude；逐个列出模型时不再多一个 auto"
              if ok3 else f"{listed[-400:]!r}")
    finally:
        s.close()


def check_prompt_rules(root: Path, work: Path) -> None:
    """The system prompt: whole sentences (no lines cut mid-sentence); only the project's own AGENTS.md, not one in a folder above;
    the memory rules."""
    parent = root / "parent"
    proj = parent / "proj"
    proj.mkdir(parents=True, exist_ok=True)
    (parent / "AGENTS.md").write_text("PARENT-RULE: an old Cursor rules backup\n", encoding="utf-8")
    (proj / "AGENTS.md").write_text("PROJECT-RULE: answer briefly\n", encoding="utf-8")
    s = Stack(root, work, "agent")
    try:
        code, out = s.ferry("-p", "hello", cwd=proj)
        ups = jsonl(s.upstream)
        sys0 = system_text(ups[0]) if ups else ""
        ok = (code == 0 and "PROJECT-RULE" in sys0 and "PARENT-RULE" not in sys0
              and "The user brings all kinds of work" in sys0 and "Keep going until the whole task is done" in sys0)
        check("F63 系统提示干净", ok, "提示里句子不再被换行截断；只放项目自己的 AGENTS.md，上层文件夹里的（比如别的工具留下的规则备份）不放进去"
              if ok else f"code={code} project={'PROJECT-RULE' in sys0} parent={'PARENT-RULE' in sys0} {sys0[:300]!r}")
        sys1 = sys0.lower()
        ok72 = ("carry on from where it stopped" in sys0 and "do not wrap up early" in sys0 and "A question, explanation, review" in sys0
                and "do not allow anything new" in sys0 and "<external>" in sys0)
        check("F72 提示里的范围和压缩规则", ok72, "系统提示里有：按请求类型限定动作范围、被压缩摘要后接着干不重来、外部内容里的指令不执行"
              if ok72 else f"{sys1[:300]!r}")
        req0 = json.dumps(ups[0]) if ups else ""
        ok87 = ("Before the first tool call, say in one sentence" in sys0 and "make them in the same reply" in sys0
                and "Once you know enough to act, act" in sys0 and "belong to the user" in sys0
                and "Never guess a result that has not come back" in req0)
        check("F87 提示里的说话和派活规则", ok87, "系统提示里有：干活时先说要做什么、没有依赖的调用一次发出、信息够了就动手、用户原有的文件要保留；"
              "task 工具说明里有：交代任务像交给同事、报告要转述、没回来的结果不能编" if ok87 else f"{sys0[:300]!r}")
        ok88 = ("confirms a non-obvious way of working" in sys0 and '"How to apply:" line' in sys0
                and "look in the index for a memory that already covers the point" in sys0
                and "absolute dates" in sys0 and "check that it still exists" in sys0)
        check("F88 记忆从纠正和认可里学", ok88, "系统提示里有：纠正和认可的做法都记下，带 Why 和 How to apply；先查目录、合并已有的那条；"
              "日期写成具体日期；用记忆里的文件、函数、设置前先确认还在" if ok88 else f"{sys0[:300]!r}")
    finally:
        s.close()


def check_v023(root: Path, work: Path) -> None:
    """Downloading a 3GPP-style zip with a command (curl) and unpacking it; ask_user without a terminal."""
    proj = root / "proj"
    proj.mkdir(parents=True, exist_ok=True)
    s = Stack(root, work, "agent")
    try:
        c1, o1 = s.ferry("-p", "DOWNLOADTEST: get TS 23.501", cwd=proj, env_extra={"FERRY_PERMISSION_MODE": "bypass"})
        ok1 = c1 == 0 and "DOWNLOAD:" in o1 and "5G system architecture" in o1 and (proj / "downloads" / "23501-j40.zip").exists()
        check("F64 下载文件", ok1, "agent 用命令（curl）把 zip 下载到项目里、解压，接着读里面的文件"
              if ok1 else f"code={c1} {o1[-300:]!r}")
        c2, o2 = s.ferry("-p", "ASKTEST: make a report", cwd=proj)
        ok2 = c2 == 0 and "ASK:" in o2 and "Nobody can answer here" in o2 and "PPT" in o2
        check("F65 选项式提问", ok2, "ask_user 在没有终端时（-p、团队成员）不卡住：告诉 agent 按推荐的选项继续"
              if ok2 else f"code={c2} {o2[-300:]!r}")
    finally:
        s.close()


def check_upload_delete(root: Path, work: Path) -> None:
    """Full access mode: uploads still ask (no rule allows them), downloads do not; deletes ask unless the session made it."""
    proj = root / "proj"
    proj.mkdir(parents=True, exist_ok=True)
    (proj / "secret.txt").write_text("SECRET-PAYLOAD-69\n", encoding="utf-8")
    (proj / "old.txt").write_text("was here before\n", encoding="utf-8")
    s = Stack(root, work, "agent")
    try:
        full = {"FERRY_PERMISSION_MODE": "bypass", "FERRY_AUTO_APPROVE": "0"}
        (s.home).mkdir(parents=True, exist_ok=True)
        (s.home / "permissions.json").write_text(json.dumps({"allow": ["bash(curl*)"]}), encoding="utf-8")
        c1, o1 = s.ferry("-p", "UPLOADTEST: send the file", cwd=proj, env_extra=full)
        up = s.upstream.read_text(encoding="utf-8") if s.upstream.exists() else ""
        ok1 = (c1 == 0 and "UPLOAD:" in o1 and "approval every time" in o1 and "upload.example.com" in o1 and "No rule or mode" in o1
               and "downloaded" in o1 and (proj / "got.zip").exists() and "SECRET-PAYLOAD-69" not in up)
        check("F69 上传每次都问", ok1, "全部放行模式加上 bash(curl*) 规则，curl 上传本机文件仍要确认（没有终端时拦下，说明规则和模式都放不行），"
              "文件没发出去；curl 下载照常不问" if ok1 else f"code={c1} {o1[-400:]!r}")
        # every mode: what this session made goes (project folder, temp folder); what was there before always asks
        tmpf = Path(tempfile.gettempdir()) / "ferry-f70-scratch.txt"
        c2, o2 = s.ferry("-p", "DELETETEST-TMP: clean up", cwd=proj, env_extra=full)
        ok2 = (c2 == 0 and "removed-new" in o2 and "removed-tmp" in o2 and not (proj / "made-now.txt").exists() and not tmpf.exists()
               and "did not create in this session" in o2 and "removed-old" not in o2 and (proj / "old.txt").exists())
        c3, o3 = s.ferry("-p", "DELETETEST: clean up", cwd=proj, env_extra={**full, "FERRY_PERMISSION_MODE": "acceptEdits"})
        c4, o4 = s.ferry("-p", "DELETETEST: clean up", cwd=proj, env_extra={**full, "FERRY_PERMISSION_MODE": "default"})
        # default mode asks for the write itself (no terminal here), so only the old file is checked there
        ok3 = (c3 == 0 and "removed-new" in o3 and "did not create in this session" in o3 and "removed-old" not in o3 and (proj / "old.txt").exists())
        ok4 = (c4 == 0 and "removed-old" not in o4 and (proj / "old.txt").exists())
        # a pattern and a cd chain over files made this session go ahead; a pattern that also reaches an old file asks
        c5, o5 = s.ferry("-p", "DELETETEST-GLOB: clean up", cwd=proj, env_extra={**full, "FERRY_PERMISSION_MODE": "acceptEdits"})
        ok5 = (c5 == 0 and "removed-glob" in o5 and "removed-cd" in o5 and "removed-all-txt" not in o5 and "old.txt" in o5
               and "did not create in this session" in o5 and not (proj / "tmp_a.txt").exists() and not (proj / "sub" / "c.txt").exists()
               and (proj / "old.txt").exists())
        ok4 = ok4 and ok5
        check("F70 删除只放行本次新建的", ok2 and ok3 and ok4,
              "任何模式下，删除本次会话里 agent 新建的文件直接执行，项目里和临时文件夹里都一样，带通配符的（rm tmp_*.txt）和先 cd 再删的也一样（全部放行、自动接受编辑已验证）；"
              "删除原来就有的文件在每个模式下都要确认，也没有\"以后都允许\""
              if ok2 and ok3 and ok4 else f"bypass={c2} {o2[-400:]!r} | acceptEdits={c3} {o3[-300:]!r} | default={c4} {o4[-300:]!r} | glob={c5} {o5[-500:]!r}")
    finally:
        s.close()


def _tiny_pdf(text: str) -> bytes:
    stream = f"BT /F1 18 Tf 72 720 Td ({text}) Tj ET"
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    pdf, offs = "%PDF-1.4\n", []
    for i, o in enumerate(objs):
        offs.append(len(pdf))
        pdf += f"{i + 1} 0 obj\n{o}\nendobj\n"
    xref = len(pdf)
    pdf += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offs)
    pdf += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF"
    return pdf.encode("latin1")


def _tiny_docx(text: str) -> bytes:
    import io
    import zipfile
    w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="xml" ContentType="application/xml"/></Types>')
        z.writestr("word/document.xml", f'<?xml version="1.0"?><w:document {w}><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>')
    return buf.getvalue()


def check_office_legacy(root: Path, work: Path) -> None:
    """Old .doc files, a .docx that is really an IRM-encrypted file, and a whole folder into text files, all without Office."""
    fx = ROOT / "client" / "test" / "fixtures"
    proj = root / "proj"
    (proj / "old").mkdir(parents=True, exist_ok=True)
    (proj / "docs" / "sub").mkdir(parents=True, exist_ok=True)
    shutil.copy(fx / "memo.doc", proj / "old" / "memo.doc")
    shutil.copy(fx / "irm-protected.docx", proj / "old" / "locked.docx")
    (proj / "docs" / "new.docx").write_bytes(_tiny_docx("Batch docx text"))
    shutil.copy(fx / "memo.doc", proj / "docs" / "sub" / "old.doc")
    (proj / "docs" / "paper.pdf").write_bytes(_tiny_pdf("Batch PDF text"))
    (proj / "docs" / "broken.docx").write_bytes(b"PK\x03\x04 not a real zip")
    s = Stack(root, work, "agent")
    try:
        c1, o1 = s.ferry("-p", "OLDDOCTEST: read the memo", cwd=proj)
        ok1 = c1 == 0 and "OLDDOC:" in o1 and "Ferry test memo" in o1 and "渡船测试" in o1
        check("F75 读旧版 .doc", ok1, "office_read 直接读出 Word 97-2003 的 .doc 文字（中英文、表格），不用 Office，也不用 COM"
              if ok1 else f"code={c1} {o1[-300:]!r}")
        c2, o2 = s.ferry("-p", "IRMTEST: read the locked file", cwd=proj)
        ok2 = c2 == 0 and "IRM:" in o2 and "rights management (IRM)" in o2 and "tell the user" in o2
        check("F76 IRM 加密文件说清楚", ok2, "扩展名是 .docx、实际是 IRM 加密的 OLE 文件：office_read 按内容识别，直接说明已加密、"
              "没有所有者授权读不了、要告诉用户" if ok2 else f"code={c2} {o2[-300:]!r}")
        # batch mode writes files, so it is a file change: allowed in auto-edit mode
        c3, o3 = s.ferry("-p", "DOCFOLDERTEST: convert the folder", cwd=proj, env_extra={"FERRY_PERMISSION_MODE": "acceptEdits"})
        out = proj / "docs-txt"
        txt = lambda rel: (out / rel).read_text(encoding="utf-8", errors="replace") if (out / rel).exists() else ""  # noqa: E731
        ok3 = (c3 == 0 and "ok 3, encrypted 0, failed 1" in o3 and "broken.docx" in o3 and "Batch docx text" in txt("new.docx.txt")
               and "渡船测试" in txt("sub/old.doc.txt") and "Batch PDF text" in txt("paper.pdf.txt"))
        check("F77 整个文件夹转成文本", ok3, "office_read 给文件夹和 out：docx、doc、pdf 各转成一个 .txt，坏文件列在失败里，"
              "对话里只有一份汇总" if ok3 else f"code={c3} {o3[-400:]!r}")
    finally:
        s.close()


def _word_docx(body: str) -> bytes:
    import io
    import zipfile
    w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        z.writestr("word/document.xml", f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {w}><w:body>{body}<w:sectPr/></w:body></w:document>')
    return buf.getvalue()


def check_word_tracked(root: Path, work: Path) -> None:
    """A 3GPP-style CR in Word: cover cells filled, a tracked paragraph, a comment, accept all; editing inside another author's insertion."""
    import zipfile
    proj = root / "proj"
    proj.mkdir(parents=True, exist_ok=True)
    wp = lambda t: f'<w:p><w:r><w:t xml:space="preserve">{t}</w:t></w:r></w:p>'  # noqa: E731
    wc = lambda t: f'<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>{wp(t) if t else "<w:p/>"}</w:tc>'  # noqa: E731
    cover = "".join(f"<w:tr>{wc(a)}{wc(b)}</w:tr>" for a, b in (("Title:", ""), ("Source to WG:", ""), ("Category:", "F")))
    (proj / "cr.docx").write_bytes(_word_docx(f"<w:tbl><w:tblPr/><w:tblGrid/>{cover}</w:tbl>{wp('5.2 Measurement report')}"
                                              f"{wp('The UE shall send the report every 10 s.')}{wp('End of clause.')}"))
    (proj / "alice.docx").write_bytes(_word_docx('<w:p><w:r><w:t xml:space="preserve">The UE </w:t></w:r><w:ins w:id="1" w:author="Alice" w:date="2026-01-02T00:00:00Z">'
                                                 '<w:r><w:t>shall send the report</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> often.</w:t></w:r></w:p>'))
    doc = lambda name: zipfile.ZipFile(proj / name).read("word/document.xml").decode("utf-8")  # noqa: E731
    nested = re.compile(r"<w:ins\b[^>]*[^/]>(?:(?!</w:ins>).)*?<w:ins\b[^>]*[^/]>", re.S)
    s = Stack(root, work, "agent")
    try:
        c1, o1 = s.ferry("-p", "CRCOVERTEST: fill the cover and add the sentence", cwd=proj)
        x1 = doc("cr.docx")
        ok1 = (c1 == 0 and "CRCOVER:" in o1 and "| Title: | Faster reporting |" in o1 and "| Source to WG: | Example Corp |" in o1
               and "{+The UE shall also log the report.+}" in o1 and re.search(r'<w:rPr><w:ins w:id="\d+" w:author="Example Delegate"', x1) is not None)
        check("F101 CR 封面和修订段落", ok1, "office_edit 按左边的标签往 CR 封面的空格子写字（不留修订），在条款里按修订方式插入一段"
              "（段落标记也标成插入）；office_read 读出封面内容和 {+新段落+}" if ok1 else f"code={c1} {o1[-500:]!r}")
        c2, o2 = s.ferry("-p", "WORDCOMMENTTEST: comment on the period", cwd=proj)
        ok2 = c2 == 0 and re.search(r"every 10 s\[comment (\d+)\]\.[\s\S]*\[comment \1\] Example Delegate: Why 10 s\?", o2) is not None
        check("F102 Word 批注", ok2, "office_edit 给一段文字加批注（文件里原来没有批注部件，自动建好），office_read 在正文里标出 [comment N]，"
              "末尾列出作者和内容" if ok2 else f"code={c2} {o2[-500:]!r}")
        c3, o3 = s.ferry("-p", "ACCEPTALLTEST: accept everything", cwd=proj)
        x3 = doc("cr.docx")
        ok3 = (c3 == 0 and "2 tracked change(s) accepted" in o3 and "{+" not in o3.split("||")[-1]
               and "The UE shall also log the report." in o3 and "<w:ins " not in x3 and "<w:del " not in x3 and "[comment" in o3)
        check("F103 接受全部修订", ok3, "office_edit 接受全部修订：插入的段落变成正文，文件里不再有修订标记，批注还在" if ok3 else f"code={c3} {o3[-500:]!r}")
        c4, o4 = s.ferry("-p", "NESTEDINSTEST: shorten the report", cwd=proj)
        x4 = doc("alice.docx")
        ok4 = (c4 == 0 and "{+shall +}{-send the report-}{+send a short report+}" in o4 and not nested.search(x4) and 'w:author="Alice"' in x4)
        check("F104 改别人修订里的字", ok4, "Bob 改 Alice 修订里插入的字：Alice 的插入在改动处断开，Bob 的删除留在她的插入里、Bob 的插入放在外面，"
              "不会出现修订套修订；office_read 读出正确的修订痕迹" if ok4 else f"code={c4} {o4[-500:]!r} {x4[-600:]!r}")
    finally:
        s.close()


def check_gateway(root: Path, work: Path) -> None:
    gate = root / "confirmed.txt"
    s = Stack(root, work, "agent", server_env={"FERRY_TEST_GATEWAY_FILE": str(gate)})
    try:
        c0, o0 = s.ferry("doctor", "--no-model")
        c1, o1 = s.ferry("-p", "TODOTEST: plan it", env_extra={"FERRY_TEST_OPENED_FILE": str(gate)})
        check("F37 公司网关要先确认", c0 != 0 and "company network gateway" in o0 and c1 == 0 and "[x] step one" in o1
              and "proxycontrolwarn" in gate.read_text(encoding="utf-8"),
              "doctor 指出是公司网关在等确认；ferry 启动时自动在浏览器打开确认页，确认后自己接着运行")
        gate.unlink()
        opened = {"FERRY_TEST_OPENED_FILE": str(gate)}
        c2, o2 = s.ferry("check", env_extra=opened)
        c3, o3 = s.ferry("check")
        # the confirmation runs out in the middle of the agent's work: ferry opens the page, waits, and goes on
        c4, o4 = s.ferry("-p", f"EXPIRYTEST: {gate.name}", cwd=root, env_extra={**opened, "FERRY_PERMISSION_MODE": "bypass"})
        ok = (c2 == 0 and "Through" in o2 and c3 == 0 and "does not want a confirmation" in o3
              and c4 == 0 and "EXPIRY: went on after the confirmation" in o4 and gate.exists())
        check("F62 网关确认过期", ok, "ferry check 发现要确认就打开确认页并等到通过，不需要时说一声；agent 干活中途确认过期，"
              "自动打开确认页，确认后接着发，不报错" if ok else f"check={c2},{c3} run={c4} {o2[-200:]!r} {o3[-150:]!r} {o4[-300:]!r}")
        # the confirmation runs out mid-work and nobody confirms for a long while (the night, here scaled to seconds):
        # ferry keeps waiting, tells the phone once, and goes on after the confirmation; nobody at all: it stops at the cap
        import threading
        blocked = Path(f"{gate}.blocked")
        blocked.unlink(missing_ok=True)
        quick = {"FERRY_NO_BROWSER": "1", "FERRY_TEST_GATEWAY_NOTIFY_MS": "3000", "FERRY_TEST_GATEWAY_POLL_MS": "1000",
                 "FERRY_PERMISSION_MODE": "bypass"}

        def confirm_later():
            end = time.time() + 120
            while gate.exists() and time.time() < end:  # the bash step takes the confirmation away
                time.sleep(0.2)
            time.sleep(12)
            gate.write_text("confirmed", encoding="utf-8")
        threading.Thread(target=confirm_later, daemon=True).start()
        c5, o5 = s.ferry("-p", f"EXPIRYTEST: {gate.name}", cwd=root, env_extra=quick)
        rows = blocked.read_text(encoding="utf-8").splitlines() if blocked.exists() else []
        probes, tells = rows.count("GET /health"), rows.count("POST /v1/ferry/notify")
        (s.home / "config.json").write_text(json.dumps({"gatewayWaitMinutes": 0.1}), encoding="utf-8")
        c6, o6 = s.ferry("-p", f"EXPIRYTEST: {gate.name}", cwd=root, env_extra=quick)
        gate.write_text("confirmed", encoding="utf-8")
        ok = (c5 == 0 and "EXPIRY: went on after the confirmation" in o5 and probes >= 5 and tells == 1
              and c6 != 0 and "ferry -c" in o6 and "gatewayWaitMinutes" in o6)
        check("F111 网关夜里要确认", ok, f"agent 干活中途网关要确认、很久没人确认：一直等着（问了服务端 {probes} 次），手机通知只发一次"
              "（网关挡着服务端时这条通知也过不去），确认后同一个请求接着发、做完；一直没人确认就在 gatewayWaitMinutes 停下，"
              "说明发生了什么、用 ferry -c 接着" if ok else f"run={c5} probes={probes} tells={tells} cap={c6} {o5[-300:]!r} {o6[-400:]!r}")
    finally:
        s.close()


def find_browser() -> str:
    """A Chrome/Chromium/Edge for the browser test, or "" (the test is then skipped)."""
    cands = [os.environ.get("FERRY_TEST_BROWSER", ""), r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
             r"C:\Program Files\Google\Chrome\Application\chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"]
    cands += sorted(str(p) for p in Path("/opt/pw-browsers").glob("chromium-*/chrome-linux*/chrome")) if Path("/opt/pw-browsers").exists() else []
    return next((c for c in cands if c and Path(c).exists()), "")


def warm_browser(browser: str, args: list[str], profile: Path) -> float:
    """Start and close the browser once, outside Ferry, in an agent-browser session of its own; returns the seconds.

    The first start on a fresh CI machine reads the browser from a cold disk and can take longer than the 30 s one
    agent-browser command waits for its daemon; the command then fails and the check would measure the disk."""
    win = sys.platform == "win32"
    arch = "x64" if win else {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64"}.get(platform.machine().lower(), platform.machine())
    ab = ROOT / "node_modules" / "agent-browser" / "bin" / f"agent-browser-{sys.platform}-{arch}{'.exe' if win else ''}"
    env = {**os.environ, "AGENT_BROWSER_EXECUTABLE_PATH": browser, "AGENT_BROWSER_PROFILE": str(profile),
           "AGENT_BROWSER_ARGS": "\n".join(args), "AGENT_BROWSER_SESSION": "ferry-selftest-warmup"}
    t = time.time()
    for cmd in (["open", "about:blank"], ["close"]):
        try:
            subprocess.run([str(ab), *cmd], env=env, capture_output=True, timeout=120)
        except (OSError, subprocess.TimeoutExpired):
            pass
    return time.time() - t


def check_web_browser(root: Path, work: Path) -> None:
    pages = {"FERRY_TEST_SEARCH_BASE": "http://127.0.0.1:9100"}
    s = Stack(root, work, "agent", server_env={**pages, "FERRY_SEARCH": "bing"})
    try:
        c1, o1 = s.ferry("-p", "WEBTEST: look it up", env_extra=pages)
        client_ok = c1 == 0 and "pelican-42" in o1
        seen71 = json.dumps(jsonl(s.upstream)[-1].get("messages", []), ensure_ascii=False)
        wrapped = '<external source="http://127.0.0.1:9100' in seen71.replace('\\"', '"')
        check("F71 外部内容带来源标记", c1 == 0 and wrapped, "web_fetch 读到的网页交给模型时包在 <external source=\"网址\"> 里，"
              "模型分得清哪些是网页内容、哪些是用户的话" if wrapped else f"code={c1} {seen71[-300:]!r}")
        c2, o2 = s.ferry("-p", "GATETEST: read the gated site", env_extra=pages)
        gate_ok = c2 == 0 and "company network gateway" in o2
        s.home.mkdir(parents=True, exist_ok=True)
        (s.home / "config.json").write_text(json.dumps({"web": "off"}), encoding="utf-8")
        s.ferry("-p", "TODOTEST: plan it")
        off_ok = "web_fetch" not in json.dumps(jsonl(s.upstream)[-1].get("tools", []))
        (s.home / "config.json").unlink()
        check("F35 联网工具", client_ok and gate_ok and off_ok,
              "在工作电脑上搜索和读网页；公司网关要确认的网站会说明去哪确认；设成 off 时没有联网工具")
    finally:
        s.close()
    # the server has search APIs (their keys stay there) and Exa's free search: web_search asks the server, which
    # asks all of them at once; pages are still read here
    api = {"FERRY_SEARCH": "tavily", "FERRY_SEARCH_KEY": "tvly-test", "FERRY_SEARCH_API_TAVILY": "http://127.0.0.1:9100/tavily",
           "FERRY_SEARCH_KEY_DEEPSEEK": "ds-test", "FERRY_SEARCH_API_DEEPSEEK": "http://127.0.0.1:9100/deepseek"}
    s = Stack(root.parent / "web-search", work, "agent", server_env={**pages, **api})
    try:
        before = len(jsonl(s.upstream))
        c1, o1 = s.ferry("-p", "WEBTEST: look it up", env_extra=pages)
        rows = jsonl(s.upstream)[before:]
        asked = [r for r in rows if r.get("query") == "ferry" and r.get("search_depth")]
        result = next((m.get("content") for m in rows[-1].get("messages", []) if m.get("role") == "tool"), "")
        result = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
        seen = "Ferry page found by the search API" in result
        ok = c1 == 0 and "pelican-42" in o1 and asked and seen
        # F98: DeepSeek, Tavily and Exa each found the same page under a different address: it is listed once
        exa = [r for r in rows if r.get("method") == "tools/call"]
        ds = [r for r in rows if r.get("ori_question") == "ferry"]
        ok98 = (bool(exa) and bool(ds) and result.count("127.0.0.1:9100/page.html") == 1 and "[2] A second ferry page" in result
                and "utm_source" not in result and "Searched by the server with deepseek+tavily+exa" in result)
        check("F98 几家一起搜", ok98, "服务端同时问 DeepSeek、Tavily 和 Exa 免费搜索，按排名合并；同一个网页（地址带 # 或"
              "跟踪参数）只列一次，结果带 [n] 编号" if ok98 else f"exa={len(exa)} deepseek={len(ds)} {result[:600]!r}")
        # F99: the server read the top pages (DeepSeek's Fetch here) and quoted the passages about the query
        fetched = [r for r in rows if set(r) == {"url"} and "127.0.0.1:9100" in r["url"]]
        ok99 = (bool(fetched) and "> The ferry leaves pier 3 every 20 minutes." in result and "Sunny and warm" not in result
                and "> The ferry museum opens at nine." in result)
        check("F99 搜索结果带原文段落", ok99, "服务端读前几个结果页，把和搜索词相关的段落原样摘出来放在结果下面（> 开头），"
              "无关的段落不带；读不到的页用搜索来源给的原文" if ok99 else f"fetched={len(fetched)} {result[:900]!r}")
        # F100: the same search again within 10 minutes: answered from the server's cache, no source asked again
        n_before = len(jsonl(s.upstream))
        c3, o3 = s.ferry("-p", "WEBTEST: look it up", env_extra=pages)
        again = [r for r in jsonl(s.upstream)[n_before:] if r.get("search_depth") or r.get("method") == "tools/call"
                 or r.get("ori_question")]
        ok100 = c3 == 0 and "pelican-42" in o3 and not again
        check("F100 搜索缓存", ok100, "10 分钟内同样的搜索直接用服务端的缓存，不再去问搜索来源"
              if ok100 else f"code={c3} asked again={len(again)} {o3[-300:]!r}")
        # read a page with a question: the page goes to the server, its model answers, only the answer comes back
        c2, o2 = s.ferry("-p", "FETCHQTEST: what is the secret word", env_extra=pages)
        rows = jsonl(s.upstream)
        read = [r for r in rows if "<page>" in json.dumps(r.get("messages", []), ensure_ascii=False)]
        agent_saw = json.dumps(rows[-1].get("messages", []), ensure_ascii=False)
        ok67 = (c2 == 0 and "From the page: the secret word is pelican-42" in o2 and read
                and "Answered from the page by" in agent_saw and "The secret word is pelican-42" not in agent_saw)
        check("F67 带问题读网页", ok67, "web_fetch 带上问题时，网页在工作电脑上抓下来交给服务端的模型读，对话里只有它的回答，"
              "不是整页（和 Claude Code 的 WebFetch 一样）" if ok67 else f"code={c2} read={len(read)} {o2[-300:]!r}")
        check("F66 搜索服务", ok, "服务端设了搜索 API（Key 在服务端）：工作电脑的 web_search 只把搜索词发给服务端，拿回结果，"
              "网页仍在工作电脑上读" if ok else f"code={c1} asked={len(asked)} seen={seen} {o1[-300:]!r}")
        browser = find_browser()
        if not browser:
            print("  SKIP  F36 浏览器（这台机器上没有 Chrome / Edge）")
            return
        s.home.mkdir(parents=True, exist_ok=True)
        is_root = hasattr(os, "geteuid") and os.geteuid() == 0
        extra = ["--no-sandbox"] if is_root or os.environ.get("CI") else []  # CI and root: no Chrome sandbox
        (s.home / "config.json").write_text(json.dumps({"browser": True, "browserHeadless": True,
                                                        "browserPath": browser, "browserArgs": extra}), encoding="utf-8")
        warm = warm_browser(browser, extra, s.home / "warmup-profile")
        c2, o2 = s.ferry("-p", "BROWSERTEST: open the page", timeout=300, env_extra={"FERRY_PERMISSION_MODE": "bypass"})
        skill = "agent-browser" in system_text(jsonl(s.upstream)[-1])
        time.sleep(1)
        left = (subprocess.run(["pgrep", "-f", str(s.home / "browser-profile")], capture_output=True).returncode == 0
                if shutil.which("pgrep") else False)
        check("F36 浏览器", c2 == 0 and "pelican-42" in o2 and "Hello Ferry" in o2 and skill and not left,
              f"agent 用 agent-browser 驱动本机浏览器（{Path(browser).name}）：读到脚本生成的内容，填表、点按钮；"
              "系统提示里有浏览器技能；ferry 退出后浏览器关掉" if "Hello Ferry" in o2 else
              f"skill={skill} left={left} warm-up={warm:.0f}s " + o2[-700:])
    finally:
        s.close()


def check_search_502(root: Path, work: Path) -> None:
    """A tunnel in front of the server answers the search call with a Cloudflare 502 page, twice."""
    import http.client
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    hits = {"search": 0}

    class Tunnel(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, *a):
            pass

        def go(self):
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            if self.path.startswith("/v1/ferry/search"):
                hits["search"] += 1
                page = b"<html><head><title>502 Bad Gateway</title></head><body>cloudflare</body></html>"
                self.send_response(502)
                for k, v in (("Content-Type", "text/html"), ("Server", "cloudflare"), ("CF-RAY", "test123-HKG"), ("Content-Length", str(len(page)))):
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(page)
                return
            conn = http.client.HTTPConnection("127.0.0.1", 8787, timeout=600)
            conn.request(self.command, self.path, body or None, {k: v for k, v in self.headers.items() if k.lower() != "host"})
            r = conn.getresponse()
            self.send_response(r.status)
            for k, v in r.getheaders():
                if k.lower() not in ("transfer-encoding", "connection", "content-length"):
                    self.send_header(k, v)
            self.end_headers()
            while chunk := r.read1(65536):
                self.wfile.write(chunk)
                self.wfile.flush()

        do_GET = do_POST = do_PUT = do_DELETE = go

    pages = {"FERRY_TEST_SEARCH_BASE": "http://127.0.0.1:9100", "FERRY_SEARCH_RETRY_MS": "50"}
    api = {"FERRY_SEARCH": "tavily", "FERRY_SEARCH_KEY": "tvly-test", "FERRY_SEARCH_API_TAVILY": "http://127.0.0.1:9100/tavily"}
    s = Stack(root, work, "agent", server_env={**pages, **api})
    tunnel = ThreadingHTTPServer(("127.0.0.1", 8788), Tunnel)
    threading.Thread(target=tunnel.serve_forever, daemon=True).start()
    try:
        c1, o1 = s.ferry("-p", "WEBTEST: look it up", env_extra={**pages, "FERRY_SERVER": "http://127.0.0.1:8788"})
        rows = jsonl(s.upstream)
        seen = json.dumps(rows[-1], ensure_ascii=False)
        bing = [r for r in rows if "bing_path" in r]
        ok73 = (c1 == 0 and hits["search"] == 2 and "not from the search engine" in seen and "not JSON" in seen
                and "Cloudflare (cf-ray test123-HKG)" in seen and "these results are Bing's page" in seen)
        check("F73 搜索遇到网关 502", ok73, "服务端前面的隧道对搜索返回两次 502 网页：客户端重试一次，再退回 Bing；"
              "提示里说明回复不是 JSON、来自 Cloudflare（带 cf-ray），不是搜索引擎" if ok73 else
              f"code={c1} search_hits={hits['search']} {seen[-500:]}")
        ok74 = bool(bing) and all("adlt=strict" in r["bing_path"] and "ADLT=STRICT" in r["bing_cookie"] for r in bing)
        check("F74 Bing 严格安全搜索", ok74, "退回 Bing 时，请求带 adlt=strict 和 SRCHHPGUSR=ADLT=STRICT，"
              "搜 6G 不会出成人内容" if ok74 else f"bing requests: {bing}")
    finally:
        tunnel.shutdown()
        tunnel.server_close()
        s.close()


def check_upload_size(root: Path, work: Path) -> None:
    """A gateway in front of the server stops request bodies above 24 KB with an HTML 403 (issue #26)."""
    import http.client
    import struct
    import threading
    import zlib
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    limit = 24 * 1024
    seen = {"passed": [], "stopped": 0}
    (work / "big-notes.txt").write_text("".join(f"line {i:05d} of the long notes file\n" for i in range(1500)), encoding="utf-8")
    # a picture that does not shrink: noise, about 120 KB as PNG

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    noise = os.urandom(200 * 200 * 3)
    raw = b"".join(b"\x00" + noise[y * 600:(y + 1) * 600] for y in range(200))
    (work / "pic.png").write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 200, 200, 8, 2, 0, 0, 0))
                                   + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))

    class Gateway(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, *a):
            pass

        def go(self):
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            if len(body) > limit:
                seen["stopped"] += 1
                page = b"<html><head><title>Proxy Notification</title></head><body>blocked</body></html>"
                self.send_response(403)
                for k, v in (("Content-Type", "text/html"), ("Server", "gateway"), ("Content-Length", str(len(page)))):
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(page)
                return
            seen["passed"].append(len(body))
            conn = http.client.HTTPConnection("127.0.0.1", 8787, timeout=600)
            conn.request(self.command, self.path, body or None, {k: v for k, v in self.headers.items() if k.lower() != "host"})
            r = conn.getresponse()
            self.send_response(r.status)
            for k, v in r.getheaders():
                if k.lower() not in ("transfer-encoding", "connection", "content-length"):
                    self.send_header(k, v)
            self.end_headers()
            while part := r.read1(65536):
                self.wfile.write(part)
                self.wfile.flush()

        do_GET = do_POST = do_PUT = do_DELETE = go

    s = Stack(root, work, "agent")
    gw = ThreadingHTTPServer(("127.0.0.1", 8789), Gateway)
    threading.Thread(target=gw.serve_forever, daemon=True).start()
    try:
        env = {"FERRY_SERVER": "http://127.0.0.1:8789"}
        c1, o1 = s.ferry("-p", "GATESIZE: read the notes and the picture", env_extra=env)
        stopped = seen["stopped"]
        log = s.home / "logs" / "blocked.log"
        rows = [json.loads(x) for x in log.read_text(encoding="utf-8").splitlines()] if log.exists() else []
        big = max(seen["passed"], default=0)
        ok = (c1 == 0 and "picture received" in o1 and "notes=" in o1 and stopped >= 1 and 0 < big <= limit
              and rows and all(r["sent"] > limit and r["total"] >= r["sent"] and "images" in r for r in rows)
              and any(p > 100000 for p in [(work / "pic.png").stat().st_size]))
        c2, o2 = s.ferry("doctor", "--upload", env_extra=env)
        m = re.search(r"limit is about (\d+) KB", o2)
        ok2 = bool(m) and 16 <= int(m.group(1)) <= 24 and "chunkBytes" in o2
        check("F80 网关挡大请求时照样完成", ok and ok2,
              f"网关挡下 24 KB 以上的请求（403 网页）：大工具结果和一张图片照样发完，通过网关的请求最大 {big:,} 字节；被挡的 {stopped} 个请求按实际大小"
              "记进 blocked.log（第几块、整次大小、图片张数和字节数）；Ferry 自己把块减半后重发；doctor --upload 在 16 KB 和 64 KB 之间折半查找，"
              f"找到上限约 {m.group(1) if m else '?'} KB 并建议略小的 chunkBytes" if ok and ok2
              else f"run={ok} code={c1} stopped={stopped} biggest_passed={big} rows={rows[:2]} out={o1[-300:]!r} | doctor={ok2} code={c2} {o2[-500:]!r}")
    finally:
        gw.shutdown()
        gw.server_close()
        s.close()
        for n in ("big-notes.txt", "pic.png"):
            (work / n).unlink(missing_ok=True)


def check_v018(root: Path, work: Path) -> None:
    """One token per computer, global memory shared by them, the blocked sites list."""
    s = Stack(root, work, "agent")
    try:
        key = (s.data / "admin-key").read_text(encoding="utf-8").strip()
        admin = {"Cookie": f"ferry_admin={key}", "X-Ferry-Admin": "1", "Content-Type": "application/json"}
        _, d1 = s.http("POST", "/admin/api/devices", {"name": "laptop", "user": "wesley"}, headers=admin)
        _, d2 = s.http("POST", "/admin/api/devices", {"name": "home-pc", "user": "wesley"}, headers=admin)
        c1, o1 = s.ferry("-p", "TODOTEST: plan it", token=d1["token"])
        seen = [a for a in jsonl(s.data / "access.jsonl") if a.get("device") == "laptop"]
        s.http("DELETE", f"/admin/api/devices/{d1['id']}", headers=admin)
        c2, o2 = s.ferry("doctor", "--no-model", token=d1["token"])
        c3, o3 = s.ferry("doctor", "--no-model", token=d2["token"])
        ok = c1 == 0 and "TODO" in o1 and seen and c2 != 0 and "token rejected" in o2 and c3 == 0
        check("F55 每台电脑一个令牌", ok, "管理页给每台电脑加一个设备、各用各的令牌；作废一台，只有它连不上，别的照常"
              if ok else f"c1={c1} seen={len(seen)} c2={c2} c3={c3} {o1[-200:]} | {o2[-200:]}")

        s.http("PUT", "/admin/api/remote", {"shared_memory": True}, headers=admin)
        c4, o4 = s.ferry("-p", "GMEMTEST-SAVE remember that I drink tea")
        c5, o5 = s.ferry("-p", "GMEMTEST-RECALL what do I drink", token=d2["token"])
        c6, o6 = s.ferry("-p", "GMEMTEST-RECALL what do I drink", token=TOKEN_BOB)
        stored = list((s.data / "memory").glob("*/prefers-tea.md"))
        ok = (c4 == 0 and "GSAVED: Saved global memory" in o4 and c5 == 0 and "GINDEX HAS prefers-tea" in o5
              and "NO GLOBAL MEMORY" in o6 and len(stored) == 1 and not list((s.home / "memory").rglob("prefers-tea.md")))
        check("F56 全局记忆", ok, "一台电脑存进全局记忆（放在服务端），同一用户的另一台电脑下次对话就看得到；别的用户看不到"
              if ok else f"{o4[-200:]} | {o5[-200:]} | {o6[-120:]} | {stored}")

        s.home.mkdir(parents=True, exist_ok=True)
        (s.home / "config.json").write_text(json.dumps({"blockedSites": ["blocked.test"]}), encoding="utf-8")
        c8, o8 = s.ferry("-p", "BLOCKTEST: read my mail")
        (s.home / "config.json").unlink(missing_ok=True)
        check("F57 网站黑名单", c8 == 0 and "blocked sites list" in o8, "黑名单里的网站，web_fetch 拒绝打开"
              if c8 == 0 and "blocked sites list" in o8 else o8[-300:])
    finally:
        s.close()
        (work / "perm-ok.txt").unlink(missing_ok=True)


def check_install_update(root: Path) -> None:
    """ferry install, then ferry update against a fake GitHub "latest release" API serving a newer zip."""
    import http.server
    import threading
    import zipfile

    inst = ROOT / ".selftest-install"  # inside the repo so the installed client finds the repo's node_modules
    shutil.rmtree(inst, ignore_errors=True)
    bin_dir = root / "bin"
    root.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "FERRY_HOME": str(root / "home"), "FERRY_INSTALL_DIR": str(inst), "FERRY_BIN_DIR": str(bin_dir),
           "FERRY_CLIENT_ONLY": "1", "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost",
           "FERRY_UPDATE_URL": "http://127.0.0.1:9200/latest", "FERRY_NO_TOOL_DOWNLOAD": "1"}
    for k in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        env.pop(k, None)
    shim = [str(bin_dir / "ferry.cmd")] if WINDOWS else [str(bin_dir / "ferry")]

    def run(cmd):
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", env=env,
                           timeout=600, stdin=subprocess.DEVNULL, shell=False)
        return p.returncode, p.stdout + p.stderr

    # a newer release: same client, version 99.0.0 (a full package); then 99.0.1 with the same dependencies,
    # published as a small package as well, which is what the update should take
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    deps = {"node": "n-test", "python": "p-test", "tools": "t-test"}

    def package(version: str, small: bool) -> Path:
        zp = root / f"ferry-{'app' if small else 'windows'}-{version}.zip"
        with zipfile.ZipFile(zp, "w") as z:
            z.writestr(f"ferry-{version}/package.json", json.dumps({**pkg, "version": version}))
            z.writestr(f"ferry-{version}/deps.json", json.dumps({"version": version, **deps}))
            if small:
                z.writestr(f"ferry-{version}/small-package.json", "{}")
            for f in (ROOT / "client").rglob("*"):
                if f.is_file():
                    z.write(f, f"ferry-{version}/" + f.relative_to(ROOT).as_posix())
        return zp

    zpath = package("99.0.0", False)
    files = {"/latest": b"", "/zip": zpath.read_bytes(), "/full2": package("99.0.1", False).read_bytes(),
             "/app2": package("99.0.1", True).read_bytes(), "/deps2": json.dumps({"version": "99.0.1", **deps}).encode()}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = files.get(self.path)
            self.send_response(200 if body is not None else 404)
            self.end_headers()
            self.wfile.write(body or b"")

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 9200), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        c1, o1 = run([*FERRY, "install"])
        c2, v1 = run([*shim, "--version"])
        files["/latest"] = json.dumps({"tag_name": "v99.0.0", "assets": [
            {"name": zpath.name, "size": len(files["/zip"]), "browser_download_url": "http://127.0.0.1:9200/zip"}]}).encode()
        c3, o3 = run([*shim, "update"])
        c4, v2 = run([*shim, "--version"])
        c5, o5 = run([*shim, "update"])
        versions = sorted(p.name for p in (inst / "versions").iterdir()) if (inst / "versions").exists() else []
        # 99.0.1: the same dependencies, so only the small package is downloaded
        asset = lambda name, path: {"name": name, "size": len(files[path]), "browser_download_url": f"http://127.0.0.1:9200{path}"}
        files["/latest"] = json.dumps({"tag_name": "v99.0.1", "assets": [
            asset("ferry-windows-99.0.1.zip", "/full2"), asset("ferry-app-99.0.1.zip", "/app2"),
            asset("ferry-deps-99.0.1.json", "/deps2")]}).encode()
        c6, o6 = run([*shim, "update"])
        c7, v3 = run([*shim, "--version"])
        small_ok = c6 == 0 and "Downloading ferry-app-99.0.1.zip" in o6 and "Small package" in o6 and v3.strip() == "99.0.1"
        ok = (c1 == 0 and c2 == 0 and v1.strip() == pkg["version"] and "  server    " in o1 and c3 == 0 and "Updated from" in o3
              and c4 == 0 and v2.strip() == "99.0.0" and c5 == 0 and "is the latest version" in o5
              and versions == sorted([pkg["version"], "99.0.0"]) and small_ok)
        check("F24 安装与一键更新", ok, f"ferry install 后版本 {v1.strip()}；ferry update 从发布页下载新包后版本 "
              f"{v2.strip()}；再次 update 提示已是最新；保留版本 {versions}；依赖没变时只下载小包，更新到 {v3.strip()}")
        if not ok:
            print("\n".join(["--- install", o1, "--- update", o3, "--- update again", o5, "--- small update", o6]))
    finally:
        srv.shutdown()
        shutil.rmtree(inst, ignore_errors=True)


def part_basic(base: Path, work: Path) -> None:
    prompt = PROMPT
    print("\n[1/14] 基本流程：读文件、逐字流式、服务端规则、审计、参数适配、鉴权", flush=True)
    s = Stack(base / "basic", work, "basic")
    try:
        code, out = s.ferry("--mode", "json", "-p", prompt)
        events = [json.loads(l) for l in out.splitlines() if l.startswith("{")]
        deltas = [e["assistantMessageEvent"]["delta"] for e in events if e.get("type") == "message_update"
                  and e.get("assistantMessageEvent", {}).get("type") == "text_delta"]
        final = "".join(deltas)
        ups = jsonl(s.upstream)
        check("F7 读文件", code == 0 and len(ups) >= 2 and "internal-host-01" in final,
              "模型让客户端读文件，客户端读到并交回，回答里有文件内容" if "internal-host-01" in final else f"输出: {out[-300:]!r}")
        check("F8 逐字流式", len(deltas) >= 10, f"最后一轮回复分 {len(deltas)} 段到达客户端")
        sys0 = system_text(ups[0]) if ups else ""
        check("F9 服务端规则拼进提示词", "<server-rules>" in sys0 and "Project rule v1" in sys0
              and "Reply in the same language" in sys0, "通用规则和项目规则都在模型收到的系统提示里")
        (s.rules / "work.md").write_text("- Project rule v2: answer in bullet points.\n", encoding="utf-8")
        before = len(ups)
        s.ferry("-p", prompt)
        ups2 = jsonl(s.upstream)[before:]
        check("F10 规则改完下一轮生效", ups2 and "Project rule v2" in system_text(ups2[0])
              and "Project rule v1" not in system_text(ups2[0]), "改规则文件后不重启服务端，下一次请求即用新规则")
        logs = (s.data / "audit.jsonl").read_text(encoding="utf-8") + (s.data / "access.jsonl").read_text(encoding="utf-8")
        chats = [a for a in jsonl(s.data / "audit.jsonl") if a.get("event") == "chat"]
        check("F11 日志不含正文", chats and not any(x in logs for x in CONTENT + ["Project Titan", "FILE SAYS", "notes.txt"]),
              f"{len(chats)} 条模型调用记录，没有对话内容")
        check("F12 模型参数适配", ups and all("store" not in u and "max_completion_tokens" not in u
                                          and "max_tokens" in u and u["model"] == "deepseek-chat" for u in ups),
              "假模型拒收 store / max_completion_tokens，服务端已去掉或改名")
        code_bad, out_bad = s.ferry("doctor", token="wrong-token")
        code_ok, out_ok = s.ferry("doctor")
        code_run_bad, out_run_bad = s.ferry("-p", "hello", token="wrong-token")
        check("F13 鉴权", code_ok == 0 and "token accepted" in out_ok and code_bad != 0 and "token rejected" in out_bad
              and code_run_bad != 0 and "token" in out_run_bad.lower(),
              "正确令牌通过；错误令牌被拒，并提示重新 login")
    finally:
        s.close()


def part_long(base: Path, work: Path) -> None:
    prompt = PROMPT
    print(f"\n[2/14] 长会话：连续读取 {LONG_FILES} 个 {FILE_BYTES // 1024}KB 文件，触发上下文压缩，中途服务端丢一次会话", flush=True)
    cheap = ('\n[models.cheap]\nbase_url = "http://127.0.0.1:9100/v1"\napi_key_env = "DEEPSEEK_API_KEY"\n'
             'model = "cheap-model"\ncontext_window = 300000\nmax_tokens = 8192\ndrop_params = ["store"]\n'
             'rename_params = { max_completion_tokens = "max_tokens" }\n\n[routing]\ndefault = "main"\nsummary = "cheap"\n')
    s = Stack(base / "long", work, f"long:{LONG_FILES}", drop_every=22, context_window=300000, extra_toml=cheap)
    try:
        code, out = s.ferry("-p", "请按指示读取 data 目录下的文件")
        acc = jsonl(s.data / "access.jsonl")
        audit = jsonl(s.data / "audit.jsonl")
        ok_run = code == 0 and f"READ {LONG_FILES} FILES" in out
        sizes = [a["bytes"] for a in acc if a["status"] != 413]
        rejected = [a for a in acc if a["status"] == 413]
        forwards = [a["upstream_bytes"] for a in audit if a.get("event") == "chat"]
        uploaded = sum(a["bytes"] for a in acc if a["path"].startswith("/v1/ferry/"))
        ups = jsonl(s.upstream)
        biggest = max(ups, key=lambda u: len(json.dumps(u, ensure_ascii=False))) if ups else {}
        markers = len(set(re.findall(r"FILE-\d\d", json.dumps(biggest))))
        check("F1 每个请求 ≤ 1MB", ok_run and sizes and max(sizes) <= LIMIT and not rejected,
              f"客户端发出 {len(sizes)} 个请求，最大 {max(sizes or [0]):,} 字节，被拒 {len(rejected)} 次")
        check("F2 模型收到完整上下文", ok_run and forwards and max(forwards) > LIMIT and markers >= 20,
              f"模型收到的最大请求 {max(forwards or [0]):,} 字节，含 {markers} 个文件")
        ratio = uploaded / sum(forwards) if forwards else 1
        check("F3 只上传新增内容", ok_run and ratio < 0.25,
              f"实际上传 {uploaded:,} 字节；每轮全量重发需 {sum(forwards):,} 字节（{ratio:.1%}）")
        summaries = [u for u in ups if "context summarization assistant" in system_text(u)]
        check("F5 上下文压缩也不超限", ok_run and summaries and not rejected, f"压缩 {len(summaries)} 次，全部成功")
        big = [a for a in audit if a.get("event") == "commit" and a.get("parts", 0) >= 2]
        check("F14 超大内容分片上传", ok_run and big,
              f"服务端丢会话后全量重传 {max([a['upload_bytes'] for a in big] or [0]):,} 字节，"
              f"拆成 {max([a['parts'] for a in big] or [0])} 块")
        chats = [a for a in audit if a.get("event") == "chat"]
        by = lambda purpose: {a["model"] for a in chats if a.get("purpose") == purpose}
        offered = [m["id"] for m in json.loads((s.home / "models-cache.json").read_text(encoding="utf-8"))]
        up_models = {u.get("model") for u in ups}
        check("F25 服务端决定用哪个模型", ok_run and offered == ["auto"] and by("agent") == {"main"}
              and by("summary") == {"cheap"} and up_models == {"deepseek-chat", "cheap-model"},
              f"客户端只看到 {offered}；干活的请求走 main，写摘要的请求走 cheap")
    finally:
        s.close()


def part_nostore(base: Path, work: Path) -> None:
    prompt = PROMPT
    print("\n[3/14] 服务端不保存会话（session_store = none）", flush=True)
    s = Stack(base / "nostore", work, "long:4", session_store="none")
    try:
        code, out = s.ferry("-p", "请按指示读取 data 目录下的文件")
        commits = [a for a in jsonl(s.data / "audit.jsonl") if a.get("event") == "commit"]
        lost = [a for a in jsonl(s.data / "access.jsonl") if a["status"] == 409]
        sizes = [a["bytes"] for a in jsonl(s.data / "access.jsonl")]
        check("F26 服务端可以不保存会话", code == 0 and "READ 4 FILES" in out and len(commits) >= 5
              and all(a["base"] == 0 for a in commits) and not lost and not (s.data / "ferry.db").exists()
              and max(sizes) <= LIMIT,
              f"{len(commits)} 轮每轮都整段重传（单个请求最大 {max(sizes or [0]):,} 字节），服务端磁盘上没有会话库，任务完成")
    finally:
        s.close()


def part_drop(base: Path, work: Path) -> None:
    prompt = PROMPT
    print("\n[4/14] 服务端频繁丢失会话", flush=True)
    s = Stack(base / "drop", work, "long:8", drop_every=3)
    try:
        code, out = s.ferry("-p", "请按指示读取 data 目录下的文件")
        audit = jsonl(s.data / "audit.jsonl")
        drops = sum(1 for a in audit if a.get("event") == "test_drop")
        resyncs = sum(1 for a in audit if a.get("event") == "commit" and a.get("base") == 0)
        check("F4 丢失会话后自动恢复", code == 0 and "READ 8 FILES" in out and drops >= 2 and resyncs >= 3,
              f"服务端清空 {drops} 次，客户端全量重传 {resyncs} 次，任务{'完成' if 'READ 8 FILES' in out else '失败'}")
    finally:
        s.close()


def part_guard(base: Path, work: Path) -> None:
    prompt = PROMPT
    print("\n[5/14] 本地安全规则", flush=True)
    s = Stack(base / "guard", work, "basic")
    try:
        (s.home).mkdir(parents=True, exist_ok=True)
        (s.home / "config.json").write_text(json.dumps({"blockedPaths": ["titan"]}), encoding="utf-8")
        code, out = s.ferry("-p", prompt)
        up_text = s.upstream.read_text(encoding="utf-8")
        check("F15 禁止目录在客户端拦截", code == 0 and "not allowed by local policy" in out and "EMP" not in up_text,
              "读取被拦截，文件内容没有发出")
    finally:
        s.close()


def part_proxy(base: Path, work: Path) -> None:
    prompt = PROMPT
    print("\n[6/14] 经公司代理访问服务端", flush=True)
    s = Stack(base / "proxy", work, "basic", server_host="127.0.0.2")
    try:
        plog = s.root / "proxy.log"
        s.spawn([PY, "-I", str(ROOT / "selftest" / "fake_proxy.py"), str(plog), "8899"])
        time.sleep(1)
        # set by the config file, like a user on a company PC would; the machine's own proxy variables must lose
        (s.home).mkdir(parents=True, exist_ok=True)
        (s.home / "config.json").write_text(json.dumps({"proxy": "http://127.0.0.1:8899"}), encoding="utf-8")
        s.env.update({"NO_PROXY": "", "no_proxy": ""})
        code_d, out_d = s.ferry("doctor")
        code, out = s.ferry("-p", prompt)
        seen = plog.read_text(encoding="utf-8").splitlines() if plog.exists() else []
        via = [l for l in seen if "127.0.0.2:8787" in l]
        check("F16 经代理可用", code_d == 0 and code == 0 and "internal-host-01" in out and len(via) >= 3,
              f"doctor 和对话都成功，代理转发了 {len(via)} 次到服务端的连接")
    finally:
        s.close()


def part_gate(base: Path, work: Path) -> None:
    prompt = PROMPT
    print("\n[7/14] 服务端前面有登录页（像 Cloudflare Access）", flush=True)
    s = Stack(base / "gate", work, "long:2", server_env={"FERRY_TEST_REQUIRE_HEADER": "CF-Access-Client-Id"})
    try:
        code_b, out_b = s.ferry("doctor")
        code_l, out_l = s.ferry("login", s.base, TOKEN, "--header", "CF-Access-Client-Id: abc.access",
                                "--header", "CF-Access-Client-Secret: s3cret")
        code_d, out_d = s.ferry("doctor")
        code, out = s.ferry("-p", "请按指示读取 data 目录下的文件")
        check("F27 服务端前有登录页", code_b != 0 and "Cloudflare Access" in out_b and code_l == 0
              and code_d == 0 and code == 0 and "READ 2 FILES" in out,
              "没带凭据时 doctor 指出是登录页挡住了；ferry login --header 带上服务令牌后 doctor 和对话都成功")
        if not (code_d == 0 and code == 0):
            print(out_b[-800:], out_l[-800:], out_d[-800:], out[-800:])
    finally:
        s.close()


def part_chatdrop(base: Path, work: Path) -> None:
    prompt = PROMPT
    print("\n[8/14] 调用模型前一刻服务端丢了缓存", flush=True)
    s = Stack(base / "chatdrop", work, "long:6", drop_before_chat=2)
    try:
        code, out = s.ferry("-p", "请按指示读取 data 目录下的文件")
        acc = jsonl(s.data / "access.jsonl")
        lost = sum(1 for a in acc if a["path"] == "/v1/chat/completions" and a["status"] == 409)
        check("F17 调用模型时缓存丢失也能恢复", code == 0 and "READ 6 FILES" in out and lost >= 2,
              f"服务端 {lost} 次在调用模型前丢了缓存，客户端每次自动全量重传后继续，任务完成")
    finally:
        s.close()


def part_users(base: Path, work: Path) -> None:
    prompt = PROMPT
    print("\n[9/14] 多用户隔离、版本协商、弱密钥", flush=True)
    s = Stack(base / "users", work, "basic")
    try:
        code, out = s.ferry("-p", prompt)
        st_c, _ = s.http("POST", "/v1/ferry/commit?conv=shared&base=0&base_hash=",
                         json.dumps({"append": ["{}"], "tools": None}).encode(), token=TOKEN_BOB)
        st_x, _ = s.http("POST", "/v1/chat/completions",
                         {"model": "main", "stream": False, "ferry": {"conv": "shared", "count": 1,
                          "hash": __import__("hashlib").sha256(b"{}").hexdigest()}}, token=TOKEN)
        check("F18 用户之间相互隔离", code == 0 and st_c == 200 and st_x == 409, "别人的会话缓存读不到")
        st_p, body_p = s.http("GET", "/v1/ferry/models", headers={"x-ferry-protocol": "2"})
        check("F19 版本不一致时明确拒绝", st_p == 426 and "protocol" in json.dumps(body_p),
              f"协议版本 2 的客户端收到 HTTP {st_p}")
        weak = subprocess.run([PY, "-m", "ferry_server", "--config", str(s.config), "--port", "8788"],
                              env={**s.env, "FERRY_SECRET": "short"}, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=30)
        check("F20 拒绝弱密钥启动", weak.returncode != 0 and "16 characters" in weak.stderr,
              "密钥少于 16 个字符时服务端拒绝启动")
    finally:
        s.close()


def part_cap(base: Path, work: Path) -> None:
    prompt = PROMPT
    print("\n[10/14] 服务端压缩：发给模型的请求有上限", flush=True)
    s = Stack(base / "cap", work, f"long:{LONG_FILES}", context_window=1_000_000, max_upstream=400_000)
    try:
        code, out = s.ferry("-p", "请按指示读取 data 目录下的文件")
        ups = [len(json.dumps(u, ensure_ascii=False).encode()) for u in jsonl(s.upstream)]
        trimmed = sum(a.get("trimmed", 0) for a in jsonl(s.data / "audit.jsonl") if a.get("event") == "chat")
        check("F21 服务端压缩", code == 0 and f"READ {LONG_FILES} FILES" in out and ups and max(ups) <= 400_000
              and trimmed > 0, f"模型收到的最大请求 {max(ups or [0]):,} 字节（上限 400,000），服务端共删掉 {trimmed} 段旧输出，任务完成")
    finally:
        s.close()


def part_zero(base: Path, work: Path) -> None:
    prompt = PROMPT
    print("\n[11/14] 零配置：只设 DEEPSEEK_API_KEY，直接运行 ferry", flush=True)
    s = Stack(base / "zero", work, "long:3", start_server=False)
    try:
        code_d, out_d = s.ferry("doctor", local=True)
        code, out = s.ferry("-p", "请按指示读取 data 目录下的文件", local=True)
        log = (s.home / "server.log").read_text(encoding="utf-8", errors="replace") if (s.home / "server.log").exists() else ""
        ports = re.findall(r"started by ferry .* on port (\d+)", log)
        still_up = []
        for port in ports:  # every server a ferry window started must stop when that window exits
            for _ in range(20):
                try:
                    DIRECT.open(f"http://127.0.0.1:{port}/health", timeout=1)
                    time.sleep(0.5)
                except Exception:
                    break
            else:
                still_up.append(port)
        check("F22 零配置自动启动", code_d == 0 and code == 0 and "READ 3 FILES" in out and len(ports) == 2
              and not still_up and (s.root / "zero-config-home" / "secret").exists()
              and not (s.root / "zero-config-home" / "data" / "ferry.db").exists(),
              f"没有登录、没有配置文件：ferry 每次自己启动本机服务端（端口 {', '.join(ports)}），对话完成，退出后服务端随之关闭")
        nokey = {k: v for k, v in s.env.items() if k != "DEEPSEEK_API_KEY"}
        s.env = nokey
        code_k, out_k = s.ferry("doctor", local=True)
        check("F23 缺少 API Key 时明确提示", code_k != 0 and "DEEPSEEK_API_KEY" in out_k, "doctor 指出要设置 DEEPSEEK_API_KEY")
    finally:
        s.close()


def check_side(root: Path, work: Path) -> None:
    """Side questions to the server: the advisor tool, /btw while the agent works, the recap of a long request."""
    strong = ('\n[models.strong]\nbase_url = "http://127.0.0.1:9100/v1"\napi_key_env = "DEEPSEEK_API_KEY"\nmodel = "strong-model"\n'
              'drop_params = ["store"]\nrename_params = { max_completion_tokens = "max_tokens" }\nprice = { input = 15, output = 75 }\n'
              '\n[routing]\ndefault = "main"\nadvisor = "strong"\n')
    s = Stack(root / "advisor", work, "agent", extra_toml=strong)
    try:
        c1, o1 = s.ferry("-p", "ADVISETEST: finish the plan")
        calls = jsonl(s.upstream)
        asked = [b for b in calls if b.get("model") == "strong-model"]
        convo = json.dumps(asked[0]["messages"], ensure_ascii=False) if asked else ""
        first = json.dumps(calls[0]["messages"][0], ensure_ascii=False) if calls else ""
        audit = jsonl(s.data / "audit.jsonl")
        ok = (c1 == 0 and len(asked) == 1 and "ADVICE saw_request=True saw_work=True question=True" in o1
              and "save the file before you finish" in o1 and "tools" not in asked[0]
              and "# The advisor" in first and "# Documents, decks and reports" in first and "agent review" in first
              and any(a.get("purpose") == "advise" and a.get("status") == 200 for a in audit))
        check("F83 顾问和交付前检查", ok, "服务端有顾问模型时，agent 多一个 advisor 工具：服务端用对话里的内容（含前面的工具结果）问顾问模型，不带工具，"
              "建议原样作为工具结果回到 agent；调用记录里标为 advise；系统提示里有顾问用法、交付质量和 review 子 agent 的说明" if ok
              else f"code={c1} asked={len(asked)} out={o1[-300:]!r} convo={convo[-200:]!r}")
    finally:
        s.close()
    if WINDOWS:
        print("  SKIP  F84 /btw、F85 回顾（Windows 上没有伪终端，Linux 上检查）")
        return
    import pty
    import select

    def terminal(stack):
        env = {**stack.env, "FERRY_SERVER": stack.base, "FERRY_TOKEN": TOKEN, "TERM": "xterm-256color", "COLUMNS": "140", "LINES": "40",
               "FERRY_AUTO_APPROVE": "1"}
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(work)
            os.execvpe(NODE, [NODE, str(ROOT / "client" / "bin" / "ferry.mjs")], env)
        seen = [b""]
        plain = lambda b: re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-B]|[\r]", "",  # noqa: E731
                                 b.decode("utf-8", "replace"))

        def wait_for(text: str, secs: float) -> bool:
            end = time.time() + secs
            while time.time() < end:
                r, _, _ = select.select([fd], [], [], 0.2)
                if r:
                    try:
                        seen[0] += os.read(fd, 65536)
                    except OSError:
                        return False
                if text in plain(seen[0]):
                    return True
            return False

        def typed(text: bytes) -> None:
            os.write(fd, text)
            time.sleep(0.4)
            os.write(fd, b"\r")

        def stop() -> None:
            for _ in range(2):
                os.write(fd, b"\x03")
                time.sleep(0.3)
            try:
                os.kill(pid, signal.SIGTERM)
                os.waitpid(pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass
        return wait_for, typed, stop, lambda: plain(seen[0])

    # /btw while a slow command runs: the answer shows up before the command ends and the question never reaches the history
    s = Stack(root / "btw", work, "agent")
    try:
        wait_for, typed, stop, screen = terminal(s)
        started = wait_for("shift+tab", 60)
        typed(b"BTWTEST: run the slow command")
        running = wait_for("sleep 8", 20)
        typed(b"/btw why is it slow today")
        answered = wait_for("BTW ANSWER: you asked why is it slow today saw_request=True", 20)
        early = "BTWFINISHED" not in screen()
        finished = wait_for("BTWFINISHED saw_btw=False", 40)
        stop()
        ok = started and running and answered and early and finished
        check("F84 /btw 旁问", ok, "agent 在跑一条慢命令时输入 /btw 提问：答案在命令结束前就显示出来（服务端用对话内容回答，不带工具），"
              "agent 照常做完；这个问题和答案没有进对话（模型之后收到的消息里没有它）" if ok
              else f"started={started} running={running} answered={answered} early={early} finished={finished} {screen()[-400:]!r}")
    finally:
        s.close()

    # a request longer than phoneAfterSeconds: the recap is in the phone notification and on the status line
    s = Stack(root / "recap", work, "agent", server_env={"FERRY_BARK_URL": "http://127.0.0.1:9100/bark"})
    try:
        s.home.mkdir(parents=True, exist_ok=True)
        (s.home / "config.json").write_text(json.dumps({"phoneAfterSeconds": 1}), encoding="utf-8")
        wait_for, typed, stop, screen = terminal(s)
        started = wait_for("shift+tab", 60)
        typed(b"RECAPTEST: do the long thing")
        done = wait_for("RECAPFINISHED", 40)
        shown = wait_for("recap: RECAP: Building the deck for the review", 25)
        time.sleep(1)
        barks = [u for u in jsonl(s.upstream) if u.get("group") == "Ferry"]
        stop()
        ok = started and done and shown and any("Building the deck for the review" in b.get("body", "") for b in barks)
        check("F85 做完推一句话回顾", ok, "一个超过 phoneAfterSeconds 的请求做完后：服务端用最便宜的模型写一两句回顾，"
              "手机通知的正文是这句话（不是\"after N min\"），终端状态栏也显示" if ok
              else f"started={started} done={done} shown={shown} barks={barks} {screen()[-300:]!r}")
    finally:
        s.close()


def check_watchdog(root: Path, work: Path) -> None:
    """A run that goes quiet half-way: the server tells the phone itself. Beats keep a long command quiet."""
    s = Stack(root, work, "agent", server_env={"FERRY_BARK_URL": "http://127.0.0.1:9100/bark",
                                               "FERRY_TEST_STALL_SECONDS": "3", "FERRY_TEST_WATCHDOG_TICK": "0.5"})
    try:
        def barks(title: str) -> list[dict]:
            return [u for u in jsonl(s.upstream) if u.get("group") == "Ferry" and u.get("title") == title]

        # no beats while the 6-second command runs: like a computer behind the gateway, asleep or off the network
        c1, o1 = s.ferry("-p", "WATCHDOGTEST: run the long build", env_extra={"FERRY_TEST_HEARTBEAT_MS": "600000"})
        time.sleep(1)
        stalled, back = barks("Ferry 停了"), barks("Ferry 又连上了")
        c2, o2 = s.ferry("-p", "WATCHDOGTEST: run it again", env_extra={"FERRY_TEST_HEARTBEAT_MS": "1000"})
        time.sleep(4)  # past the threshold after the run: an end the server missed would show up now
        quiet = len(barks("Ferry 停了")) == len(stalled) and len(barks("Ferry 又连上了")) == len(back)
        ok = (c1 == 0 and "WATCHDOGFINISHED" in o1 and len(stalled) == 1 and len(back) == 1
              and "网关要确认" in stalled[0].get("body", "") and work.name in stalled[0].get("body", "")
              and c2 == 0 and "WATCHDOGFINISHED" in o2 and quiet)
        check("F112 跑到一半没了消息，服务端推手机", ok, "agent 跑一条比阈值长的命令、客户端不发心跳：服务端推了一条“Ferry 停了”"
              "（写着项目和可能的原因），回来后推一条“Ferry 又连上了”；每秒发心跳的同一条命令一条都没推" if ok
              else f"c1={c1} c2={c2} stalled={stalled} back={back} quiet={quiet} | {o1[-200:]} | {o2[-200:]}")
    finally:
        s.close()


def check_phone_remote(root: Path, work: Path) -> None:
    """Answering from the phone: the page a Bark push opens answers an approval and a question while the terminal
    waits. And subagents of one task_batch do not write the same file."""
    s = Stack(root / "batch", work, "agent")
    shared = work / "batch-shared.txt"
    shared.unlink(missing_ok=True)
    try:
        c, out = s.ferry("-p", "PARWRITE: both items write one file")
        wrote = re.findall(r"ITEM (one|two): Successfully wrote", out)
        refused = re.findall(r"ITEM (one|two): [^|]*?batch-shared\.txt is being changed by subagent #[\d.]+ general", out)
        ok = (c == 0 and len(wrote) == 1 and len(refused) == 1 and wrote != refused and shared.exists()
              and shared.read_text(encoding="utf-8").strip() == wrote[0])
        check("F115 批量子 agent 不抢同一个文件", ok, "task_batch 里两个子 agent 都要写同一个文件：先写的那个写成，另一个被拒，"
              "理由里写着文件正被哪个子 agent 改、让它在报告里说" if ok else f"code={c} wrote={wrote} refused={refused} {out[-500:]!r}")
    finally:
        s.close()
        shared.unlink(missing_ok=True)
    if WINDOWS:
        print("  SKIP  F113 手机上批准、F114 手机上回答（Windows 上没有伪终端，Linux 上检查）")
        return
    import pty
    import select

    s = Stack(root / "phone", work, "agent", server_env={"FERRY_BARK_URL": "http://127.0.0.1:9100/bark",
                                                         "FERRY_PUBLIC_URL": "http://127.0.0.1:8787"})
    old = work / "phone-old.txt"
    old.write_text("made before ferry started\n", encoding="utf-8")  # so deleting it asks, even in full access
    seen = b""
    pid = 0
    try:
        s.home.mkdir(parents=True, exist_ok=True)
        (s.home / "config.json").write_text(json.dumps({"phoneApprovalSeconds": 1}), encoding="utf-8")
        env = {**s.env, "FERRY_SERVER": s.base, "FERRY_TOKEN": TOKEN, "TERM": "xterm-256color", "COLUMNS": "140", "LINES": "40"}
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(work)
            os.execvpe(NODE, [NODE, str(ROOT / "client" / "bin" / "ferry.mjs")], env)
        plain = lambda b: re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-B]|[\r]", "",  # noqa: E731
                                 b.decode("utf-8", "replace"))

        def wait_for(text: str, secs: float, since: int = 0) -> bool:
            nonlocal seen
            end = time.time() + secs
            while time.time() < end:
                r, _, _ = select.select([fd], [], [], 0.2)
                if r:
                    try:
                        seen += os.read(fd, 65536)
                    except OSError:
                        return False
                if text in plain(seen[since:]):
                    return True
            return False

        def typed(text: bytes) -> None:
            os.write(fd, text)
            time.sleep(0.4)
            os.write(fd, b"\r")

        def push(n: int) -> dict:
            """The n-th Bark push that carries a link (the terminal is read meanwhile)."""
            end = time.time() + 20
            while time.time() < end:
                try:
                    links = [u for u in jsonl(s.upstream) if u.get("group") == "Ferry" and u.get("url")]
                except ValueError:  # a line being written
                    links = []
                if len(links) >= n:
                    return links[n - 1]
                wait_for("\0", 0.3)
            return {}

        def page(url: str, form: dict | None = None) -> tuple[int, str]:
            data = urllib.parse.urlencode(form).encode() if form is not None else None
            try:
                with DIRECT.open(urllib.request.Request(url, data=data, method="POST" if data else "GET"), timeout=30) as r:
                    return r.status, r.read().decode("utf-8")
            except urllib.error.HTTPError as e:
                return e.code, e.read().decode("utf-8")

        started = wait_for("shift+tab", 60)
        typed(b"PHONEAPPROVAL: remove the old file")
        asked = wait_for("Allow bash?", 30)
        p = push(1)
        url = p.get("url", "")
        code, first = page(url) if url else (0, "")
        shown = (code == 200 and url.startswith("http://127.0.0.1:8787/m/") and "rm phone-old.txt" in first
                 and "小心" in first and "等你批准 bash" in p.get("body", ""))
        _, again = page(url, {"action": "once"}) if url else (0, "")
        second = "再点一次确认" in again and old.exists()
        _, confirmed = page(url, {"action": "once", "confirm": "1"}) if url else (0, "")
        noticed = wait_for("Answered on the phone: Allow once", 20)
        done = wait_for("PHONEAPPROVED: removed-by-phone", 30) and not old.exists()
        used = "已处理" in confirmed and "已处理" in (page(url)[1] if url else "")
        ok = started and asked and shown and second and noticed and done and used
        check("F113 手机上批准", ok, "终端里等批准时，服务端推的 Bark 带着链接；手机页面写着命令和风险，有风险的要再点一次确认；"
              "点了以后终端的确认框关掉、写一行“在手机上答了”，命令照常执行；链接用过一次就显示已处理" if ok
              else f"started={started} asked={asked} shown={shown} second={second} noticed={noticed} done={done} used={used} "
                   f"push={p} {plain(seen)[-500:]!r}")

        wait_for("\0", 1)  # the first request settles, so the next message is not taken as a remark while it works
        mark = len(seen)
        typed(b"PHONEQUESTION: pick a format")
        asked = wait_for("Which format for the phone?", 30, mark)
        url = push(2).get("url", "")
        code, form = page(url) if url else (0, "")
        shown = code == 200 and "Which format for the phone?" in form and "PPT（推荐）" in form
        _, sent = page(url, {"a0": "Word"}) if url else (0, "")
        noticed = wait_for("Answered on the phone", 20, mark)
        done = wait_for("PHONEANSWER:", 30, mark) and "-> Word" in plain(seen[mark:])
        ok = asked and shown and "已处理" in sent and noticed and done
        check("F114 手机上回答提问", ok, "agent 用 ask_user 提问时，手机页面列出选项（推荐的在前）；点一个选项，"
              "终端里的问题关掉，agent 收到这个回答" if ok
              else f"asked={asked} shown={shown} sent={'已处理' in sent} noticed={noticed} done={done} {plain(seen[mark:])[-500:]!r}")
    finally:
        if pid:  # keep reading while ferry quits: on macOS a full terminal buffer blocks its writes
            for _ in range(2):
                os.write(fd, b"\x03")
                wait_for("\0", 0.3)
            try:
                os.kill(pid, signal.SIGTERM)
                for _ in range(50):
                    if os.waitpid(pid, os.WNOHANG)[0]:
                        break
                    wait_for("\0", 0.1)
                else:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass
        s.close()
        old.unlink(missing_ok=True)


def check_phone_console(root: Path, work: Path) -> None:
    """The phone console: the page /phone pushes shows a running session (goal, to-do, steps) and steers it, pauses its
    goal and gives it a new task when idle; with remoteTasks off a task is refused."""
    if WINDOWS:
        print("  SKIP  F116–F119 手机控制台（Windows 上没有伪终端，Linux 上检查）")
        return
    import pty
    import select

    s = Stack(root, work, "agent", server_env={"FERRY_BARK_URL": "http://127.0.0.1:9100/bark",
                                               "FERRY_PUBLIC_URL": "http://127.0.0.1:8787"})
    runs: list[dict] = []
    plain = lambda b: re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-B]|[\r]", "",  # noqa: E731
                             b.decode("utf-8", "replace"))

    def start(config: dict) -> dict:
        s.home.mkdir(parents=True, exist_ok=True)
        (s.home / "config.json").write_text(json.dumps(config), encoding="utf-8")
        env = {**s.env, "FERRY_SERVER": s.base, "FERRY_TOKEN": TOKEN, "TERM": "xterm-256color", "COLUMNS": "140", "LINES": "40"}
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(work)
            os.execvpe(NODE, [NODE, str(ROOT / "client" / "bin" / "ferry.mjs")], env)
        t = {"pid": pid, "fd": fd, "seen": b""}
        runs.append(t)
        return t

    def wait_for(t: dict, text: str, secs: float, since: int = 0) -> bool:
        end = time.time() + secs
        while time.time() < end:
            r, _, _ = select.select([t["fd"]], [], [], 0.2)
            if r:
                try:
                    t["seen"] += os.read(t["fd"], 65536)
                except OSError:
                    return False
            if text in plain(t["seen"][since:]):
                return True
        return False

    def typed(t: dict, text: bytes) -> None:
        os.write(t["fd"], text)
        time.sleep(0.4)
        os.write(t["fd"], b"\r")

    def stop(t: dict) -> None:
        if not t["pid"]:
            return
        for _ in range(2):  # keep reading while ferry quits: on macOS a full terminal buffer blocks its writes
            os.write(t["fd"], b"\x03")
            wait_for(t, "\0", 0.3)
        try:
            os.kill(t["pid"], signal.SIGTERM)
            for _ in range(50):
                if os.waitpid(t["pid"], os.WNOHANG)[0]:
                    break
                wait_for(t, "\0", 0.1)
            else:
                os.kill(t["pid"], signal.SIGKILL)
                os.waitpid(t["pid"], 0)
        except (ProcessLookupError, ChildProcessError):
            pass
        t["pid"] = 0

    def console_push(t: dict, n: int) -> str:
        """The address in the n-th Bark push that opens a console."""
        end = time.time() + 20
        while time.time() < end:
            try:
                urls = [u["url"] for u in jsonl(s.upstream) if u.get("group") == "Ferry" and "/m/c_" in u.get("url", "")]
            except ValueError:  # a line being written
                urls = []
            if len(urls) >= n:
                return urls[n - 1]
            wait_for(t, "\0", 0.3)
        return ""

    def page(url: str, form: dict | None = None) -> tuple[int, str]:
        data = urllib.parse.urlencode(form).encode() if form is not None else None
        try:
            with DIRECT.open(urllib.request.Request(url, data=data, method="POST" if data else "GET"), timeout=30) as r:
                return r.status, r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8")

    def until(t: dict, url: str, words: list[str], secs: float) -> str:
        """The console page once it shows every word (opened every 3 s: the page allows 30 a minute)."""
        text, end = "", time.time() + secs
        while url and time.time() < end:
            text = page(url)[1]
            if all(w in text for w in words):
                return text
            wait_for(t, "\0", 3)
        return text

    def model_saw(text: str) -> bool:
        for _ in range(3):
            try:
                return any(m.get("role") == "user" and text in json.dumps(m.get("content"), ensure_ascii=False)
                           for b in jsonl(s.upstream) for m in (b.get("messages") or []) if isinstance(m, dict))
            except ValueError:  # a line being written
                time.sleep(0.3)
        return False

    try:
        t = start({})
        started = wait_for(t, "shift+tab", 60)
        typed(t, b"/phone")
        url = console_push(t, 1)
        printed = wait_for(t, "Sent to your phone", 10)
        idle = until(t, url, ["空闲", "开始干"], 20)
        _, sent = page(url, {"cmd": "task", "text": "PHONETASK write the summary"}) if url else (0, "")
        ran = wait_for(t, "PHONETASKDONE PHONETASK write the summary", 30)
        task_ok = (started and url.startswith("http://127.0.0.1:8787/m/c_") and printed and "开始干" in idle
                   and "已发出新活" in sent and ran and model_saw("(from your phone) PHONETASK write the summary"))
        task_why = f"started={started} url={url!r} printed={printed} idle={'开始干' in idle} sent={'已发出新活' in sent} ran={ran}"

        wait_for(t, "\0", 1)
        typed(t, b"/goal PHONECONSOLE keep the console busy")
        busy = until(t, url, ["在干活", "PHONECONSOLE keep the console busy", "进行中", "▶ console step one", "○ console step two",
                              "bash (sleep 2; echo CONSOLEWORK)", "发送插话", "暂停目标"], 40)
        ok = "bash (sleep 2; echo CONSOLEWORK)" in busy and "value=task" not in busy and "value=resume" not in busy
        check("F116 手机控制台看到正在干的活", ok, "/goal 跑着时，/phone 推的控制台页面写着在干活、目标和轮数、待办（▶ 正在做的）、"
              "最近几步的命令，给插话和暂停目标两个操作，没有派新活" if ok else f"page={busy[-1500:]!r} {plain(t['seen'])[-400:]!r}")

        mark = len(t["seen"])
        _, sent = page(url, {"cmd": "steer", "text": "PHONESTEER use the short names"}) if url else (0, "")
        seen = wait_for(t, "PHONESTEERSEEN PHONESTEER use the short names", 30, mark)
        told = until(t, url, ["插话已送到"], 20)
        ok = "已发出插话" in sent and seen and model_saw("(from your phone) PHONESTEER use the short names") and "插话已送到" in told
        check("F117 手机上插话", ok, "控制台发的插话在下一步作为用户消息到了模型，开头写着 (from your phone)，"
              "页面随后显示插话已送到" if ok else f"sent={'已发出插话' in sent} seen={seen} told={'插话已送到' in told} "
                                             f"{plain(t['seen'][mark:])[-500:]!r}")

        _, sent = page(url, {"cmd": "pause"}) if url else (0, "")
        paused = wait_for(t, "goal paused", 20, mark)  # the status line
        after = until(t, url, ["空闲", "已暂停", "继续目标"], 40)
        ok = "已发出暂停目标" in sent and paused and "value=resume" in after and "value=pause" not in after
        check("F118 手机上暂停目标", ok, "控制台点暂停目标：电脑上 /goal 暂停（状态栏 goal paused），当前这一步做完就停；"
              "页面变成空闲、目标已暂停，给继续目标" if ok else f"sent={'已发出暂停目标' in sent} paused={paused} "
                                                     f"page={after[-1200:]!r} {plain(t['seen'][mark:])[-400:]!r}")
        stop(t)

        t = start({"remoteTasks": False})
        started = wait_for(t, "shift+tab", 60)
        typed(t, b"/phone")
        url = console_push(t, 2)
        view = until(t, url, ["空闲", "remoteTasks"], 20)
        _, refused = page(url, {"cmd": "task", "text": "PHONETASK not this one"}) if url else (0, "")
        wait_for(t, "\0", 3)
        off_ok = (started and "remoteTasks" in view and "value=task" not in view and "现在不能这样做" in refused
                  and not model_saw("PHONETASK not this one"))
        ok = task_ok and off_ok
        check("F119 手机上派新活", ok, "空闲时控制台派的新活开始执行，模型收到的用户消息开头写着 (from your phone)；"
              "remoteTasks 关掉时页面不给派活，硬发也被拒，模型什么都没收到" if ok
              else f"{task_why} off: started={started} view={view[-600:]!r} refused={'现在不能这样做' in refused}")
    finally:
        for t in runs:
            stop(t)
        s.close()


# Every step of the run: (function, folder under the log dir; "" for the part_* steps, which name their own). The F numbers a step checks are read from
# its source, so `--only F7,F66` runs just the steps that contain those checks and nothing else.
STEPS = [
    (part_basic, ""), (part_long, ""), (part_nostore, ""), (part_drop, ""),
    (part_guard, ""), (part_proxy, ""), (part_gate, ""), (part_chatdrop, ""),
    (part_users, ""), (part_cap, ""), (part_zero, ""),
    (check_agent_features, "agent"), (check_goal_todo, "goaltodo"), (check_memory_overwrite, "memow"),
    (check_memory_review, "memrev"), (check_memory_distill, "distill"), (check_web_browser, "web"), (check_gateway, "gateway"),
    (check_resume_upload, "resume"), (check_v016, "v016"), (check_context_and_mcp, "ctx"), (check_compact_mid_run, "compact"),
    (check_project_mcp, "pmcp"), (check_tui, "tui"), (check_steer, "steer"), (check_plan_switch, "plan"), (check_team, "team"),
    (check_v019, "v019"), (check_v022, "v022"), (check_prompt_rules, "rules"), (check_v023, "v023"),
    (check_diy, "diy"), (check_claude_goal_jobs, "claude"), (check_v018, "v018"), (check_office_legacy, "oldoffice"), (check_word_tracked, "wordtracked"),
    (check_install_update, "install"), (check_search_502, "search502"), (check_upload_delete, "updel"),
    (check_upload_size, "upsize"), (check_side, "side"), (check_server_models_only, "srvmodels"),
    (check_watchdog, "watchdog"), (check_phone_remote, "remote"), (check_phone_console, "console"),
]


def step_checks(fn) -> list[str]:
    return re.findall(r'check\("(F\d+)', inspect.getsource(fn))


def main() -> int:
    ap = argparse.ArgumentParser(description="Ferry end-to-end self-test (fake model, no API key)")
    ap.add_argument("--only", default="", help="comma-separated F numbers, e.g. F7,F66: run only the steps with those checks")
    ap.add_argument("--list", action="store_true", help="list the steps and the F checks in each, then exit")
    args = ap.parse_args()
    if args.list:
        for fn, folder in STEPS:
            print(f"{fn.__name__:28} {' '.join(step_checks(fn))}")
        return 0
    wanted = {f.strip().upper() for f in args.only.split(",") if f.strip()}
    known = {f for fn, _ in STEPS for f in step_checks(fn)}
    if wanted - known:
        print(f"no such check: {', '.join(sorted(wanted - known))} (see --list)")
        return 2
    steps = [(fn, folder) for fn, folder in STEPS if not wanted or wanted & set(step_checks(fn))]
    base = Path(tempfile.mkdtemp(prefix="ferry-selftest-"))
    work = make_work(base / "work")
    print(f"logs: {base}")
    for fn, folder in steps:
        if not fn.__name__.startswith("part_"):
            print(f"\n[{fn.__name__}]", flush=True)
        if len(inspect.signature(fn).parameters) == 2:
            fn(base / folder, work)
        else:
            fn(base / folder)

    failed = [r for r in results if not r[1]]
    print(f"\n结果: {len(results) - len(failed)}/{len(results)} 通过" + (f"，日志在 {base}" if failed else ""))
    if not failed:
        shutil.rmtree(base, ignore_errors=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
