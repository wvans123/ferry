"""Requests that are too big for the model: learning a provider's real limit, and context summaries in parts.

- A relay may take less than the context size configured for it (kiro, for example, refuses big Claude requests with a
  bare 502). When a request bigger than any the model has answered fails, the server remembers that size as the
  model's real limit and answers "context_length_exceeded": the client then summarises its history (compaction)
  instead of retrying the same request forever.
- A summary request carries the whole history as text. When it does not fit the model, the server summarises it in
  parts with the same model, each part updating the summary of the parts before, and answers with the final summary,
  as if the model had written it in one go.
"""
from __future__ import annotations

import json
import re
import secrets
import time

import httpx

from .config import ModelConfig
from .presets import anthropic_url, chat_url
from .prompt import adapt_params

CONV = re.compile(r"<conversation>\n(.*)\n</conversation>\n*", re.S)
PREV = re.compile(r"<previous-summary>\n(.*?)\n</previous-summary>\n*", re.S)
UPDATE_NOTE = ("The messages above are NEW conversation messages, the next part of a long conversation. Incorporate them "
               "into the existing summary in <previous-summary> tags: keep what is still true, add what is new, and use "
               "the format described below.\n\n")


def tokens_of(text: str) -> int:
    """The same rough count as prompt.estimate_tokens: ~4 ASCII characters or 1 other character per token."""
    other = sum(1 for ch in text if ord(ch) > 127)
    return int((len(text) - other) / 4 + other)


def split_parts(conversation: str, max_tokens: int) -> list[str]:
    """Cut the serialized conversation ("[User]: ...\\n\\n[Assistant]: ...") at message boundaries into parts of at
    most max_tokens; a single message bigger than that is cut by characters."""
    msgs = re.split(r"\n\n(?=\[(?:User|Assistant|Assistant tool calls|Tool result)\]: )", conversation)
    parts, cur, size = [], [], 0
    for m in msgs:
        t = tokens_of(m)
        if t > max_tokens:  # one huge message: cut it
            if cur:
                parts.append("\n\n".join(cur))
                cur, size = [], 0
            step = max(1000, int(len(m) * max_tokens / max(t, 1)))
            parts += [m[i:i + step] for i in range(0, len(m), step)]
            continue
        if size + t > max_tokens and cur:
            parts.append("\n\n".join(cur))
            cur, size = [], 0
        cur.append(m)
        size += t
    if cur:
        parts.append("\n\n".join(cur))
    return parts


def summary_prompt(messages: list) -> tuple[str, str] | None:
    """(system, user text) of a client's summary request, or None when it is not shaped like one."""
    system, user = "", ""
    for m in messages:
        c = m.get("content")
        text = c if isinstance(c, str) else "".join(p.get("text", "") for p in c or [] if isinstance(p, dict))
        if m.get("role") in ("system", "developer"):
            system += text
        elif m.get("role") == "user":
            user += text
    return (system, user) if CONV.search(user) else None


async def complete(client: httpx.AsyncClient, m: ModelConfig, system: str, prompt: str, max_tokens: int) -> tuple[str, dict]:
    """One non-streamed request to the model in its own API. Returns (text, usage)."""
    if m.api == "anthropic":
        body = {"model": m.model, "max_tokens": min(max_tokens, m.max_tokens), "system": system,
                "messages": [{"role": "user", "content": prompt}]}
        r = await client.post(anthropic_url(m.base_url), json=body, timeout=600,
                              headers={"x-api-key": m.api_key, "anthropic-version": "2023-06-01"})
        r.raise_for_status()
        d = r.json()
        return "".join(b.get("text", "") for b in d.get("content") or [] if b.get("type") == "text"), d.get("usage") or {}
    headers = {"Content-Type": "application/json", **({"Authorization": f"Bearer {m.api_key}"} if m.api_key else {})}
    chat = adapt_params({"model": m.id, "max_completion_tokens": min(max_tokens, m.max_tokens),
                         "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}]}, m)
    if m.api == "openai-responses":
        from .responses import from_responses, responses_url, to_responses
        r = await client.post(responses_url(m.base_url), json=to_responses(chat), headers=headers, timeout=600)
        r.raise_for_status()
        d = from_responses(r.json())
    else:
        r = await client.post(chat_url(m.base_url), json=chat, headers=headers, timeout=600)
        r.raise_for_status()
        d = r.json()
    msg = (d.get("choices") or [{}])[0].get("message") or {}
    return msg.get("content") or "", d.get("usage") or {}


async def summarize_in_parts(client: httpx.AsyncClient, m: ModelConfig, system: str, user: str, limit: int) -> tuple[str, int]:
    """Summarise a summary request that is too big for the model, part by part. Returns (summary, parts)."""
    conv = CONV.search(user)
    rest = user[conv.end():] if conv else user
    prev_m = PREV.search(rest)
    prev = prev_m.group(1) if prev_m else ""
    instructions = PREV.sub("", rest).strip()
    room = max(4000, int(limit * 0.55) - tokens_of(instructions) - tokens_of(prev) - 2000)
    parts = split_parts(conv.group(1) if conv else user, room)
    for part in parts:
        prompt = f"<conversation>\n{part}\n</conversation>\n\n"
        if prev:
            prompt += f"<previous-summary>\n{prev}\n</previous-summary>\n\n{UPDATE_NOTE}"
        prev, _ = await complete(client, m, system, prompt + instructions, 16000)
    return prev, len(parts)


# ---------- an answer the server wrote itself, in the client's format ----------

def openai_answer(text: str, model: str, stream: bool) -> tuple[bytes, str]:
    cid, now = f"chatcmpl-{secrets.token_hex(6)}", int(time.time())
    if not stream:
        return json.dumps({"id": cid, "object": "chat.completion", "created": now, "model": model, "choices": [
            {"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}}).encode(), "application/json"
    base = {"id": cid, "object": "chat.completion.chunk", "created": now, "model": model}
    out = [{**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}]},
           {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}}]
    return ("".join(f"data: {json.dumps(c, ensure_ascii=False)}\n\n" for c in out) + "data: [DONE]\n\n").encode(), "text/event-stream"


def anthropic_answer(text: str, model: str) -> bytes:
    mid = f"msg_{secrets.token_hex(8)}"
    events = [
        ("message_start", {"type": "message_start", "message": {"id": mid, "type": "message", "role": "assistant", "model": model,
                                                                "content": [], "stop_reason": None,
                                                                "usage": {"input_tokens": 0, "output_tokens": 0}}}),
        ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 0}}),
        ("message_stop", {"type": "message_stop"}),
    ]
    return "".join(f"event: {e}\ndata: {json.dumps(d, ensure_ascii=False)}\n\n" for e, d in events).encode()
