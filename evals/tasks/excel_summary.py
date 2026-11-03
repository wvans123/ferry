"""Sum an Excel sheet by region, write the summary, name the top region."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from office_files import make_xlsx  # noqa: E402

TITLE = "汇总 Excel"
PROMPT = "sales.xlsx 是今年的销售明细。按地区汇总销售额，写进 summary.md（每个地区一行，最后一行是合计），并告诉我哪个地区最高。"
TIMEOUT = 600
NETWORK = False

REGIONS = {"华东": [1200, 1350, 980, 1500, 1610, 1420], "华南": [800, 940, 1010, 870, 760, 990],
           "华北": [1500, 1300, 1450, 1620, 1580, 1700], "西南": [400, 520, 610, 480, 530, 590]}


def setup(work: Path) -> None:
    rows = [["地区", "月份", "销售额"]]
    for month in range(6):
        for region, values in REGIONS.items():
            rows.append([region, f"{month + 1}月", values[month]])
    make_xlsx(work / "sales.xlsx", rows, "明细")


def check(work: Path, answer: str) -> tuple[bool, str]:
    f = work / "summary.md"
    if not f.exists():
        return False, "no summary.md"
    text = f.read_text(encoding="utf-8").replace(",", "").replace("，", "")
    missing = [f"{r} {sum(v)}" for r, v in REGIONS.items() if r not in text or str(sum(v)) not in text]
    total = sum(sum(v) for v in REGIONS.values())
    if missing:
        return False, "summary.md misses " + "; ".join(missing)
    if str(total) not in text:
        return False, f"summary.md has no total {total}"
    if "华北" not in answer:
        return False, "the answer does not name 华北 as the top region"
    return True, "all four regions, the total and the top region are right"


def solve(work: Path) -> str:
    lines = [f"| {r} | {sum(v)} |" for r, v in REGIONS.items()]
    total = sum(sum(v) for v in REGIONS.values())
    (work / "summary.md").write_text("| 地区 | 销售额 |\n|---|---|\n" + "\n".join(lines) + f"\n| 合计 | {total} |\n", encoding="utf-8")
    return "华北最高。"
