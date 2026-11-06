"""Answer a question from a table on page 2 of a three-page PDF."""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from office_files import make_pdf  # noqa: E402

TITLE = "从 PDF 的表格里查一个值"
PROMPT = "spec.pdf 是一份规范的节选。Table 7.3-1 里 T3517 的默认值是多少？在 PDF 的第几页？"
TIMEOUT = 600
NETWORK = False

PAGES = [
    ["TS 99.123 V1.2.0 (2026-09)",
     "Technical Specification: Timers for the Ferry access protocol (excerpt)",
     "",
     "1 Scope",
     "This document specifies the timers used by the UE and the network.",
     "The timers T3502, T3511, T3512 and T3517 are described in clause 7.3.",
     "",
     "2 References",
     "[1] TS 99.100: Ferry access protocol; Stage 2."],
    ["7.3 Timer values",
     "The default values below apply unless the network sends other values.",
     "",
     "Table 7.3-1: Timer values",
     "Timer      Default value     Started when",
     "T3502      12 min            registration fails five times",
     "T3511      10 s              registration fails",
     "T3512      54 min            the UE enters idle state",
     "T3517      15 s              the UE sends a service request",
     "T3519      60 s              the UE sends an identity response"],
    ["7.4 Notes on the timer values",
     "NOTE 1: In versions before V1.1.0 the default value of T3517 was 5 s.",
     "NOTE 2: The network may send T3512 in the registration accept message.",
     "",
     "Annex A (informative): Change history",
     "2026-09  V1.2.0  Default value of T3517 changed."],
]


def setup(work: Path) -> None:
    make_pdf(work / "spec.pdf", PAGES)


def check(work: Path, answer: str) -> tuple[bool, str]:
    value = re.search(r"(?<!\d)15\s*(s\b|sec|秒)", answer, re.I)
    page = re.search(r"第\s*(2|二)\s*页|\bpage\s*2\b|\bp\.?\s*2\b", answer, re.I)
    if not value:
        return False, "the answer does not say 15 s"
    if not page:
        return False, "15 s right; the answer does not say page 2"
    return True, "15 s, page 2"


def solve(work: Path) -> str:
    return "T3517 的默认值是 15 s，在第 2 页。"
