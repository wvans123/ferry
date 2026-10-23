"""Restore placeholders in an OpenAI-compatible SSE stream.

- Text (content / reasoning_content) is passed through token by token; only a possible placeholder prefix
  (at most 15 characters) is held back.
- Tool-call arguments are held until the choice finishes, then sent once, fully restored, just before the
  finishing chunk. The client never sees a placeholder in a file path or a command.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator

from .redact import Redactor, StreamUnmasker

TEXT_FIELDS = ("content", "reasoning_content")


def _sse(obj: dict) -> bytes:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode("utf-8")


async def restore_sse(lines: AsyncIterator[str], red: Redactor, usage_out: dict, owner: str) -> AsyncIterator[bytes]:
    text: dict[tuple[int, str], StreamUnmasker] = {}
    args: dict[int, dict[int, list[str]]] = {}
    template: dict = {}
    done = False

    def take_text(ci: int) -> dict[str, str]:
        rest = {}
        for f in TEXT_FIELDS:
            u = text.pop((ci, f), None)
            s = u.flush() if u else ""
            if s:
                rest[f] = s
        return rest

    def take_args(ci: int) -> list[dict]:
        calls = args.pop(ci, {})
        return [{"index": ti, "function": {"arguments": red.unmask("".join(p), owner)}}
                for ti, p in sorted(calls.items())]

    def chunk_for(ci: int, delta: dict) -> bytes:
        return _sse({**template, "choices": [{"index": ci, "delta": delta, "finish_reason": None}]})

    def drain_all() -> list[bytes]:
        out = []
        for ci in sorted({k[0] for k in text} | set(args)):
            calls = take_args(ci)
            if calls:
                out.append(chunk_for(ci, {"tool_calls": calls}))
            rest = take_text(ci)
            if rest:
                out.append(chunk_for(ci, rest))
        return out

    async for line in lines:
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            for b in drain_all():
                yield b
            yield b"data: [DONE]\n\n"
            done = True
            continue
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError:
            continue
        template = {k: chunk[k] for k in ("id", "object", "created", "model") if k in chunk}
        if chunk.get("usage"):
            usage_out.update(chunk["usage"])
        before: list[bytes] = []
        for ch in chunk.get("choices") or []:
            ci = ch.get("index", 0)
            d = ch.get("delta")
            if d is None:
                d = ch["delta"] = {}
            for f in TEXT_FIELDS:
                if isinstance(d.get(f), str):
                    d[f] = text.setdefault((ci, f), StreamUnmasker(red, owner)).feed(d[f])
            for tc in d.get("tool_calls") or []:
                fn = tc.get("function") or {}
                if isinstance(fn.get("arguments"), str):
                    args.setdefault(ci, {}).setdefault(tc.get("index", 0), []).append(fn["arguments"])
                    fn["arguments"] = ""
            if ch.get("finish_reason"):
                calls = take_args(ci)
                if calls:
                    before.append(chunk_for(ci, {"tool_calls": calls}))
                for f, s in take_text(ci).items():  # held text stays in order: appended to this chunk
                    d[f] = (d.get(f) or "") + s
        for b in before:
            yield b
        yield _sse(chunk)

    if not done:  # upstream closed without [DONE]: release what is held
        for b in drain_all():
            yield b


def restore_message(body: dict, red: Redactor, owner: str) -> dict:
    for ch in body.get("choices") or []:
        msg = ch.get("message") or {}
        for f in TEXT_FIELDS:
            if isinstance(msg.get(f), str):
                msg[f] = red.unmask(msg[f], owner)
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function") or {}
            if isinstance(fn.get("arguments"), str):
                fn["arguments"] = red.unmask(fn["arguments"], owner)
    return body
