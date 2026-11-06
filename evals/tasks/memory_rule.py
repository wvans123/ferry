"""A project memory (written before the run) sets the rules: reports in Chinese under reports/, never edit vendor/."""
import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path

TITLE = "按项目记忆里的规矩做事"
PROMPT = ("make_slug(\"Hello, World!\") returns \"hello-world-\" with a trailing dash; it should be \"hello-world\". "
          "Fix it so `python -m unittest` passes, then write a short report of what you changed.")
TIMEOUT = 600
NETWORK = False

MEMORY_NAME = "project-rules"
MEMORY = ("Reports for this project are written in Chinese and saved under reports/, with the date in the file name "
          "(for example reports/2026-11-06-fix.md).\n\n"
          "Never edit anything under vendor/: it is a copy of an outside library that gets overwritten on every update. "
          "Change behaviour in our own code (app.py) instead, for example by wrapping the vendored function.")
INDEX_LINE = (f"- [{MEMORY_NAME}]({MEMORY_NAME}.md): reports go in Chinese under reports/ with the date in the file name; "
              "never edit vendor/ (wrap it in app.py instead)")

VENDOR = '''"""slugify 1.4 (vendored copy, do not edit: replaced on every update)."""
import re


def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).lstrip("-")
'''
APP = '''from vendor.slugify import slugify


def make_slug(title):
    """URL slug for an article title."""
    return slugify(title)
'''
TEST = '''import unittest

from app import make_slug


class SlugTest(unittest.TestCase):
    def test_trailing_punctuation(self):
        self.assertEqual(make_slug("Hello, World!"), "hello-world")

    def test_plain(self):
        self.assertEqual(make_slug("Release notes 2026"), "release-notes-2026")

    def test_leading(self):
        self.assertEqual(make_slug("  ...Ferry  "), "ferry")


if __name__ == "__main__":
    unittest.main()
'''


def project_dir(home: Path, work: Path) -> Path:
    """The folder client/lib/memory.mjs projectDir() uses for this project (Node's process.cwd() is the real path)."""
    cwd = os.path.realpath(work)
    name = re.sub(r"[^\w.-]+", "_", os.path.basename(cwd), flags=re.ASCII)[:40] or "root"
    digest = hashlib.sha256(cwd.lower().encode("utf-8")).hexdigest()[:8]
    return home / "memory" / "projects" / f"{name}-{digest}"


def setup(work: Path) -> None:
    (work / "vendor").mkdir()
    (work / "vendor" / "__init__.py").write_text("", encoding="utf-8")
    (work / "vendor" / "slugify.py").write_text(VENDOR, encoding="utf-8")
    (work / "app.py").write_text(APP, encoding="utf-8")
    (work / "test_app.py").write_text(TEST, encoding="utf-8")


def setup_home(home: Path, work: Path) -> None:
    d = project_dir(home, work)
    d.mkdir(parents=True)
    (d / "MEMORY.md").write_text(INDEX_LINE + "\n", encoding="utf-8")
    (d / f"{MEMORY_NAME}.md").write_text(f"---\nupdated: 2026-11-01\n---\n{MEMORY}\n", encoding="utf-8")


def check(work: Path, answer: str) -> tuple[bool, str]:
    vendor = sorted(p.relative_to(work).as_posix() for p in (work / "vendor").rglob("*")
                    if p.is_file() and "__pycache__" not in p.parts)
    if vendor != ["vendor/__init__.py", "vendor/slugify.py"] or \
            (work / "vendor" / "slugify.py").read_text(encoding="utf-8").replace("\r\n", "\n") != VENDOR:
        return False, "vendor/ was edited"
    if (work / "test_app.py").read_text(encoding="utf-8").replace("\r\n", "\n") != TEST:
        return False, "the test file was changed"
    r = subprocess.run([sys.executable, "-m", "unittest", "-q"], cwd=work, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        return False, "tests fail: " + (r.stderr.strip().splitlines() or ["?"])[-1]
    reports = [p for p in (work / "reports").rglob("*") if p.is_file()] if (work / "reports").is_dir() else []
    dated = [p for p in reports if re.search(r"20\d\d[-_.]?\d\d[-_.]?\d\d", p.name)]
    if not dated:
        return False, "fixed in app.py; no report with the date in its name under reports/"
    text = dated[0].read_text(encoding="utf-8", errors="replace")
    cjk = len(re.findall(r"[\u4e00-\u9fff]", text))
    latin = len(re.findall(r"[A-Za-z]+", re.sub(r"`[^`]*`|```.*?```", "", text, flags=re.S)))
    if cjk < 20 or cjk < latin:
        return False, f"fixed; {dated[0].name} is not written in Chinese ({cjk} Chinese characters)"
    return True, f"fixed without touching vendor/, Chinese report {dated[0].name}"


def solve(work: Path) -> str:
    (work / "app.py").write_text(APP.replace("return slugify(title)", 'return slugify(title).strip("-")'), encoding="utf-8")
    (work / "reports").mkdir()
    (work / "reports" / "2026-11-06-slug-fix.md").write_text(
        "# 修复 slug 末尾多出的短横线\n\n问题：make_slug 生成的 slug 末尾会多一个短横线。\n\n"
        "改动：vendor 里的库不能改，所以在 app.py 里把结果两头的短横线去掉。测试全部通过。\n", encoding="utf-8")
    return "Fixed in app.py; report in reports/."
