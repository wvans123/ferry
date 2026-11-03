"""Rename a function everywhere it is used, then run the tests."""
import re
import subprocess
import sys
from pathlib import Path

TITLE = "跨文件改函数名"
PROMPT = "把函数 calc_total 改名为 compute_total，所有用到它的地方一起改，改完跑测试（python -m unittest discover -s tests -t .）确认通过。"
TIMEOUT = 600
NETWORK = False

FILES = {
    "orders/__init__.py": "",
    "orders/calc.py": "def calc_total(lines):\n    return sum(qty * price for qty, price in lines)\n\n\n"
                      "def calc_tax(amount, rate=0.13):\n    return round(amount * rate, 2)\n",
    "orders/report.py": "from orders.calc import calc_tax, calc_total\n\n\ndef report(lines):\n"
                        "    t = calc_total(lines)\n    return f\"total {t}, tax {calc_tax(t)}\"\n",
    "app.py": "from orders import calc\nfrom orders.report import report\n\n\ndef main():\n"
              "    lines = [(2, 10), (1, 5)]\n    print(calc.calc_total(lines))\n    print(report(lines))\n\n\n"
              "if __name__ == \"__main__\":\n    main()\n",
    "tests/__init__.py": "",
    "tests/test_calc.py": "import unittest\n\nfrom orders.calc import calc_total\nfrom orders.report import report\n\n\n"
                          "class T(unittest.TestCase):\n    def test_total(self):\n        self.assertEqual(calc_total([(2, 10), (1, 5)]), 25)\n\n"
                          "    def test_report(self):\n        self.assertEqual(report([(1, 100)]), \"total 100, tax 13.0\")\n",
}


def setup(work: Path) -> None:
    for name, text in FILES.items():
        (work / name).parent.mkdir(parents=True, exist_ok=True)
        (work / name).write_text(text, encoding="utf-8")


def check(work: Path, answer: str) -> tuple[bool, str]:
    left = [str(p.relative_to(work)) for p in work.rglob("*.py") if "calc_total" in p.read_text(encoding="utf-8")]
    if left:
        return False, "calc_total still in " + ", ".join(left)
    if not re.search(r"def compute_total\(", (work / "orders/calc.py").read_text(encoding="utf-8")):
        return False, "no def compute_total in orders/calc.py"
    r = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."], cwd=work,
                       capture_output=True, text=True, timeout=60)
    return r.returncode == 0, "renamed, tests pass" if r.returncode == 0 else "tests fail after the rename"


def solve(work: Path) -> str:
    for p in work.rglob("*.py"):
        p.write_text(p.read_text(encoding="utf-8").replace("calc_total", "compute_total"), encoding="utf-8")
    return "Renamed."
