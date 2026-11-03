"""A unit test fails; find the bug and fix the code, not the test."""
import subprocess
import sys
from pathlib import Path

TITLE = "修一个让测试失败的 bug"
PROMPT = "运行 python -m unittest 会有一个测试失败。找到原因，修好代码（不要改测试文件），再跑一遍测试确认通过。"
TIMEOUT = 600
NETWORK = False

CODE = '''def total(items, discount=0):
    """Sum of price * qty over (price, qty) pairs, the discount (0.1 = 10 %) taken off, rounded to cents."""
    s = 0
    for price, qty in items[1:]:
        s += price * qty
    return round(s * (1 - discount), 2)
'''
TEST = '''import unittest

from pricing import total


class TotalTest(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(total([(10, 2), (5, 1)]), 25)

    def test_discount(self):
        self.assertEqual(total([(100, 1)], discount=0.1), 90)

    def test_empty(self):
        self.assertEqual(total([]), 0)


if __name__ == "__main__":
    unittest.main()
'''


def setup(work: Path) -> None:
    (work / "pricing.py").write_text(CODE, encoding="utf-8")
    (work / "test_pricing.py").write_text(TEST, encoding="utf-8")


def check(work: Path, answer: str) -> tuple[bool, str]:
    # read as text: on Windows the file was written with CRLF line ends, which is not a change
    if (work / "test_pricing.py").read_text(encoding="utf-8").replace("\r\n", "\n") != TEST:
        return False, "the test file was changed"
    r = subprocess.run([sys.executable, "-m", "unittest", "-q"], cwd=work, capture_output=True, text=True, timeout=60)
    return r.returncode == 0, "tests pass" if r.returncode == 0 else "tests still fail: " + r.stderr.strip().splitlines()[-1]


def solve(work: Path) -> str:
    p = work / "pricing.py"
    p.write_text(p.read_text(encoding="utf-8").replace("items[1:]", "items"), encoding="utf-8")
    return "The loop skipped the first item; fixed."
