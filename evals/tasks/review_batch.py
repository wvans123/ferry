"""Review eight short documents (Markdown and Word): six have one planted problem each, two are clean."""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from office_files import make_docx  # noqa: E402

TITLE = "批量审 8 份文件"
PROMPT = ("docs/ 下有 8 份文件（采购单、出差申请、方案、会议通知、预算），帮我逐个审一遍：数字算得对不对、日期有没有矛盾、"
          "方案是否缺了 template.md 要求的小节、前后说法是否一致。每份文件最多一个问题。把结果写进 review.md："
          "每个文件一行，写文件名和问题，没问题的写\"无问题\"。")
TIMEOUT = 900
NETWORK = False

TEMPLATE = "# 方案模板\n\n每份方案必须有这四节：背景、目标、预算、风险。\n"

DOCS = {
    "po_101.docx": ["采购单 PO-101", "申请部门：研发部", "显示器 2 台 × 1200 元 = 2400 元", "键盘 5 个 × 150 元 = 750 元",
                    "鼠标 5 个 × 80 元 = 400 元", "合计：3850 元"],
    "po_102.md": ["# 采购单 PO-102", "申请部门：市场部", "- 投影仪 1 台 × 3200 元 = 3200 元", "- 白板 2 块 × 450 元 = 900 元",
                  "- 合计：4100 元"],
    "trip_201.md": ["# 出差申请 TR-201", "出差人：王磊", "目的地：深圳", "出发日期：2026-11-12", "返回日期：2026-11-09",
                    "事由：客户现场联调"],
    "trip_202.docx": ["出差申请 TR-202", "出差人：李娜", "目的地：成都", "出发日期：2026-11-16", "返回日期：2026-11-18",
                      "事由：参加标准会议"],
    "plan_301.md": ["# 方案：工单自动分派", "## 背景", "夜间工单无人分派，平均等待 9 小时。", "## 目标", "夜间等待降到 1 小时以内。",
                    "## 预算", "开发 3 人周，约 6 万元。"],
    "plan_302.docx": ["方案：知识库改版", "背景", "知识库半年没有更新。", "目标", "每月更新一次。",
                      "预算", "团队 5 人：张伟、刘洋、陈静、杨帆。共 4 周。", "风险", "各部门配合不足。"],
    "notice_401.md": ["# 会议通知", "主题：季度复盘", "时间：2026-11-11（星期四）14:00", "地点：3 楼大会议室"],
    "budget_501.docx": ["2027 年预算", "总预算 200000 元", "人力 120000 元，占 60%", "设备 50000 元，占 25%",
                        "其他 30000 元，占 20%"],
}

# words that show the planted problem was found (Chinese or English), per problem file
PROBLEMS = {
    "po_101.docx": r"合计|总计|总额|总价|加总|3550|3850|total|sum",
    "trip_201.md": r"日期|返回|出发|早于|晚于|之前|date|return|before|after",
    "plan_301.md": r"风险|risk",
    "plan_302.docx": r"人数|5\s*人|4\s*人|四人|四个|名单|成员|people|names|members|headcount",
    "notice_401.md": r"星期|周三|周四|weekday|wednesday|thursday",
    "budget_501.docx": r"20\s*%|15\s*%|百分|比例|占比|percent|share|105",
}
CLEAN = r"无问题|没有问题|没发现问题|未发现问题|无误|no (problems?|issues?)|none|\bok\b"
FLAG = r"不一致|矛盾|缺少|缺失|(?<!无)(?<!没有)错误|有误|不对|不符|对不上|wrong|mismatch|missing|inconsistent|incorrect"


def setup(work: Path) -> None:
    (work / "template.md").write_text(TEMPLATE, encoding="utf-8")
    d = work / "docs"
    d.mkdir()
    for name, lines in DOCS.items():
        if name.endswith(".docx"):
            make_docx(d / name, lines)
        else:
            (d / name).write_text("\n\n".join(lines) + "\n", encoding="utf-8")


def segments(text: str) -> dict[str, str]:
    """What review.md says about each file: each line naming only that file, plus up to two following lines up to the
    next blank line, heading or file (lines naming several files, like a summary, are left out)."""
    stems = {n: re.compile(rf"(?<![\w]){re.escape(n.split('.')[0])}(?![\w])") for n in DOCS}
    out: dict[str, str] = {}
    current, extra = None, 0
    for line in text.splitlines():
        named = [n for n, pat in stems.items() if pat.search(line)]
        if len(named) == 1:
            current, extra = named[0], 0
            out[current] = out.get(current, "") + line + "\n"
        elif named or line.lstrip().startswith("#") or not line.strip() and extra:
            current = None
        elif current and line.strip() and extra < 2:
            out[current] += line + "\n"
            extra += 1
    return out


def check(work: Path, answer: str) -> tuple[bool, str]:
    f = work / "review.md"
    if not f.exists():
        return False, "no review.md"
    seg = segments(f.read_text(encoding="utf-8"))
    missing = [n for n in DOCS if n not in seg]
    if missing:
        return False, "review.md does not mention " + ", ".join(missing)
    found = [n for n, pat in PROBLEMS.items()
             if re.search(pat, seg[n], re.I) and (re.search(FLAG, seg[n], re.I) or not re.search(CLEAN, seg[n], re.I))]
    missed = [n for n in PROBLEMS if n not in found]
    false_alarm = [n for n in DOCS if n not in PROBLEMS and (re.search(FLAG, seg[n], re.I) or not re.search(CLEAN, seg[n], re.I))]
    if missed or false_alarm:
        return False, (f"found {len(found)}/6 problems" + (f"; missed {', '.join(missed)}" if missed else "")
                       + (f"; flagged clean {', '.join(false_alarm)}" if false_alarm else ""))
    return True, "all 6 problems found, the 2 clean files passed"


def solve(work: Path) -> str:
    (work / "review.md").write_text(
        "| 文件 | 问题 |\n|---|---|\n"
        "| po_101.docx | 合计应为 3550 元，写成了 3850 元 |\n"
        "| po_102.md | 无问题 |\n"
        "| trip_201.md | 返回日期 2026-11-09 早于出发日期 2026-11-12 |\n"
        "| trip_202.docx | 无问题 |\n"
        "| plan_301.md | 缺少\"风险\"一节 |\n"
        "| plan_302.docx | 写团队 5 人，但只列了 4 个名字 |\n"
        "| notice_401.md | 2026-11-11 是星期三，不是星期四 |\n"
        "| budget_501.docx | 其他 30000 元占 15%，不是 20%（加起来 105%） |\n", encoding="utf-8")
    return "Done."
