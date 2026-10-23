"""Reversible redaction.

Outbound: dictionary terms and regex patterns become deterministic placeholders like [FERRY-ABCD2345]
(HMAC of the original, so the same value always maps to the same placeholder and the model sees a
consistent conversation). Inbound: placeholders in the model's output are restored before they reach the
client, including inside streamed text and tool-call arguments.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import re
import tomllib
from collections import Counter
from pathlib import Path

from .store import Store

PREFIX = "[FERRY-"
PH_RE = re.compile(r"\[FERRY-[A-Z2-7]{8}\]")
PH_LEN = len(PREFIX) + 8 + 1


class Redactor:
    def __init__(self, dictionary: Path | None, secret: str, store: Store):
        self.secret = secret.encode("utf-8")
        self.store = store
        self.kinds: list[str] = []
        parts: list[str] = []
        if dictionary and dictionary.exists():
            raw = tomllib.loads(dictionary.read_text(encoding="utf-8"))
            terms = sorted({t for t in raw.get("terms", []) if t.strip()}, key=len, reverse=True)
            if terms:
                parts.append("(?P<k0>" + "|".join(re.escape(t) for t in terms) + ")")
                self.kinds.append("term")
            for p in raw.get("patterns", []):
                parts.append(f"(?P<k{len(self.kinds)}>{p['regex']})")
                self.kinds.append(p.get("name", "pattern"))
        self.rx = re.compile("|".join(parts), re.IGNORECASE) if parts else None

    def placeholder(self, original: str) -> str:
        digest = hmac.new(self.secret, original.encode("utf-8"), hashlib.sha256).digest()
        return f"{PREFIX}{base64.b32encode(digest).decode()[:8]}]"

    # ---------- outbound ----------
    def mask(self, text: str, hits: Counter, owner: str) -> str:
        if not self.rx or not text:
            return text
        out, last = [], 0
        for ph in PH_RE.finditer(text):  # never re-mask existing placeholders
            out.append(self._mask_segment(text[last:ph.start()], hits, owner))
            out.append(ph.group(0))
            last = ph.end()
        out.append(self._mask_segment(text[last:], hits, owner))
        return "".join(out)

    def _mask_segment(self, seg: str, hits: Counter, owner: str) -> str:
        def sub(m: re.Match) -> str:
            original = m.group(0)
            kind = self.kinds[int(m.lastgroup[1:])]
            ph = self.placeholder(original)
            self.store.put_mapping(owner, ph, original, kind)
            hits[kind] += 1
            return ph
        return self.rx.sub(sub, seg)

    def mask_payload(self, payload: dict, owner: str) -> Counter:
        hits: Counter = Counter()
        for m in payload.get("messages", []):
            c = m.get("content")
            if isinstance(c, str):
                m["content"] = self.mask(c, hits, owner)
            elif isinstance(c, list):
                for part in c:
                    if isinstance(part, dict) and isinstance(part.get("text"), str):
                        part["text"] = self.mask(part["text"], hits, owner)
            for tc in m.get("tool_calls") or []:
                fn = tc.get("function") or {}
                if isinstance(fn.get("arguments"), str):
                    fn["arguments"] = self.mask(fn["arguments"], hits, owner)
        return hits

    # ---------- inbound ----------
    def unmask(self, text: str, owner: str) -> str:
        if not text or PREFIX not in text:
            return text
        return PH_RE.sub(lambda m: self.store.get_mapping(owner, m.group(0)) or m.group(0), text)


def _could_start_placeholder(tail: str) -> bool:
    if len(tail) <= len(PREFIX):
        return PREFIX.startswith(tail)
    return tail.startswith(PREFIX) and len(tail) < PH_LEN and re.fullmatch(r"[A-Z2-7]*", tail[len(PREFIX):]) is not None


class StreamUnmasker:
    """Restores placeholders in streamed text while holding back as little as possible.

    Only a trailing fragment that could still grow into a placeholder (at most 15 characters) is held;
    everything else is released immediately, so the client still sees text appear token by token.
    """

    def __init__(self, red: Redactor, owner: str):
        self.red, self.owner, self.buf = red, owner, ""

    def feed(self, s: str) -> str:
        self.buf += s
        cut = len(self.buf)
        i = self.buf.rfind("[")
        if i != -1 and _could_start_placeholder(self.buf[i:]):
            cut = i
        out, self.buf = self.buf[:cut], self.buf[cut:]
        return self.red.unmask(out, self.owner)

    def flush(self) -> str:
        out, self.buf = self.buf, ""
        return self.red.unmask(out, self.owner)
