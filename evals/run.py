"""Real-model evals: run Ferry on everyday tasks and measure what it gets right, how many steps and what it costs.

The end-to-end self-test (selftest/run.py) uses a fake model and proves the plumbing works. This runs a real model
(by default the DeepSeek key in DEEPSEEK_API_KEY) on tasks with a known right result, so two versions of Ferry, or
two models, can be compared before a release.

    python evals/run.py                     all tasks, the Ferry in this folder (npm ci once)
    python evals/run.py --only fix_bug,explore --repeat 3
    python evals/run.py --skip-network      leave out tasks that need the internet
    python evals/run.py --model deepseek-v4-pro             another DeepSeek model
    python evals/run.py --provider claude                   ANTHROPIC_API_KEY and Claude's default model
    python evals/run.py --ferry D:\\ferry\\app\\client\\bin\\ferry.mjs    an installed Ferry instead
    python evals/run.py --verify            check the checks: apply each task's reference answer, no model

Each task runs in its own folder under evals/runs/, with its own FERRY_HOME and a Ferry server started for the run
(its own FERRY_SERVER_HOME, so your real server and settings are not touched), in full-access mode. Results go to
evals/results/<date>-<version>.json and are compared with the previous file.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TASKS = HERE / "tasks"
RESULTS = HERE / "results"
RUNS = HERE / "runs"


def load_tasks(only: list[str]) -> list:
    out = []
    for f in sorted(TASKS.glob("*.py")):
        if only and f.stem not in only:
            continue
        spec = importlib.util.spec_from_file_location(f"eval_{f.stem}", f)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod.ID = f.stem
        out.append(mod)
    missing = set(only) - {t.ID for t in out}
    if missing:
        sys.exit(f"no such task: {', '.join(sorted(missing))} (see {TASKS})")
    return out


def usage(home: Path) -> dict:
    """Totals over the conversation files Ferry wrote, like /cost: model calls, tokens, money."""
    t = {"calls": 0, "input": 0, "output": 0, "cache_read": 0, "cost": 0.0}
    for f in (home / "agent").rglob("*.jsonl"):
        for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            m = e.get("message") if e.get("type") == "message" else None
            u = (m or {}).get("usage")
            if not u or m.get("role") not in ("assistant", "toolResult"):
                continue
            t["input"] += u.get("input") or 0
            t["output"] += u.get("output") or 0
            t["cache_read"] += u.get("cacheRead") or 0
            t["cost"] += (u.get("cost") or {}).get("total") or 0
            if m.get("role") == "assistant":
                t["calls"] += 1
    t["cost"] = round(t["cost"], 4)
    return t


def kill_tree(p: subprocess.Popen) -> None:
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True)
        else:
            os.killpg(p.pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        pass


def run_one(task, ferry: list[str], base: Path, server_home: Path, env: dict) -> dict:
    work, home = base / "project", base / "home"
    work.mkdir(parents=True)
    home.mkdir(parents=True)
    task.setup(work)
    (home / "config.json").write_text(json.dumps({
        "permissionMode": "bypass", "updateCheck": False, "notify": False, "phoneNotify": False}), encoding="utf-8")
    env = {**env, "FERRY_HOME": str(home), "FERRY_SERVER_HOME": str(server_home), "PYTHONUTF8": "1"}
    for k in ("FERRY_SERVER", "FERRY_TOKEN"):
        env.pop(k, None)
    t0 = time.time()
    out = (base / "answer.txt").open("w", encoding="utf-8")
    err = (base / "ferry.log").open("w", encoding="utf-8")
    p = subprocess.Popen([*ferry, "-p", task.PROMPT], cwd=work, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                         start_new_session=os.name != "nt")
    try:
        code = p.wait(timeout=task.TIMEOUT)
    except subprocess.TimeoutExpired:
        kill_tree(p)
        code = "timeout"
    out.close()
    err.close()
    seconds = round(time.time() - t0)
    answer = (base / "answer.txt").read_text(encoding="utf-8", errors="replace")
    try:
        ok, note = task.check(work, answer)
    except Exception as e:  # noqa: BLE001 - a crashing check is a failed task, with the reason
        ok, note = False, f"check failed: {type(e).__name__}: {e}"
    if code == "timeout":
        ok, note = False, f"timed out after {task.TIMEOUT} s; {note}"
    return {"task": task.ID, "ok": bool(ok), "note": note, "seconds": seconds, "exit": code, **usage(home)}


def ferry_version(ferry: list[str]) -> str:
    try:
        r = subprocess.run([*ferry, "--version"], capture_output=True, text=True, timeout=60)
        return (r.stdout.strip().split() or ["?"])[-1] if r.returncode == 0 else "?"
    except (OSError, subprocess.TimeoutExpired):
        return "?"


def summarize(rows: list[dict]) -> dict:
    by: dict[str, dict] = {}
    for r in rows:
        s = by.setdefault(r["task"], {"runs": 0, "passed": 0, "seconds": 0, "calls": 0, "tokens": 0, "cost": 0.0, "notes": []})
        s["runs"] += 1
        s["passed"] += r["ok"]
        for k in ("seconds", "calls", "cost"):
            s[k] += r[k]
        s["tokens"] += r["input"] + r["output"] + r["cache_read"]
        s["notes"].append(r["note"])
    for s in by.values():
        n = s["runs"]
        s["seconds"], s["calls"], s["cost"] = round(s["seconds"] / n), round(s["calls"] / n, 1), round(s["cost"] / n, 4)
        s["tokens"] = round(s["tokens"] / n)
    return by


def previous(exclude: Path) -> dict | None:
    files = sorted(f for f in RESULTS.glob("*.json") if f != exclude)
    return json.loads(files[-1].read_text(encoding="utf-8")) if files else None


def show(result: dict, before: dict | None) -> None:
    old = (before or {}).get("tasks", {})
    print(f"\nFerry {result['ferry']} · model {result['model']} · {result['date']}"
          + (f"   (compared with {before['ferry']} on {before['date']})" if before else ""))
    print(f"{'task':<16}{'passed':>8}{'time s':>8}{'calls':>7}{'k tok':>8}{'cost $':>9}   note")
    for tid, s in result["tasks"].items():
        o = old.get(tid)
        delta = ""
        if o:
            d_pass = s["passed"] / s["runs"] - o["passed"] / o["runs"]
            delta = (f"  [{'+' if d_pass > 0 else ''}{d_pass:+.0%} pass" if d_pass else "  [same pass") + \
                    f", calls {s['calls'] - o['calls']:+.1f}, k tok {(s['tokens'] - o.get('tokens', 0)) / 1000:+.0f}]"
        print(f"{tid:<16}{s['passed']}/{s['runs']:<6}{s['seconds']:>8}{s['calls']:>7}{s['tokens'] / 1000:>8.0f}{s['cost']:>9.4f}   "
              f"{s['notes'][-1][:60]}{delta}")
    t = result["total"]
    print(f"{'all':<16}{t['passed']}/{t['runs']:<6}{t['seconds']:>8}{'':>7}{t['tokens'] / 1000:>8.0f}{t['cost']:>9.4f}")


def verify(tasks, base: Path) -> int:
    bad = 0
    for t in tasks:
        work = base / t.ID
        work.mkdir(parents=True)
        t.setup(work)
        before, _ = t.check(work, "")
        answer = t.solve(work)
        after, note = t.check(work, answer)
        good = after and not before
        bad += not good
        print(f"{'ok ' if good else 'BAD'} {t.ID:<16} untouched: {'passes (too easy?)' if before else 'fails'}; "
              f"reference answer: {'passes' if after else 'fails'} ({note})")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", default="", help="comma-separated task ids (file names in evals/tasks)")
    ap.add_argument("--repeat", type=int, default=1, help="run each task this many times (models vary)")
    ap.add_argument("--skip-network", action="store_true", help="leave out tasks that need the internet")
    ap.add_argument("--provider", default="deepseek", choices=["deepseek", "claude", "openai"],
                    help="whose key and model the run's server uses (default deepseek: DEEPSEEK_API_KEY)")
    ap.add_argument("--model", default="", help="model name at that provider (default: Ferry's default for it)")
    ap.add_argument("--ferry", default=str(ROOT / "client" / "bin" / "ferry.mjs"), help="ferry.mjs to test")
    ap.add_argument("--verify", action="store_true", help="check the checks with each task's reference answer")
    ap.add_argument("--keep", action="store_true", help="keep the task folders of passed tasks too")
    a = ap.parse_args()

    tasks = load_tasks([x.strip() for x in a.only.split(",") if x.strip()])
    if a.skip_network:
        tasks = [t for t in tasks if not t.NETWORK]
    stamp = time.strftime("%Y%m%d-%H%M%S")
    base = RUNS / stamp
    if a.verify:
        return verify(tasks, base)

    key = {"deepseek": "DEEPSEEK_API_KEY", "claude": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY"}[a.provider]
    if not os.environ.get(key):
        sys.exit(f"set {key} first")
    ferry = [shutil.which("node") or "node", a.ferry]
    if not Path(a.ferry).exists():
        sys.exit(f"{a.ferry} not found; run npm ci in {ROOT}, or pass --ferry")
    env = {**os.environ, "FERRY_MODEL": a.provider}
    if a.model:
        env[f"FERRY_{a.provider.upper()}_MODEL"] = a.model
    server_home = base / "server"
    server_home.mkdir(parents=True)
    version = ferry_version(ferry)
    rows = []
    for t in tasks:
        for i in range(a.repeat):
            print(f"[{len(rows) + 1}/{len(tasks) * a.repeat}] {t.ID}: {t.TITLE} ...", end=" ", flush=True)
            r = run_one(t, ferry, base / f"{t.ID}-{i + 1}", server_home, env)
            print(f"{'PASS' if r['ok'] else 'FAIL'} {r['seconds']} s, {r['calls']} calls, {r['cost']:.4f}: {r['note']}",
                  flush=True)
            rows.append(r)
            if r["ok"] and not a.keep:
                shutil.rmtree(base / f"{t.ID}-{i + 1}" / "project", ignore_errors=True)
    by = summarize(rows)
    result = {"date": stamp, "ferry": version, "model": f"{a.provider} {a.model or '(default model)'}", "os": sys.platform,
              "tasks": by, "runs": rows,
              "total": {"runs": len(rows), "passed": sum(r["ok"] for r in rows), "seconds": sum(r["seconds"] for r in rows),
                        "tokens": sum(r["input"] + r["output"] + r["cache_read"] for r in rows),
                        "cost": round(sum(r["cost"] for r in rows), 4)}}
    RESULTS.mkdir(exist_ok=True)
    out = RESULTS / f"{stamp}-{version}.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    show(result, previous(out))
    print(f"\nSaved {out}. Failed tasks keep their folder (answer.txt, ferry.log, project/) in {base}.")
    return 0 if result["total"]["passed"] == result["total"]["runs"] else 1


if __name__ == "__main__":
    sys.exit(main())
