"""Look up a stable public fact on the web and cite the official source (needs the internet)."""
import re
from pathlib import Path

TITLE = "上网查一个事实并给出处"
PROMPT = "Python 3.12.0 正式版是哪一天发布的？请上网查，回答里给出日期和官方来源的网址。"
TIMEOUT = 600
NETWORK = True

DATE = re.compile(r"2023\s*[-/.年]\s*0?10\s*[-/.月]\s*0?2(?!\d)|"
                  r"(October|Oct\.?)\s+0?2(nd)?,?\s+2023|0?2(nd)?\s+(October|Oct\.?),?\s+2023", re.I)
SOURCE = re.compile(r"https?://([\w-]+\.)*python\.org\S*", re.I)


def setup(work: Path) -> None:
    pass


def check(work: Path, answer: str) -> tuple[bool, str]:
    if not DATE.search(answer):
        return False, "the answer does not give 2023-10-02"
    url = SOURCE.search(answer)
    if not url:
        return False, "date right; no python.org source URL in the answer"
    return True, f"2023-10-02, source {url.group(0)[:60]}"


def solve(work: Path) -> str:
    return "Python 3.12.0 于 2023 年 10 月 2 日发布。来源：https://www.python.org/downloads/release/python-3120/"
