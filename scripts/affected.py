#!/usr/bin/env python3
"""Pick the tests a change touches, print them, and (with --run) run them.

    python scripts/affected.py --base origin/main          # show the plan
    python scripts/affected.py --base origin/main --run    # run it (do this before pushing)
    python scripts/affected.py --all --run                 # everything, as CI does on main

CI calls the same command with the pull request's base, so a local run and CI run the same tests.
The change is the working tree (and untracked files) against the merge base of --base and HEAD.

Rules:
  client/lib/<x>.mjs            -> client/test/<x>*.test.mjs that exist; a changed test file -> itself
  server/ferry_server/<x>.*     -> server/tests/test_<x>*.py that exist; a changed test file -> itself
  selftest/run.py               -> the self-test steps whose code changed (--only F...), plus F numbers added
                                   in GOAL.md; code outside the steps (helpers, Stack) -> the whole self-test
  selftest/fake_llm.py, fake_*  -> the whole self-test (the fake model serves every step)
  core files (CORE below)       -> all unit tests
  other code with no mapping    -> all unit tests of its side (client/ or server/), both when it has no side
  docs only                     -> nothing
"""
from __future__ import annotations

import argparse
import ast
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# shared files where guessing the affected module is unsafe: any change runs all unit tests
CORE_FILES = {
    "client/bin/ferry.mjs", "client/lib/sync.mjs", "client/lib/config.mjs",
    "server/ferry_server/app.py", "server/ferry_server/config.py", "server/ferry_server/store.py",
    "package.json", "package-lock.json", "server/pyproject.toml",
}
CORE_PREFIXES = ("scripts/", ".github/workflows/")

ALL_SERVER = [sys.executable, "-m", "pytest", "-q", "server/tests"]
ALL_CLIENT = ["node", "--test", "client/test/*.test.mjs"]
ALL_SELFTEST = [sys.executable, "selftest/run.py"]


def git(*args: str, check: bool = True) -> str:
    r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    if check and r.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout


def is_docs(path: str) -> bool:
    # same rule as the docs-only shortcut in ci.yml: docs/, eval results, top-level .md files
    return path.startswith(("docs/", "evals/results/")) or bool(re.fullmatch(r"[^/]+\.md", path))


def changed_files(base: str) -> tuple[str, list[str]]:
    mb = git("merge-base", base, "HEAD", check=False).strip() or base
    files = set(git("diff", "--name-only", "--no-renames", mb).split())
    files |= set(git("ls-files", "--others", "--exclude-standard").split())
    return mb, sorted(files)


def hunks(mb: str, path: str) -> list[tuple[int, int]]:
    """New-side line ranges (start, end) changed in `path`; a pure deletion becomes the two lines around it."""
    out = []
    for m in re.finditer(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", git("diff", "-U0", "--no-renames", mb, "--", path), re.M):
        start, count = int(m.group(1)), int(m.group(2) if m.group(2) is not None else 1)
        out.append((start, start + count - 1) if count else (start, start + 1))
    return out


def selftest_steps(path: Path) -> tuple[dict[str, tuple[int, int, list[str]]], tuple[int, int] | None]:
    """{step function: (first line, last line, F numbers it checks)} and the line range of the STEPS list."""
    src = path.read_text(encoding="utf-8")
    tree = ast.parse(src)
    lines = src.splitlines()
    names: set[str] = set()
    steps_range = None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "STEPS" for t in node.targets):
            steps_range = (node.lineno, node.end_lineno)
            names = {n.id for n in ast.walk(node.value) if isinstance(n, ast.Name)}
    steps = {}
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            first = min([node.lineno] + [d.lineno for d in node.decorator_list])
            body = "\n".join(lines[first - 1:node.end_lineno])
            steps[node.name] = (first, node.end_lineno, re.findall(r'check\("(F\d+)', body))
    return steps, steps_range


def selftest_selection(mb: str, files: list[str], notes: list[str]) -> tuple[bool, list[str]]:
    """(whole self-test?, F numbers to run with --only)."""
    run_py = ROOT / "selftest" / "run.py"
    steps, steps_range = selftest_steps(run_py)
    known = {f for _, _, fs in steps.values() for f in fs}
    fnums: list[str] = []
    whole = False
    if any(f.startswith("selftest/") and f != "selftest/run.py" and f.endswith(".py") for f in files):
        whole = True
        notes.append("selftest helper (fake model, proxy, ...) changed: the whole self-test")
    if "selftest/run.py" in files:
        for lo, hi in hunks(mb, "selftest/run.py"):
            lines = run_py.read_text(encoding="utf-8").splitlines()
            covered: set[int] = set()
            for name, (a, b, fs) in steps.items():
                if a <= hi and lo <= b:
                    covered.update(range(a, b + 1))
                    if fs:
                        fnums += fs
                        notes.append(f"selftest/run.py lines {lo}-{hi} are in {name}: {' '.join(fs)}")
                    else:
                        whole = True
                        notes.append(f"{name} checks no F number, so --only cannot pick it: the whole self-test")
            if steps_range and steps_range[0] <= hi and lo <= steps_range[1]:
                covered.update(range(steps_range[0], steps_range[1] + 1))
            for n in range(lo, hi + 1):
                text = lines[n - 1].strip() if 0 < n <= len(lines) else ""
                if n not in covered and text and not text.startswith("#"):
                    whole = True
                    notes.append(f"selftest/run.py line {n} is shared code outside the steps: the whole self-test")
                    break
    if "GOAL.md" in files:
        added = re.findall(r"^\+\|\s*(F\d+)\s*\|", git("diff", "-U0", "--no-renames", mb, "--", "GOAL.md"), re.M)
        for f in added:
            if f in known:
                fnums.append(f)
                notes.append(f"{f} added or changed in GOAL.md")
            else:
                notes.append(f"{f} is in GOAL.md but no step checks it yet (ignored)")
    return whole, sorted(set(fnums), key=lambda f: int(f[1:]))


