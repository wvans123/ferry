"""A question whose answer is somewhere in a small project, among similar-looking numbers."""
from pathlib import Path

TITLE = "在项目里找答案"
PROMPT = "这个项目发 HTTP 请求时，默认超时是多少秒？在哪个文件里定义的？简短回答：秒数和文件路径。"
TIMEOUT = 300
NETWORK = False

FILES = {
    "README.md": "# fetcher\n\nDownloads reports from partner systems and stores them.\n",
    "fetcher/__init__.py": "",
    "fetcher/db.py": "CONNECT_TIMEOUT_S = 30  # database connection\nPOOL_SIZE = 8\n",
    "fetcher/retry.py": "MAX_RETRIES = 3\nBACKOFF_S = 2\n\n\ndef delays():\n    return [BACKOFF_S * 2 ** i for i in range(MAX_RETRIES)]\n",
    "fetcher/net/__init__.py": "",
    "fetcher/net/client.py": "import urllib.request\n\nDEFAULT_TIMEOUT_S = 45\n\n\n"
                             "def get(url, timeout=None):\n"
                             "    return urllib.request.urlopen(url, timeout=timeout or DEFAULT_TIMEOUT_S).read()\n",
    "fetcher/jobs.py": "from fetcher.net.client import get\n\nSCHEDULE_MINUTES = 15\n\n\n"
                       "def run(urls):\n    return [get(u) for u in urls]\n",
    "config.example.ini": "[db]\nhost = localhost\n\n[schedule]\nminutes = 15\n",
}


def setup(work: Path) -> None:
    for name, text in FILES.items():
        (work / name).parent.mkdir(parents=True, exist_ok=True)
        (work / name).write_text(text, encoding="utf-8")


def check(work: Path, answer: str) -> tuple[bool, str]:
    ok = "45" in answer and "client.py" in answer
    return ok, "45 s in fetcher/net/client.py" if ok else "answer misses 45 or client.py"


def solve(work: Path) -> str:
    return "45 秒，fetcher/net/client.py 里的 DEFAULT_TIMEOUT_S。"
