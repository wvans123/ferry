"""A page that only shows its content after JavaScript runs, with a form: needs the real browser (agent-browser)."""
from pathlib import Path

TITLE = "用浏览器读脚本生成的页面并填表"
PROMPT = ("用浏览器打开项目文件夹里的 page.html（它的内容是脚本生成的），在输入框里填 Ferry，点 Greet 按钮，"
          "然后告诉我页面上显示的秘密词和问候语。")
TIMEOUT = 600
NETWORK = False

PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Eval page</title></head><body>
<p id="x">loading</p>
<input id="n" placeholder="Your name"><button onclick="document.getElementById('o').textContent='Hello, '+document.getElementById('n').value+' - code '+(17*3)">Greet</button>
<p id="o"></p>
<script>document.getElementById('x').textContent = 'The secret word is ' + ['mar', 'lin', '-', 7 * 9].join('');</script>
</body></html>
"""


def setup(work: Path) -> None:
    (work / "page.html").write_text(PAGE, encoding="utf-8")


def check(work: Path, answer: str) -> tuple[bool, str]:
    secret = "marlin-63" in answer
    greeting = "Hello, Ferry" in answer and "51" in answer
    if secret and greeting:
        return True, "read the script-built secret and the greeting after clicking"
    return False, ("no secret word (marlin-63)" if not secret else "") + (" no greeting (Hello, Ferry - code 51)" if not greeting else "")


def solve(work: Path) -> str:
    return "秘密词是 marlin-63，问候语是 Hello, Ferry - code 51。"
