"""Small Word, Excel and PDF files for eval tasks, written with the standard library only (no Office, no packages)."""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

WNS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W = f'xmlns:w="{WNS}"'


def para(text: str) -> str:
    """One plain Word paragraph as XML."""
    return f'<w:p><w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'


def make_docx(path: Path, paragraphs: list[str]) -> None:
    make_docx_body(path, "".join(para(p) for p in paragraphs))


def make_docx_body(path: Path, body: str) -> None:
    """A Word file whose <w:body> holds this XML (paragraphs, tables, tracked changes)."""
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="word/document.xml"/></Relationships>',
        "word/document.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {W}><w:body>{body}'
        '<w:sectPr/></w:body></w:document>',
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)


def docx_xml(path: Path) -> str:
    with zipfile.ZipFile(path) as z:
        return z.read("word/document.xml").decode("utf-8")


def tracked(path: Path) -> tuple[str, str, str]:
    """(deleted text, inserted text, the text as it reads now) of a Word file."""
    xml = docx_xml(path)
    deleted = "".join(re.findall(r"<w:delText[^>]*>([^<]*)</w:delText>", xml))
    inserted = "".join("".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", m)) for m in re.findall(r"<w:ins\b[^>]*>(.*?)</w:ins>", xml, re.S))
    now = re.sub(r"<w:del\b.*?</w:del>", "", xml, flags=re.S)
    text = " ".join("".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", p)) for p in re.findall(r"<w:p\b.*?</w:p>", now, re.S))
    return deleted, inserted, text


def write_docx_part(path: Path, name: str, data: str) -> None:
    """Replace (or add) one part of a Word file, keeping the others."""
    with zipfile.ZipFile(path) as z:
        parts = {n: z.read(n) for n in z.namelist()}
    parts[name] = data.encode("utf-8")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for n, d in parts.items():
            z.writestr(n, d)


def w(tag: str) -> str:
    """A WordprocessingML tag name for ElementTree: w("p") -> "{...main}p"."""
    return f"{{{WNS}}}{tag}"


def text_now(el: ET.Element) -> str:
    """The text of an element as it reads now: tracked deletions left out, insertions kept."""
    if el.tag in (w("del"), w("moveFrom")):
        return ""
    own = (el.text or "") if el.tag == w("t") else "\t" if el.tag == w("tab") else ""
    return own + "".join(text_now(k) for k in el)


def docx_paragraphs(path: Path) -> tuple[ET.Element, list[ET.Element]]:
    """The parsed document.xml of a Word file and every paragraph in it (tables included), in order."""
    root = ET.fromstring(docx_xml(path))
    return root, list(root.iter(w("p")))


def _pdf_text(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def make_pdf(path: Path, pages: list[list[str]]) -> None:
    """A text PDF: one list of lines per page, Helvetica 11 pt, Latin characters only."""
    n = len(pages)
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>",
            f"<< /Type /Pages /Kids [{' '.join(f'{4 + 2 * i} 0 R' for i in range(n))}] /Count {n} >>".encode(),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]
    for i, lines in enumerate(pages):
        ops = ["BT", "/F1 11 Tf", "15 TL", "72 740 Td"] + [f"({_pdf_text(line)}) Tj T*" for line in lines] + ["ET"]
        stream = "\n".join(ops).encode("latin-1")
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> "
                    f"/Contents {5 + 2 * i} 0 R >>".encode())
        objs.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for k, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % k + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % off for off in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    path.write_bytes(bytes(out))


def _col(n: int) -> str:
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def make_xlsx(path: Path, rows: list[list], sheet: str = "Sheet1") -> None:
    def cell(r: int, c: int, v) -> str:
        ref = f"{_col(c)}{r}"
        if isinstance(v, (int, float)):
            return f'<c r="{ref}"><v>{v}</v></c>'
        return f'<c r="{ref}" t="inlineStr"><is><t>{escape(str(v))}</t></is></c>'

    data = "".join(f'<row r="{r}">' + "".join(cell(r, c, v) for c, v in enumerate(row, 1)) + "</row>"
                   for r, row in enumerate(rows, 1))
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<sheets><sheet name="{escape(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{data}</sheetData></worksheet>',
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, d in files.items():
            z.writestr(name, d)
