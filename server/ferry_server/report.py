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
import tomllib
from pathlib import Path

import httpx

from .config import Config
from .redact import BUILTIN_PATTERNS

HIDDEN = "[hidden]"
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


def _word_list(cfg: Config) -> re.Pattern:
    """The redaction word list and its patterns (admin page: 脱敏), used for reports even when redaction is off."""
    parts = [rx for _, _, rx in BUILTIN_PATTERNS]
    if cfg.dictionary and cfg.dictionary.exists():
        try:
            raw = tomllib.loads(cfg.dictionary.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError:
            raw = {}
        terms = sorted({t for t in raw.get("terms", []) if str(t).strip()}, key=len, reverse=True)
        if terms:
            parts.insert(0, "|".join(re.escape(t) for t in terms))
        parts += [p["regex"] for p in raw.get("patterns", []) if p.get("regex")]
    return re.compile("|".join(f"(?:{p})" for p in parts), re.IGNORECASE)


def scrub(cfg: Config, text: str) -> tuple[str, int]:
    """Hide words from the list, built-in patterns (private IPs, e-mail, phone numbers, keys) and user names in paths."""
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
    return _word_list(cfg).sub(hide, text), n


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
