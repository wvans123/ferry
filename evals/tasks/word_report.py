"""Turn notes into a Word report."""
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from office_files import make_docx  # noqa: E402

TITLE = "按笔记写 Word 报告"
PROMPT = "根据 notes.md 写一份 Word 报告 report.docx：一个标题，三个小节（背景、问题、建议），每节一两段话。"
TIMEOUT = 600
NETWORK = False

NOTES = """# 会议笔记 11/2

- 背景：上个季度工单处理平均要 3.2 天，客户投诉主要集中在等待时间
- 问题：工单分派靠人工，夜里没人分派；同类问题重复处理
- 问题：知识库半年没更新
- 建议：按关键词自动分派；夜间值班表；每月更新一次知识库
- 目标：平均处理时间降到 2 天以内
"""


def setup(work: Path) -> None:
    (work / "notes.md").write_text(NOTES, encoding="utf-8")


def check(work: Path, answer: str) -> tuple[bool, str]:
    f = work / "report.docx"
    if not f.exists():
        return False, "no report.docx"
    try:
        with zipfile.ZipFile(f) as z:
            xml = z.read("word/document.xml").decode("utf-8")
    except Exception as e:  # noqa: BLE001
        return False, f"report.docx cannot be opened: {e}"
    text = "".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", xml))
    missing = [h for h in ("背景", "问题", "建议") if h not in text]
    if missing:
        return False, "missing sections: " + ", ".join(missing)
    if "3.2" not in text or "2 天" not in text.replace("2天", "2 天"):
        return False, "the numbers from the notes (3.2 days, 2 days) are not in the report"
    return True, "report.docx with the three sections and the numbers"


def solve(work: Path) -> str:
    make_docx(work / "report.docx", ["工单处理改进", "背景", "平均要 3.2 天。", "问题", "人工分派。", "建议", "目标降到 2 天以内。"])
    return "Done."
