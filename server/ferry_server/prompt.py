"""Final prompt building on the server (what Cursor's backend does): server rules and per-model parameter adaptation."""
from __future__ import annotations

import json
import re
from pathlib import Path

from .config import ModelConfig

_SAFE = re.compile(r"[^A-Za-z0-9_.-]")


def load_rules(rules_dir: Path | None, project: str) -> str:
    """_global.md applies to everyone; <project>.md applies when the client runs in that project folder.
    Files are read on every request, so edits take effect on the next turn without a restart."""
    if not rules_dir or not rules_dir.is_dir():
        return ""
    texts = []
    for name in ["_global", _SAFE.sub("_", project)] if project else ["_global"]:
        f = rules_dir / f"{name}.md"
        if f.is_file():
            texts.append(f.read_text(encoding="utf-8").strip())
    return "\n\n".join(t for t in texts if t)


def apply_rules(payload: dict, rules: str) -> None:
    if not rules:
        return
    block = f"\n\n<server-rules>\n{rules}\n</server-rules>"
    msgs = payload.setdefault("messages", [])
    if msgs and msgs[0].get("role") in ("system", "developer"):
        c = msgs[0].get("content")
        if isinstance(c, str):
            msgs[0]["content"] = c + block
        elif isinstance(c, list):
            c.append({"type": "text", "text": block})
    else:
        msgs.insert(0, {"role": "system", "content": block.strip()})


def adapt_params(payload: dict, m: ModelConfig) -> dict:
    out = dict(payload)
    out["model"] = m.model
    for k in m.drop_params:
        out.pop(k, None)
    for old, new in m.rename_params.items():
        if old in out:
            out[new] = out.pop(old)
    for k in ("max_tokens", "max_completion_tokens"):
        if isinstance(out.get(k), int):
            out[k] = min(out[k], m.max_tokens)
    out.update(m.extra_params)
    return out


TRIM_NOTE = "[Ferry: this earlier tool output was removed to keep the request small. Run the tool again if you need it.]"


def body_size(payload: dict) -> int:
    return len(json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def cap_upstream(payload: dict, max_bytes: int, keep_last: int = 6) -> tuple[int, int]:
    """Keep the request to the model under max_bytes by replacing the oldest tool outputs with a short note.

    The system prompt, the user's own messages and the most recent `keep_last` messages are never touched,
    and the client's history is unchanged: only what goes to the model this time is trimmed.
    Returns (number of outputs trimmed, final size in bytes).
    """
    size = body_size(payload)
    if not max_bytes or size <= max_bytes:
        return 0, size
    msgs = payload.get("messages", [])
    trimmed = 0
    for m in msgs[: max(0, len(msgs) - keep_last)]:
        if size <= max_bytes:
            break
        if m.get("role") != "tool" or m.get("content") == TRIM_NOTE:
            continue
        before = len(json.dumps(m, ensure_ascii=False).encode("utf-8"))
        m["content"] = TRIM_NOTE
        size -= before - len(json.dumps(m, ensure_ascii=False).encode("utf-8"))
        trimmed += 1
    return trimmed, body_size(payload)
