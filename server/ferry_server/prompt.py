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


SUMMARY_NOTES = """When you write the summary, always also keep:
- the user's own messages: word for word if short, otherwise faithfully;
- confidentiality requirements and every "do not" instruction, word for word;
- the /goal objective and how far it is, if the conversation has one;
- files the work produces (paths) and how finished each is;
- the next step."""


def summary_rules(rules_dir: Path | None) -> str:
    """What every summary keeps, then the owner's own rules/_summary.md if there is one."""
    f = rules_dir / "_summary.md" if rules_dir else None
    extra = f.read_text(encoding="utf-8").strip() if f and f.is_file() else ""
    return f"{SUMMARY_NOTES}\n\n{extra}" if extra else SUMMARY_NOTES


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


_IMAGE_DATA = re.compile(r"data:image/[\w.+-]+;base64,[A-Za-z0-9+/=]+")


def body_size(payload: dict) -> int:
    """Size of the request without embedded pictures (they would otherwise push out all text history)."""
    return len(_IMAGE_DATA.sub("data:image", json.dumps(payload, ensure_ascii=False)).encode("utf-8"))


IMAGE_TOKENS = 1600  # what one picture costs a model, roughly (it is not its base64 text)
_SKIP_KEYS = {"signature", "encrypted_content", "cache_control"}  # thinking signatures and markers: not context text


def estimate_tokens(payload: dict) -> int:
    """A rough token count of what goes to the model: about 4 ASCII characters per token, about one token per Chinese
    character, a fixed amount per picture. Only used to notice a conversation that cannot fit the model any more.

    Pictures and thinking signatures are not counted as text: a screenshot is ~1.3 MB of base64 in Claude's format
    ("source": {"data": ...}), which counted as text came to ~350k "tokens" and made a small conversation look too
    long to fit, again after every summary (ferry 0.19 and earlier)."""
    ascii_n = other = images = 0
    stack = [payload.get(k) for k in ("system", "messages", "tools")]
    while stack:
        v = stack.pop()
        if isinstance(v, str):
            if v.startswith("data:") and ";base64," in v[:80]:
                images += 1
                continue
            n = sum(1 for ch in v if ord(ch) > 127)
            other += n
            ascii_n += len(v) - n
        elif isinstance(v, dict):
            kind = v.get("type")
            if kind in ("image", "input_image") or (kind == "image_url" and "image_url" in v):
                images += 1
                continue
            if kind == "redacted_thinking":
                continue
            for k, x in v.items():
                if k in _SKIP_KEYS:
                    continue
                if k == "data" and isinstance(x, str) and len(x) > 1000 and " " not in x[:1000]:
                    ascii_n += len(x) // 50  # an attached document in base64: count it lightly
                    continue
                ascii_n += len(k) + 4
                stack.append(x)
        elif isinstance(v, list):
            stack.extend(v)
        elif v is not None:
            ascii_n += len(str(v))
    return int(ascii_n / 4 + other + images * IMAGE_TOKENS)


def overflow_message(tokens: int, window: int, model_id: str) -> str:
    """Worded so the client recognises it as a full context: it then summarises the history and tries again."""
    return (f"This conversation (about {tokens:,} tokens) exceeds the context window of model {model_id} "
            f"({window:,} tokens): context_length_exceeded. The history will be summarised.")


def restore_cache_marks(payload: dict, marks: list) -> None:
    """Put back the prompt-cache markers the client took out before syncing (they move every turn, so they are not
    part of the synced conversation). marks: [[message index, block index or -1 for a plain string, cache_control]]."""
    msgs = payload.get("messages") or []
    for idx, blk, cc in marks:
        if not (0 <= idx < len(msgs)):
            continue
        m = msgs[idx]
        if isinstance(m.get("content"), str):
            m["content"] = [{"type": "text", "text": m["content"]}]
            blk = 0
        blocks = m.get("content") or []
        if -len(blocks) <= blk < len(blocks) and isinstance(blocks[blk], dict):
            blocks[blk]["cache_control"] = cc


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


CLAUDE = re.compile(r"claude", re.I)


def wants_cache_marks(m: ModelConfig) -> bool:
    """A Claude model behind an OpenAI-style relay: Claude caches only what the request marks, so mark it (relays such
    as OpenRouter, LiteLLM and one-api pass the marks on). Native Claude (api = anthropic) gets them from the client."""
    return m.api == "openai" and bool(CLAUDE.search(m.model))


def add_cache_marks(payload: dict) -> dict:
    """A copy with Anthropic cache markers on the system prompt, the last tool and the last message: the history up
    to there is cached, and the next request reads it at about a tenth of the price."""
    out = json.loads(json.dumps(payload))
    mark = {"type": "ephemeral"}

    def on_text(msg: dict) -> bool:
        c = msg.get("content")
        if isinstance(c, str) and c:
            msg["content"] = [{"type": "text", "text": c, "cache_control": mark}]
            return True
        if isinstance(c, list):
            for part in reversed(c):
                if isinstance(part, dict) and part.get("type") == "text":
                    part["cache_control"] = mark
                    return True
        return False

    msgs = out.get("messages") or []
    for m in msgs:
        if m.get("role") in ("system", "developer"):
            on_text(m)
            break
    if out.get("tools"):
        out["tools"][-1]["cache_control"] = mark
    for m in reversed(msgs):
        if m.get("role") in ("user", "assistant", "tool") and on_text(m):
            break
    return out
