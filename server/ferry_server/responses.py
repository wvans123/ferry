"""OpenAI's Responses API (/v1/responses) behind Ferry's chat-completions interface.

Some models and relays speak only the Responses API (and image generation lives there). The client keeps talking
chat completions; for a provider whose api is "openai-responses" the server translates the request, and translates
the answer (streamed or not) back into chat-completion chunks, so the rest of the server (placeholders, usage,
logging) does not change.
"""
from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator

# chat-completion parameters with a different name in the Responses API, or none there
_RENAME = {"max_completion_tokens": "max_output_tokens", "max_tokens": "max_output_tokens"}
_DROP = {"stream_options", "n", "logprobs", "top_logprobs", "presence_penalty", "frequency_penalty", "seed",
         "response_format", "logit_bias", "user", "messages", "reasoning_effort", "functions", "function_call",
         "parallel_tool_calls", "stop", "temperature", "top_p", "store"}


def responses_url(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/responses"):
        return base
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")]
    return f"{base}/responses"


def _text(content) -> str:
    if isinstance(content, str):
        return content
    return "".join(p.get("text", "") for p in content or [] if isinstance(p, dict) and p.get("type") in ("text", "input_text", "output_text"))


def _user_parts(content) -> list[dict]:
    if isinstance(content, str):
        return [{"type": "input_text", "text": content}]
    out = []
    for p in content or []:
        if not isinstance(p, dict):
            continue
        if p.get("type") == "text":
            out.append({"type": "input_text", "text": p.get("text", "")})
        elif p.get("type") == "image_url":
            url = p.get("image_url", {}).get("url") if isinstance(p.get("image_url"), dict) else p.get("image_url")
            out.append({"type": "input_image", "image_url": url})
    return out or [{"type": "input_text", "text": ""}]


def to_responses(chat: dict) -> dict:
    """A chat-completions request as a Responses request."""
    instructions, items = [], []
    for m in chat.get("messages") or []:
        role = m.get("role")
        if role in ("system", "developer"):
            t = _text(m.get("content"))
            if t:
                instructions.append(t)
        elif role == "user":
            items.append({"role": "user", "content": _user_parts(m.get("content"))})
        elif role == "assistant":
            t = _text(m.get("content"))
            if t:
                items.append({"role": "assistant", "content": [{"type": "output_text", "text": t}]})
            for tc in m.get("tool_calls") or []:
                fn = tc.get("function") or {}
                items.append({"type": "function_call", "call_id": tc.get("id", ""), "name": fn.get("name", ""),
                              "arguments": fn.get("arguments") or "{}"})
        elif role == "tool":
            items.append({"type": "function_call_output", "call_id": m.get("tool_call_id", ""), "output": _text(m.get("content"))})
    out = {k: v for k, v in chat.items() if k not in _DROP and k not in _RENAME and k != "tools" and k != "tool_choice"}
    for old, new in _RENAME.items():
        if chat.get(old) is not None:
            out[new] = chat[old]
    out["input"] = items
    if instructions:
        out["instructions"] = "\n\n".join(instructions)
    if chat.get("tools"):
        out["tools"] = [{"type": "function", "name": t["function"]["name"], "description": t["function"].get("description", ""),
                         "parameters": t["function"].get("parameters") or {"type": "object", "properties": {}}}
                        for t in chat["tools"] if t.get("type") == "function" and t.get("function")]
        tc = chat.get("tool_choice")
        if isinstance(tc, str):
            out["tool_choice"] = tc
    if chat.get("reasoning_effort"):
        out["reasoning"] = {"effort": chat["reasoning_effort"]}
    out["store"] = False
    return out


def chat_usage(u: dict | None) -> dict:
    u = u or {}
    cached = (u.get("input_tokens_details") or {}).get("cached_tokens", 0) or 0
    return {"prompt_tokens": u.get("input_tokens", 0) or 0, "completion_tokens": u.get("output_tokens", 0) or 0,
            "total_tokens": u.get("total_tokens", 0) or 0, "prompt_tokens_details": {"cached_tokens": cached}}


def from_responses(resp: dict, model: str = "") -> dict:
    """A finished (non-streamed) Responses answer as a chat completion."""
    text, calls = [], []
    for item in resp.get("output") or []:
        if item.get("type") == "message":
            text.append(_text(item.get("content")))
        elif item.get("type") == "function_call":
            calls.append({"id": item.get("call_id") or item.get("id", ""), "type": "function",
                          "function": {"name": item.get("name", ""), "arguments": item.get("arguments") or "{}"}})
    msg = {"role": "assistant", "content": "".join(text) or None}
    if calls:
        msg["tool_calls"] = calls
    return {"id": resp.get("id", ""), "object": "chat.completion", "created": int(time.time()), "model": model or resp.get("model", ""),
            "choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls" if calls else "stop"}],
            "usage": chat_usage(resp.get("usage"))}


async def chat_lines(lines: AsyncIterator[str], model: str = "") -> AsyncIterator[str]:
    """A streamed Responses answer as chat-completion SSE lines ("data: {...}")."""
    base = {"id": "", "object": "chat.completion.chunk", "created": int(time.time()), "model": model}
    calls: dict[str, int] = {}  # function-call item id -> tool_calls index
    started = False

    def chunk(delta: dict, finish: str | None = None, usage: dict | None = None) -> str:
        c = {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        if usage is not None:
            c["usage"] = usage
        return "data: " + json.dumps(c, ensure_ascii=False)

    async for line in lines:
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            ev = json.loads(data)
        except json.JSONDecodeError:
            continue
        kind = ev.get("type", "")
        if kind == "response.created":
            base["id"] = (ev.get("response") or {}).get("id", "")
        if not started and kind.startswith("response."):
            started = True
            yield chunk({"role": "assistant", "content": ""})
        if kind == "response.output_text.delta":
            yield chunk({"content": ev.get("delta", "")})
        elif kind == "response.reasoning_summary_text.delta":
            yield chunk({"reasoning_content": ev.get("delta", "")})
        elif kind == "response.output_item.added" and (ev.get("item") or {}).get("type") == "function_call":
            item = ev["item"]
            idx = calls[item.get("id", "")] = len(calls)
            yield chunk({"tool_calls": [{"index": idx, "id": item.get("call_id") or item.get("id", ""), "type": "function",
                                         "function": {"name": item.get("name", ""), "arguments": item.get("arguments", "")}}]})
        elif kind == "response.function_call_arguments.delta":
            idx = calls.get(ev.get("item_id", ""), 0)
            yield chunk({"tool_calls": [{"index": idx, "function": {"arguments": ev.get("delta", "")}}]})
        elif kind in ("response.completed", "response.incomplete"):
            resp = ev.get("response") or {}
            finish = "tool_calls" if calls else ("length" if kind == "response.incomplete" else "stop")
            yield chunk({}, finish, chat_usage(resp.get("usage")))
            yield "data: [DONE]"
            return
        elif kind in ("response.failed", "error"):
            err = (ev.get("response") or {}).get("error") or ev.get("error") or ev
            msg = err.get("message") if isinstance(err, dict) else str(err)
            yield "data: " + json.dumps({"error": {"message": msg or "the model failed"}})
            return
