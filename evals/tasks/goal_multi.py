"""/goal with a three-part objective: code that passes the tests, a changelog entry, a README usage line."""
import re
import subprocess
import sys
from pathlib import Path

TITLE = "用 /goal 完成一个三件事的目标"
PROMPT = ("/goal 完成 textstats 0.2.0：1) 实现 textstats.py 里的 word_count、top_words、reading_time，"
          "让 python -m unittest 全部通过（不要改测试文件）；2) 在 CHANGELOG.md 最上面加 0.2.0 一节，列出这三个新函数；"
          "3) README.md 里的用法那一行加上 --top N 选项（textstats.py 的命令行已经支持）。")
TIMEOUT = 900
NETWORK = False

CODE = '''"""Small text statistics."""
import argparse
import re

WORD = re.compile(r"[A-Za-z']+")


def word_count(text):
    """Number of words: runs of letters and apostrophes ("don't" is one word)."""
    raise NotImplementedError


def top_words(text, n=3):
    """The n most common words, lower-cased, as (word, count) pairs: most common first, ties in alphabetical order."""
    raise NotImplementedError


def reading_time(text, wpm=200):
    """Whole minutes to read the text at wpm words per minute, rounded up; 0 for a text without words."""
    raise NotImplementedError


def main(argv=None):
    ap = argparse.ArgumentParser(description="Text statistics")
    ap.add_argument("file")
    ap.add_argument("--top", type=int, default=3, help="how many common words to list")
    a = ap.parse_args(argv)
    text = open(a.file, encoding="utf-8").read()
    print(f"words: {word_count(text)}, reading time: {reading_time(text)} min")
    for w, c in top_words(text, a.top):
        print(f"{w}\\t{c}")


if __name__ == "__main__":
    main()
'''

TEST = '''import unittest

from textstats import reading_time, top_words, word_count


class WordCount(unittest.TestCase):
    def test_simple(self):
        self.assertEqual(word_count("The cat sat on the mat."), 6)

    def test_apostrophe_and_numbers(self):
        self.assertEqual(word_count("Don't panic: 42 is not a word!"), 6)

    def test_empty(self):
        self.assertEqual(word_count("  ...  "), 0)


class TopWords(unittest.TestCase):
    def test_order(self):
        self.assertEqual(top_words("b a B c a b", 2), [("b", 3), ("a", 2)])

    def test_ties_alphabetical(self):
        self.assertEqual(top_words("pear apple fig", 3), [("apple", 1), ("fig", 1), ("pear", 1)])

    def test_default_three(self):
        self.assertEqual(len(top_words("one two three four five")), 3)


class ReadingTime(unittest.TestCase):
    def test_round_up(self):
        self.assertEqual(reading_time("word " * 201), 2)

    def test_exact(self):
        self.assertEqual(reading_time("word " * 300, wpm=150), 2)

    def test_empty(self):
        self.assertEqual(reading_time(""), 0)


if __name__ == "__main__":
    unittest.main()
'''

README = """# textstats

Word count, the most common words and the reading time of a text file.

Usage: `python textstats.py FILE`

Run the tests with `python -m unittest`.
"""

CHANGELOG = """# Changelog

## 0.1.0

- First version: the command-line skeleton.
"""


def setup(work: Path) -> None:
    (work / "textstats.py").write_text(CODE, encoding="utf-8")
    (work / "test_textstats.py").write_text(TEST, encoding="utf-8")
    (work / "README.md").write_text(README, encoding="utf-8")
    (work / "CHANGELOG.md").write_text(CHANGELOG, encoding="utf-8")


def check(work: Path, answer: str) -> tuple[bool, str]:
    if (work / "test_textstats.py").read_text(encoding="utf-8").replace("\r\n", "\n") != TEST:
        return False, "the test file was changed"
    r = subprocess.run([sys.executable, "-m", "unittest", "-q"], cwd=work, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        return False, "tests fail: " + (r.stderr.strip().splitlines() or ["?"])[-1]
    log = (work / "CHANGELOG.md").read_text(encoding="utf-8")
    m = re.search(r"0\.2\.0", log)
    if not m:
        return False, "tests pass; CHANGELOG.md has no 0.2.0 entry"
    if m.start() > log.find("0.1.0"):
        return False, "tests pass; the 0.2.0 entry is not above 0.1.0"
    entry = log[m.start():log.find("0.1.0")]
    missing = [f for f in ("word_count", "top_words", "reading_time") if f not in entry]
    if missing:
        return False, "tests pass; the 0.2.0 entry does not name " + ", ".join(missing)
    usage = [line for line in (work / "README.md").read_text(encoding="utf-8").splitlines() if "textstats.py" in line]
    if not any("--top" in line for line in usage):
        return False, "tests pass, changelog done; the README usage line has no --top"
    return True, "tests pass, 0.2.0 changelog entry, README usage with --top"


def solve(work: Path) -> str:
    p = work / "textstats.py"
    code = p.read_text(encoding="utf-8")
    bodies = ["return len(WORD.findall(text))",
              "from collections import Counter\n    c = Counter(w.lower() for w in WORD.findall(text))\n"
              "    return sorted(c.items(), key=lambda x: (-x[1], x[0]))[:n]",
              "return -(-word_count(text) // wpm)"]
    for b in bodies:
        code = code.replace("raise NotImplementedError", b, 1)
    p.write_text(code, encoding="utf-8")
    (work / "CHANGELOG.md").write_text(CHANGELOG.replace(
        "## 0.1.0", "## 0.2.0\n\n- word_count, top_words and reading_time.\n\n## 0.1.0"), encoding="utf-8")
    r = work / "README.md"
    r.write_text(r.read_text(encoding="utf-8").replace("FILE`", "FILE [--top N]`"), encoding="utf-8")
    return "Done."
