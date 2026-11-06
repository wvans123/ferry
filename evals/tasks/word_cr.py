"""Fill a 3GPP CR cover page, make one tracked change in the clause and comment on it."""
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from office_files import docx_paragraphs, docx_xml, make_docx_body, para, text_now, w, write_docx_part  # noqa: E402

TITLE = "写一份 3GPP CR：填封面、修订、批注"
PROMPT = ("cr.docx 是一份 CR 模板。1) 把封面表格填好（直接填，不用修订）：Spec: TS 23.501；CR: 1234；"
          "Title: Correction of the default T3512 value；Source to WG: Ferry Telecom；"
          "Reason for change: The default value of T3512 is not aligned with TS 24.501.；"
          "Summary of change: The default value of T3512 is changed from 54 minutes to 60 minutes.\n"
          "2) 在 5.15.2.1 节里用修订方式把 54 minutes 改成 60 minutes。\n"
          "3) 在改的那句话上加一个批注，说明为什么改（和 TS 24.501 对齐）。别的地方不要动。")
TIMEOUT = 900
NETWORK = False

LABELS = ["Spec:", "CR:", "Title:", "Source to WG:", "Reason for change:", "Summary of change:"]
WANT = {"Spec:": "23.501", "CR:": "1234", "Title:": "correction of the default t3512 value", "Source to WG:": "ferry telecom",
        "Reason for change:": "24.501", "Summary of change:": "60 minutes"}
CHANGED = "The default value of timer T3512 is 54 minutes."
CLAUSE = ["5.15.2.1 General",
          "The AMF shall start timer T3512 when the UE enters CM-IDLE state.",
          CHANGED,
          "The UE shall perform a periodic registration update when T3512 expires."]


def cell(content: str, width: int) -> str:
    return f'<w:tc><w:tcPr><w:tcW w:w="{width}" w:type="dxa"/></w:tcPr>{content or "<w:p/>"}</w:tc>'


def setup(work: Path) -> None:
    rows = "".join(f"<w:tr>{cell(para(label), 2400)}{cell('', 6600)}</w:tr>" for label in LABELS)
    table = ('<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4"/>'
             '<w:bottom w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/>'
             f'</w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="6600"/></w:tblGrid>{rows}</w:tbl>')
    body = (para("3GPP TSG-SA WG2 Meeting #170, Ferry City, 16 - 20 November 2026") + para("S2-2611234")
            + para("CHANGE REQUEST") + table + para("") + para("***** First change *****")
            + "".join(para(p) for p in CLAUSE) + para("***** End of changes *****"))
    make_docx_body(work / "cr.docx", body)


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def check(work: Path, answer: str) -> tuple[bool, str]:
    f = work / "cr.docx"
    try:
        root, paras = docx_paragraphs(f)
    except Exception as e:  # noqa: BLE001 - a broken file is a failed task
        return False, f"cr.docx cannot be read: {e}"
    tables = list(root.iter(w("tbl")))
    if not tables:
        return False, "the cover table is gone"
    filled = {}
    for tr in tables[0].iter(w("tr")):
        tcs = tr.findall(w("tc"))
        if len(tcs) >= 2:
            filled[norm(text_now(tcs[0]))] = norm(text_now(tcs[1]))
    bad = [lab for lab in LABELS if WANT[lab] not in filled.get(norm(lab), "")]
    if bad:
        return False, "cover cells not filled right: " + ", ".join(bad)
    if any(tables[0].iter(w("ins"))) or any(tables[0].iter(w("del"))):
        return False, "the cover table was filled as tracked changes"
    in_table = set(tables[0].iter(w("p")))
    target = [p for p in paras if p not in in_table and "timer T3512 is" in text_now(p)]
    if len(target) != 1:
        return False, f"cannot find the one T3512 sentence ({len(target)} found)"
    p = target[0]
    now = norm(text_now(p))
    deleted = "".join(t.text or "" for t in p.iter(w("delText")))
    inserted = "".join(text_now(i) for i in p.iter(w("ins")))
    if "60 minutes" not in now or "54" in now or "54" not in deleted or "60" not in inserted:
        return False, f"no tracked change 54 -> 60 in the clause (now {now!r})"
    others = [norm(text_now(q))[:40] for q in paras if q is not p and (any(q.iter(w("ins"))) or any(q.iter(w("del"))))]
    if others:
        return False, "tracked changes outside the T3512 sentence: " + "; ".join(others)
    for ins in root.iter(w("ins")):
        if any(x is not ins for x in ins.iter(w("ins"))):
            return False, "a tracked insertion inside another one"
    texts = [norm(text_now(q)) for q in paras]
    if any(norm(c) not in texts for c in CLAUSE if c != CHANGED):
        return False, "other clause text changed"
    with zipfile.ZipFile(f) as z:
        if "word/comments.xml" not in z.namelist():
            return False, "tracked change right; no comment"
        comments = ET.fromstring(z.read("word/comments.xml"))
    notes = {c.get(w("id")): norm(text_now(c)) for c in comments.iter(w("comment"))}
    anchored = {e.get(w("id")) for tag in ("commentRangeStart", "commentReference") for e in p.iter(w(tag))}
    on_it = [notes[i] for i in anchored if i in notes]
    if not on_it:
        return False, "tracked change right; no comment anchored on the T3512 sentence"
    if not any("24.501" in n for n in on_it):
        return False, f"the comment does not give the reason (TS 24.501): {on_it[0][:60]!r}"
    return True, "cover filled, tracked 54 -> 60 in the clause only, comment with the reason"


def solve(work: Path) -> str:
    f = work / "cr.docx"
    xml = docx_xml(f)
    values = {"Spec:": "TS 23.501", "CR:": "1234", "Title:": "Correction of the default T3512 value",
              "Source to WG:": "Ferry Telecom", "Reason for change:": "The default value of T3512 is not aligned with TS 24.501.",
              "Summary of change:": "The default value of T3512 is changed from 54 minutes to 60 minutes."}
    for label, value in values.items():
        xml = xml.replace(f'{label}</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="6600" w:type="dxa"/></w:tcPr><w:p/>',
                          f'{label}</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="6600" w:type="dxa"/></w:tcPr>{para(value)}', 1)
    xml = xml.replace(
        f'<w:p><w:r><w:t xml:space="preserve">{CHANGED}</w:t></w:r></w:p>',
        '<w:p><w:commentRangeStart w:id="3"/><w:r><w:t xml:space="preserve">The default value of timer T3512 is </w:t></w:r>'
        '<w:del w:id="1" w:author="eval"><w:r><w:delText>54</w:delText></w:r></w:del>'
        '<w:ins w:id="2" w:author="eval"><w:r><w:t>60</w:t></w:r></w:ins>'
        '<w:r><w:t xml:space="preserve"> minutes.</w:t></w:r><w:commentRangeEnd w:id="3"/>'
        '<w:r><w:commentReference w:id="3"/></w:r></w:p>')
    write_docx_part(f, "word/document.xml", xml)
    write_docx_part(f, "word/comments.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                    '<w:comment w:id="3" w:author="eval"><w:p><w:r><w:t>Aligned with TS 24.501.</w:t></w:r></w:p></w:comment>'
                    '</w:comments>')
    return "Done."
