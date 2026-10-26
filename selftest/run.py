"""Ferry end-to-end self-test: starts a fake model, the Ferry server and the Ferry client, and checks every item
in GOAL.md. Exit code 0 only when all pass. No real model or API key needed; everything listens on 127.0.0.1.

usage: python selftest/run.py          (needs: node + `npm install` in client/, `pip install -e server/`)
"""
from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
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
SENSITIVE = ["Project Titan", "internal-host-01", "10.1.2.3", "bob@corp.example", "EMP-12345"]
LONG_FILES, FILE_BYTES = 36, 45 * 1024
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
        shutil.copy(ROOT / "server" / "dictionary.example.toml", srv / "dictionary.toml")
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
        self.env = {**os.environ, "FERRY_SECRET": SECRET, "FERRY_TOKEN_WESLEY": TOKEN, "FERRY_TOKEN_BOB": TOKEN_BOB,
                    "DEEPSEEK_API_KEY": "x", "FERRY_TEST_DROP_EVERY": str(drop_every), "FERRY_HOME": str(self.home),
                    "FERRY_TEST_DROP_BEFORE_CHAT": str(drop_before_chat), "FERRY_AUTO_APPROVE": "1",
                    "FERRY_SERVER_HOME": str(root / "zero-config-home"), "FERRY_PYTHON": PY,
                    "FERRY_UPSTREAM_BASE_URL": "http://127.0.0.1:9100/v1"}
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

        c4, o4 = s.ferry("-p", "BIGTEST: print a long output")
        saved = list((s.home / "outputs").rglob("bash-*.txt"))
        lines = saved[0].read_text(encoding="utf-8").count("\n") if saved else 0
        size = re.search(r"size=(\d+)", o4)
        check("F30 长输出写文件", c4 == 0 and "saved=True" in o4 and "last=True" in o4 and size and int(size.group(1)) < 9000
              and lines >= 2999, f"3000 行输出全文存到客户端文件；模型只收到开头、结尾和路径，约 {size.group(1) if size else '?'} 字符")

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


def find_browser() -> str:
    """A Chrome/Chromium/Edge for the browser test, or "" (the test is then skipped)."""
    cands = [os.environ.get("FERRY_TEST_BROWSER", ""), r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
             r"C:\Program Files\Google\Chrome\Application\chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"]
    cands += sorted(str(p) for p in Path("/opt/pw-browsers").glob("chromium-*/chrome-linux*/chrome")) if Path("/opt/pw-browsers").exists() else []
    return next((c for c in cands if c and Path(c).exists()), "")


def check_web_browser(root: Path, work: Path) -> None:
    s = Stack(root, work, "agent", server_env={"FERRY_WEB": "0"})
    try:
        c0, o0 = s.ferry("-p", "WEBTEST: look it up")
        off_ok = c0 == 0 and "web_search" not in json.dumps(jsonl(s.upstream)[-1].get("tools", []))
        code, status = s.http("POST", "/v1/ferry/web/fetch", {"url": "http://example.com"})
        refused = code == 403 and "switched off" in json.dumps(status)
    finally:
        s.close()
    s = Stack(root.parent / (root.name + "-on"), work, "agent", server_env={
        "FERRY_WEB": "1", "FERRY_TEST_WEB_LOCAL": "1", "FERRY_TEST_SEARCH_BASE": "http://127.0.0.1:9100"})
    try:
        c1, o1 = s.ferry("-p", "WEBTEST: look it up")
        web = [a for a in jsonl(s.data / "audit.jsonl") if a.get("event") == "web"]
        check("F35 联网由服务端代办", off_ok and refused and c1 == 0 and "pelican-42" in o1
              and [a.get("kind") for a in web] == ["search", "fetch"],
              "关闭时工作电脑看不到联网工具、接口拒绝；打开后搜索和读网页都由服务端完成，调用记录里有两条联网记录")
        browser = find_browser()
        if not browser:
            print("  SKIP  F36 浏览器（这台机器上没有 Chrome / Edge）")
            return
        s.home.mkdir(parents=True, exist_ok=True)
        root = hasattr(os, "geteuid") and os.geteuid() == 0
        extra = ["--no-sandbox"] if root or os.environ.get("CI") else []  # CI and root: no Chrome sandbox
        (s.home / "config.json").write_text(json.dumps({"browser": True, "browserHeadless": True,
                                                        "browserPath": browser, "browserArgs": extra}), encoding="utf-8")
        c2, o2 = s.ferry("-p", "BROWSERTEST: open the page", timeout=300)
        check("F36 浏览器", c2 == 0 and "BROWSER: pelican-42" in o2,
              f"agent 用本机浏览器（{Path(browser).name}）打开测试页面，读到页面内容" if "pelican-42" in o2 else o2[-400:])
    finally:
        s.close()


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

    # a newer release: same client, version 99.0.0
    zpath = root / "ferry-windows-99.0.0.zip"
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    with zipfile.ZipFile(zpath, "w") as z:
        z.writestr("ferry-99.0.0/package.json", json.dumps({**pkg, "version": "99.0.0"}))
        for f in (ROOT / "client").rglob("*"):
            if f.is_file():
                z.write(f, "ferry-99.0.0/" + f.relative_to(ROOT).as_posix())
    files = {"/latest": b"", "/zip": zpath.read_bytes()}

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
        ok = (c1 == 0 and c2 == 0 and v1.strip() == pkg["version"] and c3 == 0 and "Updated from" in o3
              and c4 == 0 and v2.strip() == "99.0.0" and c5 == 0 and "is the latest version" in o5
              and versions == sorted([pkg["version"], "99.0.0"]))
        check("F24 安装与一键更新", ok, f"ferry install 后版本 {v1.strip()}；ferry update 从发布页下载新包后版本 "
              f"{v2.strip()}；再次 update 提示已是最新；保留版本 {versions}")
        if not ok:
            print("\n".join(["--- install", o1, "--- update", o3, "--- update again", o5]))
    finally:
        srv.shutdown()
        shutil.rmtree(inst, ignore_errors=True)


