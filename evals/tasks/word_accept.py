"""Accept one author's tracked changes and reject the other's."""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from office_files import docx_paragraphs, docx_xml, make_docx_body, para, text_now, w, write_docx_part  # noqa: E402

TITLE = "接受一个人的修订、拒绝另一个人的"
PROMPT = "minutes.docx 里有 Alice 和 Bob 两个人的修订。接受 Alice 的全部修订，拒绝 Bob 的全部修订，保存回 minutes.docx。"
TIMEOUT = 600
NETWORK = False

_id = iter(range(1, 100))
D = 'w:date="2026-11-02T09:00:00Z"'


def r(text: str) -> str:
    return f'<w:r><w:t xml:space="preserve">{text}</w:t></w:r>'


def ins(who: str, text: str) -> str:
    return f'<w:ins w:id="{next(_id)}" w:author="{who}" {D}>{r(text)}</w:ins>'


def dele(who: str, text: str) -> str:
    return f'<w:del w:id="{next(_id)}" w:author="{who}" {D}><w:r><w:delText xml:space="preserve">{text}</w:delText></w:r></w:del>'


def p(*runs: str, mark: str = "") -> str:
    return f"<w:p>{mark}{''.join(runs)}</w:p>"


def ins_para(who: str, text: str) -> str:
    """A whole paragraph inserted by who (its paragraph mark too)."""
    return p(ins(who, text), mark=f'<w:pPr><w:rPr><w:ins w:id="{next(_id)}" w:author="{who}" {D}/></w:rPr></w:pPr>')


BODY = (para("Project sync: meeting notes")
        + p(r("The meeting starts at "), dele("Alice", "9:00"), ins("Alice", "10:00"), r(" in room "),
            dele("Bob", "A1"), ins("Bob", "B2"), r("."))
        + p(r("Bring "), ins("Bob", "your laptop and "), r("the printed agenda"), ins("Alice", " for each attendee"), r("."))
        + p(r("Lunch "), dele("Alice", "is not"), ins("Alice", "is"), r(" provided"), dele("Bob", " by the venue"), r("."))
        + ins_para("Alice", "Parking is free for visitors.")
        + ins_para("Bob", "Dress code: formal.")
        + p(r("Next meeting: "), dele("Bob", "Friday"), ins("Bob", "Thursday"), r(" at the same time.")))

WANT = ["Project sync: meeting notes",
        "The meeting starts at 10:00 in room A1.",
        "Bring the printed agenda for each attendee.",
        "Lunch is provided by the venue.",
        "Parking is free for visitors.",
        "Next meeting: Friday at the same time."]


def setup(work: Path) -> None:
    make_docx_body(work / "minutes.docx", BODY)


def check(work: Path, answer: str) -> tuple[bool, str]:
    try:
        root, paras = docx_paragraphs(work / "minutes.docx")
    except Exception as e:  # noqa: BLE001 - a broken file is a failed task
        return False, f"minutes.docx cannot be read: {e}"
    left = sum(1 for tag in ("ins", "del", "delText") for _ in root.iter(w(tag)))
    now = [re.sub(r"\s+", " ", text_now(q)).strip() for q in paras]
    now = [t for t in now if t]
    if now != WANT:
        wrong = [f"{g!r}" for g, x in zip(now, WANT) if g != x] or [f"{len(now)} paragraphs, expected {len(WANT)}"]
        return False, "text is not as expected: " + "; ".join(wrong[:3])
    if left:
        return False, f"text right, but {left} tracked-change marks are still in the file"
    return True, "Alice's changes accepted, Bob's rejected, no marks left"


def solve(work: Path) -> str:
    f = work / "minutes.docx"
    xml = docx_xml(f)
    xml = re.sub(r'<w:p><w:pPr><w:rPr><w:ins [^>]*w:author="Bob"[^>]*/></w:rPr></w:pPr>.*?</w:p>', "", xml)
    xml = re.sub(r'<w:p><w:pPr><w:rPr><w:ins [^>]*/></w:rPr></w:pPr>', "<w:p>", xml)
    xml = re.sub(r'<w:ins [^>]*w:author="Alice"[^>]*>(.*?)</w:ins>', r"\1", xml)
    xml = re.sub(r'<w:ins [^>]*w:author="Bob"[^>]*>.*?</w:ins>', "", xml)
    xml = re.sub(r'<w:del [^>]*w:author="Alice"[^>]*>.*?</w:del>', "", xml)
    xml = re.sub(r'<w:del [^>]*w:author="Bob"[^>]*>(.*?)</w:del>', r"\1", xml).replace("w:delText", "w:t")
    write_docx_part(f, "word/document.xml", xml)
    return "Done."
