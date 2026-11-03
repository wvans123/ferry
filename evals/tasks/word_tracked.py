"""Change a number in a Word file as a tracked change (like a change request)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from office_files import docx_xml, make_docx, tracked  # noqa: E402

TITLE = "按修订方式改 Word"
PROMPT = ("把 spec.docx 第二段里的 \"10 seconds\" 改成 \"5 seconds\"。用修订方式改（打开文件能看出删了什么、加了什么），"
          "别的地方不要动。")
TIMEOUT = 600
NETWORK = False

PARAS = ["5.2 Registration timer",
         "The UE shall send the Registration Request within 10 seconds after the timer expires.",
         "The network shall respond with Registration Accept or Registration Reject."]


def setup(work: Path) -> None:
    make_docx(work / "spec.docx", PARAS)


def check(work: Path, answer: str) -> tuple[bool, str]:
    try:
        deleted, inserted, now = tracked(work / "spec.docx")
    except Exception as e:  # noqa: BLE001 - a broken file is a failed task
        return False, f"spec.docx cannot be read: {e}"
    if "10" not in deleted or "5" not in inserted:
        return False, f"no tracked change from 10 to 5 (deleted {deleted!r}, inserted {inserted!r})"
    if "within 5 seconds" not in now or "10 seconds" in now:
        return False, "the text does not read \"within 5 seconds\" now"
    if PARAS[0] not in now or PARAS[2] not in now:
        return False, "other paragraphs changed"
    return True, "tracked change 10 -> 5, the rest untouched"


def solve(work: Path) -> str:
    import zipfile
    p = work / "spec.docx"
    xml = docx_xml(p).replace(
        "within 10 seconds after", 'within </w:t></w:r><w:del w:id="1" w:author="eval"><w:r><w:delText>10</w:delText></w:r>'
        '</w:del><w:ins w:id="2" w:author="eval"><w:r><w:t>5</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> seconds after')
    with zipfile.ZipFile(p) as z:
        parts = {n: z.read(n) for n in z.namelist()}
    parts["word/document.xml"] = xml.encode("utf-8")
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        for n, d in parts.items():
            z.writestr(n, d)
    return "Done."
