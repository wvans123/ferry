"""Problem reports from a work computer, posted as GitHub issues by this server.

The work computer may only talk to the Ferry server. The agent there writes the report (it saw what went wrong), the
user reads and approves the text there, and this server scrubs it once more and opens an issue with its own GitHub
token. Every report is also kept in <data>/reports/, so nothing is lost when no token is set or GitHub is unreachable.
"""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, Request

from . import __version__
from .config import Config

HIDDEN = "[hidden]"
PATTERNS = [  # private IPv4, e-mail, mainland phone numbers, API keys and tokens
    r"\b(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b",
    r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
    r"(?<!\d)1[3-9]\d{9}(?!\d)",
    r"\b(?:sk|pk|rk|ghp|gho|github_pat|xox[abp])[-_][A-Za-z0-9_-]{16,}\b",
]
MAX_TEXT = 20_000
# a user name in a Windows or macOS home path: C:\Users\zhang.san\..., /Users/zhang/...
HOME_RX = re.compile(r"(?i)([A-Z]:[\\/]+Users[\\/]+|/Users/|/home/)[^\\/\s\"'`]+")


def token_path(cfg: Config) -> Path:
    return (cfg.home or cfg.data_dir) / "github-token"


def github_token(cfg: Config) -> str:
    env = os.environ.get("FERRY_GITHUB_TOKEN", "").strip()
    if env:
        return env
    p = token_path(cfg)
    return p.read_text(encoding="utf-8").strip() if p.exists() else ""


def save_github_token(cfg: Config, value: str) -> None:
    p = token_path(cfg)
    if not value:
        p.unlink(missing_ok=True)
        return
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(value.strip(), encoding="utf-8")
    try:
        p.chmod(0o600)
    except OSError:
        pass


def words_path(cfg: Config) -> Path:
    return (cfg.home or cfg.data_dir) / "report-words.txt"


def words(cfg: Config) -> list[str]:
    """Words always hidden in reports (company, product, project names), one per line, set on the admin page."""
    p = words_path(cfg)
    return [w.strip() for w in p.read_text(encoding="utf-8").splitlines() if w.strip()] if p.exists() else []


def save_words(cfg: Config, text: str) -> None:
    p = words_path(cfg)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("\n".join(w.strip() for w in str(text).splitlines() if w.strip()) + "\n", encoding="utf-8")


def _hide_rx(cfg: Config) -> re.Pattern:
    terms = sorted(set(words(cfg)), key=len, reverse=True)
    parts = ([ "|".join(re.escape(t) for t in terms)] if terms else []) + PATTERNS
    return re.compile("|".join(f"(?:{p})" for p in parts), re.IGNORECASE)


def scrub(cfg: Config, text: str) -> tuple[str, int]:
    """Hide the word list, private IPs, e-mail addresses, phone numbers, keys and user names in paths."""
    n = 0

    def hide(_m: re.Match) -> str:
        nonlocal n
        n += 1
        return HIDDEN

    def home(m: re.Match) -> str:
        nonlocal n
        n += 1
        return m.group(1) + "<user>"

    text = HOME_RX.sub(home, str(text)[:MAX_TEXT])
    return _hide_rx(cfg).sub(hide, text), n


def _dir(cfg: Config) -> Path:
    d = cfg.data_dir / "reports"
    d.mkdir(parents=True, exist_ok=True)
    return d


def save(cfg: Config, rep: dict) -> dict:
    if not rep.get("id"):
        rep["id"] = time.strftime("%Y%m%d-%H%M%S") + f"-{int(time.time() * 1000) % 1000:03d}"
    (_dir(cfg) / f"{rep['id']}.json").write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    return rep


def load(cfg: Config, rid: str) -> dict | None:
    if not re.fullmatch(r"[0-9-]+", rid or ""):
        return None
    f = _dir(cfg) / f"{rid}.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else None


def recent(cfg: Config, n: int = 30) -> list[dict]:
    out = []
    for f in sorted(_dir(cfg).glob("*.json"), reverse=True)[:n]:
        try:
            r = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        out.append({k: r.get(k, "") for k in ("id", "title", "user", "issue", "error", "created")})
    return out


def build(cfg: Config, b: dict, user: str, device: str, server_version: str) -> dict:
    """Turn what the client sent into a scrubbed report (title, issue body)."""
    hidden = 0

    def clean(v) -> str:
        nonlocal hidden
        s, k = scrub(cfg, str(v or "").strip())
        hidden += k
        return s

    title = clean(b.get("title"))[:120] or "Problem report"
    text = clean(b.get("body"))
    facts = b.get("facts") if isinstance(b.get("facts"), dict) else {}
    lines = [f"- {clean(k)[:40]}: {clean(v)[:300]}" for k, v in list(facts.items())[:30]]
    lines.append(f"- server: Ferry {server_version}")
    body = (f"{text}\n\n<details><summary>Ferry and session facts</summary>\n\n" + "\n".join(lines) + "\n\n</details>\n\n"
            f"---\nSent with /report from a work computer through its Ferry server. {hidden} item(s) hidden before posting.")
    return {"title": title, "body": body, "user": user, "device": device, "hidden": hidden,
            "created": round(time.time(), 3), "issue": "", "error": ""}


async def post(cfg: Config, rep: dict, client: httpx.AsyncClient | None = None) -> dict:
    """Open the GitHub issue. Fills rep['issue'] (its URL) or rep['error'], saves the report, returns it."""
    tok = github_token(cfg)
    if not tok:
        rep["error"] = "no GitHub token on the Ferry server (admin page: 设置 → 问题报告)"
        return save(cfg, rep)
    api = os.environ.get("FERRY_GITHUB_API", "https://api.github.com").rstrip("/")
    own = client is None
    c = client or httpx.AsyncClient(timeout=30)
    try:
        r = await c.post(f"{api}/repos/{cfg.github_repo}/issues", timeout=30,
                         json={"title": f"[report] {rep['title']}", "body": rep["body"]},
                         headers={"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json",
                                  "User-Agent": "ferry-server"})
        if r.status_code == 201:
            rep["issue"], rep["error"] = r.json().get("html_url", ""), ""
        else:
            hint = {401: "the token is wrong or expired", 403: "the token may not open issues there",
                    404: f"no repository {cfg.github_repo}, or the token cannot see it",
                    410: "issues are switched off for that repository"}.get(r.status_code, r.text[:200])
            rep["error"] = f"GitHub answered HTTP {r.status_code}: {hint}"
    except httpx.HTTPError as e:
        rep["error"] = f"cannot reach GitHub: {type(e).__name__}"
    finally:
        if own:
            await c.aclose()
    return save(cfg, rep)


def mount(app: FastAPI, cfg: Config, client: httpx.AsyncClient, audit) -> None:
    """The route the work computer's /report uses. audit(**row) writes one line to the audit log."""

    @app.post("/v1/ferry/report")
    async def report(request: Request):
        b = json.loads(await request.body() or b"{}")
        rep = build(cfg, b, request.state.user or "", getattr(request.state, "device_name", "") or "", __version__)
        rep = await post(cfg, rep, client)
        audit(event="report", user=request.state.user, ok=bool(rep["issue"]), hidden=rep["hidden"])
        return {"ok": bool(rep["issue"]), "id": rep["id"], "issue": rep["issue"], "hidden": rep["hidden"],
                **({"error": rep["error"]} if rep["error"] else {})}