def main() -> int:
    base = Path(tempfile.mkdtemp(prefix="ferry-selftest-"))
    work = make_work(base / "work")
    print(f"logs: {base}")
    prompt = "请读取 Project Titan 目录下的 notes.txt 并告诉我内容"

    print("\n[1/14] 基本流程：读文件、脱敏、逐字流式、服务端规则、审计、参数适配、鉴权", flush=True)
    s = Stack(base / "basic", work, "basic")
    try:
        code, out = s.ferry("--mode", "json", "-p", prompt)
        events = [json.loads(l) for l in out.splitlines() if l.startswith("{")]
        deltas = [e["assistantMessageEvent"]["delta"] for e in events if e.get("type") == "message_update"
                  and e.get("assistantMessageEvent", {}).get("type") == "text_delta"]
        final = "".join(deltas)
        ups = jsonl(s.upstream)
        up_text = s.upstream.read_text(encoding="utf-8") if s.upstream.exists() else ""
        leaks = sum(up_text.count(x) for x in SENSITIVE)
        check("F6 敏感词不外泄", code == 0 and len(ups) >= 2 and leaks == 0,
              f"模型收到 {len(ups)} 个请求，原文出现 {leaks} 次")
        check("F7 工具调用还原", "internal-host-01" in final and "10.1.2.3" in final and "FERRY-" not in final,
              "模型用占位符下指令，客户端读到真实文件并显示原文" if "internal-host-01" in final else f"输出: {out[-300:]!r}")
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
        check("F11 审计日志不含正文", chats and all(a.get("masked") for a in chats[1:2]) and
              not any(x in logs for x in SENSITIVE + ["FILE SAYS", "notes.txt"]),
              f"{len(chats)} 条模型调用记录，有脱敏计数，没有对话内容")
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
        leaks = sum(s.upstream.read_text(encoding="utf-8").count(x) for x in SENSITIVE)
        check("F6b 长会话也不外泄", leaks == 0, f"原文出现 {leaks} 次")
        chats = [a for a in audit if a.get("event") == "chat"]
        by = lambda purpose: {a["model"] for a in chats if a.get("purpose") == purpose}
        offered = [m["id"] for m in json.loads((s.home / "models-cache.json").read_text(encoding="utf-8"))]
        up_models = {u.get("model") for u in ups}
        check("F25 服务端决定用哪个模型", ok_run and offered == ["auto"] and by("agent") == {"main"}
              and by("summary") == {"cheap"} and up_models == {"deepseek-chat", "cheap-model"},
              f"客户端只看到 {offered}；干活的请求走 main，写摘要的请求走 cheap")
    finally:
        s.close()

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

    print("\n[9/14] 多用户隔离、版本协商、弱密钥", flush=True)
    s = Stack(base / "users", work, "basic")
    try:
        code, out = s.ferry("-p", prompt)  # wesley sends "Project Titan" once, so wesley owns its placeholder
        first_user = [m for m in jsonl(s.upstream)[0]["messages"] if m["role"] == "user"][0]
        ph = re.search(r"\[FERRY-[A-Z2-7]{8}\]", json.dumps(first_user, ensure_ascii=False)).group(0)
        ask = {"model": "main", "stream": False, "messages": [{"role": "user", "content": f"open {ph}"}]}
        _, as_bob = s.http("POST", "/v1/chat/completions", ask, token=TOKEN_BOB)
        _, as_wes = s.http("POST", "/v1/chat/completions", ask, token=TOKEN)
        arg = lambda r: r["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
        st_c, _ = s.http("POST", "/v1/ferry/commit?conv=shared&base=0&base_hash=",
                         json.dumps({"append": ["{}"], "tools": None}).encode(), token=TOKEN_BOB)
        st_x, _ = s.http("POST", "/v1/chat/completions",
                         {"model": "main", "stream": False, "ferry": {"conv": "shared", "count": 1,
                          "hash": __import__("hashlib").sha256(b"{}").hexdigest()}}, token=TOKEN)
        check("F18 用户之间相互隔离", code == 0 and ph in arg(as_bob) and "Project Titan" in arg(as_wes)
              and st_c == 200 and st_x == 409,
              "别人的占位符还原不出原文；别人的会话缓存也读不到")
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

    print("\n[12/14] 客户端 agent：记忆、子 agent、长输出、任务清单、权限、系统提示、中文路径", flush=True)
    check_agent_features(base / "agent", work)

    print("\n[13/14] 联网（服务端代办）和浏览器", flush=True)
    check_web_browser(base / "web", work)

    print("\n[14/14] 安装与从 GitHub 更新（用本机模拟的发布页）", flush=True)
    check_install_update(base / "install")

    failed = [r for r in results if not r[1]]
    print(f"\n结果: {len(results) - len(failed)}/{len(results)} 通过" + (f"，日志在 {base}" if failed else ""))
    if not failed:
        shutil.rmtree(base, ignore_errors=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
