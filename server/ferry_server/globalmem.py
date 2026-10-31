"""Global memory: memories kept on the Ferry server, shared by every computer that logs in as the same user.

Off unless switched on (admin page → 设备和手机, or `shared_memory = true`). The client's own memories (user and
project scope) stay on each computer; this adds a third scope, "global", for what should follow you everywhere:
your preferences, how you like the work done, terms you use.

Same layout as the client's memory folders: <data_dir>/memory/<user>/MEMORY.md (one line per memory) and one
Markdown file per memory.
"""
from __future__ import annotations

import re
import threading
from pathlib import Path

INDEX = "MEMORY.md"
MAX_BYTES = 16 * 1024
MAX_FILES = 300
INDEX_MAX_LINES = 200

_lock = threading.Lock()


def slug(s: str) -> str:
    s = re.sub(r"\.md$", "", str(s or "").strip().lower())
    s = re.sub(r"[^\w-]+", "-", s, flags=re.UNICODE).strip("-")
    return s[:60]


def user_dir(data_dir: Path, user: str) -> Path:
    return data_dir / "memory" / (re.sub(r"[^\w.-]+", "_", user or "local")[:40] or "local")


def _index_lines(d: Path) -> list[str]:
    p = d / INDEX
    return [ln for ln in p.read_text(encoding="utf-8").splitlines() if ln.strip()] if p.exists() else []


def index(data_dir: Path, user: str) -> str:
    lines = _index_lines(user_dir(data_dir, user))
    text = "\n".join(lines[:INDEX_MAX_LINES])
    if len(lines) > INDEX_MAX_LINES:
        text += f"\n(index cut at {INDEX_MAX_LINES} lines)"
    return text


def read(data_dir: Path, user: str, name: str) -> str | None:
    n = slug(name)
    p = user_dir(data_dir, user) / f"{n}.md"
    return p.read_text(encoding="utf-8") if n and p.exists() else None


def save(data_dir: Path, user: str, name: str, description: str, content: str) -> str:
    n = slug(name)
    content = str(content or "").strip()
    if not n:
        raise ValueError("name is required")
    if not content:
        raise ValueError("content is required")
    if len(content.encode("utf-8")) > MAX_BYTES:
        raise ValueError("a memory must be under 16 KB: keep only what matters later")
    description = " ".join(str(description or "").split()) or content.splitlines()[0][:120]
    d = user_dir(data_dir, user)
    with _lock:
        d.mkdir(parents=True, exist_ok=True)
        existing = [p for p in d.glob("*.md") if p.name != INDEX]
        if not (d / f"{n}.md").exists() and len(existing) >= MAX_FILES:
            raise ValueError(f"global memory is full ({MAX_FILES} memories): delete some first")
        (d / f"{n}.md").write_text(content + "\n", encoding="utf-8")
        line = f"- [{n}]({n}.md): {description[:300]}"
        lines = _index_lines(d)
        at = next((i for i, ln in enumerate(lines) if ln.startswith(f"- [{n}](")), -1)
        if at >= 0:
            lines[at] = line
        else:
            lines.append(line)
        (d / INDEX).write_text("\n".join(lines) + "\n", encoding="utf-8")
    return n


def delete(data_dir: Path, user: str, name: str) -> bool:
    n = slug(name)
    d = user_dir(data_dir, user)
    with _lock:
        p = d / f"{n}.md"
        had = p.exists()
        if had:
            p.unlink()
        lines = [ln for ln in _index_lines(d) if not ln.startswith(f"- [{n}](")]
        if d.exists():
            (d / INDEX).write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    return had


def listing(data_dir: Path) -> list[dict]:
    """Every user's memories, for the admin page."""
    root = data_dir / "memory"
    out = []
    if not root.exists():
        return out
    for d in sorted(p for p in root.iterdir() if p.is_dir()):
        desc = {}
        for ln in _index_lines(d):
            m = re.match(r"- \[([^\]]+)\]\([^)]*\):\s*(.*)", ln)
            if m:
                desc[m.group(1)] = m.group(2)
        for p in sorted(d.glob("*.md")):
            if p.name == INDEX:
                continue
            out.append({"user": d.name, "name": p.stem, "description": desc.get(p.stem, ""),
                        "content": p.read_text(encoding="utf-8")[:4000], "updated": p.stat().st_mtime})
    return out