def plan(mb: str, files: list[str]) -> dict:
    notes: list[str] = []
    client_tests: set[str] = set()
    server_tests: set[str] = set()
    all_client = all_server = False
    evals = False

    def exists(pattern: str, folder: str) -> list[str]:
        return sorted(p.relative_to(ROOT).as_posix() for p in (ROOT / folder).glob(pattern))

    for f in files:
        if is_docs(f) or f.startswith("selftest/") or f == "GOAL.md":
            continue
        if f in CORE_FILES or f.startswith(CORE_PREFIXES):
            all_client = all_server = True
            notes.append(f"{f}: core file, all unit tests")
            continue
        if f.startswith("evals/"):
            evals = True
            continue
        p = Path(f)
        if f.startswith("client/test/") and f.endswith(".test.mjs") and p.parent.as_posix() == "client/test":
            if (ROOT / f).exists():
                client_tests.add(f)
            continue
        if f.startswith("client/lib/") and p.suffix == ".mjs":
            found = exists(f"{p.stem}*.test.mjs", "client/test")
            if found:
                client_tests.update(found)
                continue
        if f.startswith("server/tests/test_") and p.suffix == ".py" and p.parent.as_posix() == "server/tests":
            if (ROOT / f).exists():
                server_tests.add(f)
            continue
        if f.startswith("server/ferry_server/"):
            found = exists(f"test_{p.stem}*.py", "server/tests")
            if found:
                server_tests.update(found)
                continue
        if f.startswith("client/"):
            all_client = True
            notes.append(f"{f}: no test mapping, all client tests")
        elif f.startswith("server/"):
            all_server = True
            notes.append(f"{f}: no test mapping, all server tests")
        else:
            all_client = all_server = True
            notes.append(f"{f}: no test mapping and no side, all unit tests")
    whole, fnums = selftest_selection(mb, files, notes)

    commands: list[list[str]] = []
    if all_server:
        commands.append(ALL_SERVER)
    elif server_tests:
        commands.append([sys.executable, "-m", "pytest", "-q", *sorted(server_tests)])
    if all_client:
        commands.append(ALL_CLIENT)
    elif client_tests:
        commands.append(["node", "--test", *sorted(client_tests)])
    if whole:
        commands.append(ALL_SELFTEST)
    elif fnums:
        commands.append([sys.executable, "selftest/run.py", "--only", ",".join(fnums)])
    if evals:
        commands.append([sys.executable, "evals/run.py", "--verify"])
        notes.append("evals/ changed: evals/run.py --verify")
    return {"commands": commands, "notes": notes}


def show(cmd: list[str]) -> str:
    return " ".join(("python" if c == sys.executable else (f'"{c}"' if "*" in c else c)) for c in cmd)


def main() -> int:
    ap = argparse.ArgumentParser(description="Pick and run the tests a change touches")
    ap.add_argument("--base", default="origin/main", help="the branch the change is compared with (default origin/main)")
    ap.add_argument("--all", action="store_true", help="ignore the diff: all unit tests and the whole self-test")
    ap.add_argument("--run", action="store_true", help="run the commands (default: only print them)")
    args = ap.parse_args()

    if args.all:
        commands = [ALL_SERVER, ALL_CLIENT, ALL_SELFTEST]
        print("everything")
    else:
        mb, files = changed_files(args.base)
        print(f"base {args.base} (merge base {mb[:10]}), {len(files)} changed files")
        p = plan(mb, files)
        commands = p["commands"]
        for n in p["notes"]:
            print(f"  - {n}")
        if not commands:
            print("nothing to run (docs only, or no code changed)")
            return 0
    for c in commands:
        print(f"  $ {show(c)}")
    if not args.run:
        return 0
    failed = []
    for c in commands:
        print(f"\n+ {show(c)}", flush=True)
        if subprocess.run(c, cwd=ROOT).returncode != 0:
            failed.append(show(c))
    if failed:
        print("\nFAILED:\n  " + "\n  ".join(failed))
        return 1
    print("\nall passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
