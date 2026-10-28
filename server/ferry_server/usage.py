"""Token usage in one shape for both APIs, and what it cost."""
from __future__ import annotations

import json


def normalize(usage: dict) -> dict:
    """{input, cache_read, cache_write, output} from an OpenAI or an Anthropic usage object.
    input counts only the uncached input tokens."""
    if not usage:
        return {}
    if "input_tokens" in usage and "prompt_tokens" not in usage:  # Anthropic
        return {"input": int(usage.get("input_tokens") or 0),
                "cache_read": int(usage.get("cache_read_input_tokens") or 0),
                "cache_write": int(usage.get("cache_creation_input_tokens") or 0),
                "output": int(usage.get("output_tokens") or 0)}
    prompt = int(usage.get("prompt_tokens") or 0)
    details = usage.get("prompt_tokens_details") or {}
    # OpenAI / DeepSeek / a relay in front of Claude (which may report Anthropic's own fields)
    cached = int(details.get("cached_tokens") or usage.get("prompt_cache_hit_tokens") or usage.get("cache_read_input_tokens") or 0)
    written = int(details.get("cache_write_tokens") or usage.get("cache_creation_input_tokens") or 0)
    return {"input": max(0, prompt - cached - written), "cache_read": cached, "cache_write": written,
            "output": int(usage.get("completion_tokens") or 0)}


def cost(u: dict, price: dict) -> float | None:
    """USD, or None when the model has no price set."""
    if not u or not price or "input" not in price:
        return None
    p_in = float(price.get("input", 0))
    return round((u.get("input", 0) * p_in
                  + u.get("cache_read", 0) * float(price.get("cache_read", p_in))
                  + u.get("cache_write", 0) * float(price.get("cache_write", p_in))
                  + u.get("output", 0) * float(price.get("output", 0))) / 1e6, 6)


class AnthropicSSEUsage:
    """Collects usage from an Anthropic event stream: message_start has the input side, message_delta the output."""

    def __init__(self) -> None:
        self.usage: dict = {}

    def feed(self, line: str) -> None:
        if not line.startswith("data:"):
            return
        try:
            ev = json.loads(line[5:].strip())
        except ValueError:
            return
        if ev.get("type") == "message_start":
            self.usage.update(ev.get("message", {}).get("usage") or {})
        elif ev.get("type") == "message_delta":
            self.usage.update({k: v for k, v in (ev.get("usage") or {}).items() if v is not None})
