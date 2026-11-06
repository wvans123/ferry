"""A noisy test runner (colours, a progress bar, 1200 "ok" lines) hides one real failure; fix the code, not the tests."""
import subprocess
import sys
from pathlib import Path

TITLE = "在满屏输出里找到唯一的失败"
PROMPT = ("运行 python run_tests.py，有测试没通过。找到原因修好代码（不要改 run_tests.py 和 test_cases.py），"
          "再跑一遍确认全部通过。")
TIMEOUT = 600
NETWORK = False

CODE = '''"""Durations like "1h30m" or "2d" in seconds."""
import re

UNITS = {"s": 1, "m": 60, "h": 60 * 60, "d": 24 * 60}
PART = re.compile(r"(\\d+)([smhd])")


def parse_duration(text):
    text = text.strip().lower()
    if not text or PART.sub("", text):
        raise ValueError(f"not a duration: {text!r}")
    return sum(int(n) * UNITS[u] for n, u in PART.findall(text))
'''

RUNNER = '''"""Runs every case in test_cases.py and prints a line for each, like a CI log."""
import sys
import time

from durations import parse_duration
from test_cases import CASES

GREEN, RED, DIM, BOLD, RESET = "\\x1b[32m", "\\x1b[31m", "\\x1b[2m", "\\x1b[1m", "\\x1b[0m"


def bar(i, n):
    done = 30 * i // n
    return f"\\r{DIM}[{'#' * done}{'.' * (30 - done)}] {i}/{n}{RESET}"


def main():
    failed = 0
    t0 = time.time()
    print(f"{BOLD}collected {len(CASES)} cases{RESET}")
    for i, (text, want) in enumerate(CASES, 1):
        sys.stdout.write(bar(i, len(CASES)))
        try:
            got = parse_duration(text)
        except Exception as e:  # noqa: BLE001
            got = f"{type(e).__name__}: {e}"
        if got == want:
            sys.stdout.write(f"\\n  {GREEN}ok{RESET}\\n")
        else:
            failed += 1
            sys.stdout.write(f"\\n  {RED}FAIL parse_duration({text!r}) returned {got!r}, expected {want!r}{RESET}\\n")
    print(f"\\n{BOLD}{len(CASES) - failed} passed, {failed} failed in {time.time() - t0:.2f}s{RESET}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
'''


def cases() -> list[tuple[str, int]]:
    out = []
    for i in range(1200):
        h, m, s = i % 5, (i * 7) % 60, (i * 13) % 60
        text = "".join(f"{v}{u}" for v, u in ((h, "h"), (m, "m"), (s, "s")) if v) or "0s"
        out.append((text, h * 3600 + m * 60 + s))
    out.insert(613, ("2d", 2 * 86400))
    return out


def cases_py() -> str:
    return "CASES = [\n" + "".join(f"    {c!r},\n" for c in cases()) + "]\n"


def setup(work: Path) -> None:
    (work / "durations.py").write_text(CODE, encoding="utf-8")
    (work / "run_tests.py").write_text(RUNNER, encoding="utf-8")
    (work / "test_cases.py").write_text(cases_py(), encoding="utf-8")


def check(work: Path, answer: str) -> tuple[bool, str]:
    for name, want in (("run_tests.py", RUNNER), ("test_cases.py", cases_py())):
        if (work / name).read_text(encoding="utf-8").replace("\r\n", "\n") != want:
            return False, f"{name} was changed"
    r = subprocess.run([sys.executable, "run_tests.py"], cwd=work, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        return False, "run_tests.py still fails"
    probe = ("from durations import parse_duration as p; "
             "assert p('3d') == 259200 and p('1d2h') == 93600 and p('90m') == 5400, 'days still wrong'")
    r = subprocess.run([sys.executable, "-c", probe], cwd=work, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        return False, "the tests pass but other day values are still wrong (special-cased?)"
    return True, "the day unit fixed, all 1201 cases pass"


def solve(work: Path) -> str:
    p = work / "durations.py"
    p.write_text(p.read_text(encoding="utf-8").replace('"d": 24 * 60}', '"d": 24 * 60 * 60}'), encoding="utf-8")
    return "A day was 24 * 60 seconds; it is 86400."
