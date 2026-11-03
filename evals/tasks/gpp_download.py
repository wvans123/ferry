"""Find, download and read a 3GPP specification (needs the internet)."""
from pathlib import Path

TITLE = "下载并读 3GPP 规范"
PROMPT = ("从 3GPP 网站（https://www.3gpp.org/ftp/Specs/archive/23_series/23.501/）下载 TS 23.501 的最新版本，"
          "解压后告诉我 5.15 节的标题。")
TIMEOUT = 900
NETWORK = True


def setup(work: Path) -> None:
    pass


def check(work: Path, answer: str) -> tuple[bool, str]:
    files = [p for p in work.rglob("*") if p.is_file() and "23501" in p.name.replace(".", "").replace("-", "")]
    if not files:
        return False, "no 23.501 file in the project folder"
    a = answer.lower()
    ok = "network slicing" in a or "网络切片" in answer
    return ok, f"downloaded {files[0].name}; " + ("title right (Network Slicing)" if ok else "title not in the answer")


def solve(work: Path) -> str:
    (work / "23501-j00.zip").write_bytes(b"")
    return "5.15 Network Slicing"
