"""The same model from several providers: one conversation stays with one provider, new conversations go to the
least busy one, and a provider that fails is skipped for a while.

Models count as the same when their names match after normalising ("anthropic/claude-opus-5.5" and
"claude-opus-5-5" are the same) and they speak the same API (a conversation cannot move between the OpenAI-style
and the Anthropic request format).
"""
from __future__ import annotations

import time
from collections import Counter, OrderedDict

from .config import Config, ModelConfig
from .presets import norm

# HTTP answers after which another provider is tried: limits, overload, outages, and this provider's own key or
# model problems. A bad request (400, 413, 422) would fail the same way everywhere, so it is not retried.
RETRY_STATUSES = {401, 402, 403, 404, 408, 409, 429, 500, 502, 503, 504, 520, 521, 522, 524, 529}
SHORT_PAUSE = 60      # seconds a provider is skipped after a limit / overload / outage
LONG_PAUSE = 300      # ... after a key or model problem (401, 402, 403, 404)


def members(cfg: Config, m: ModelConfig) -> list[ModelConfig]:
    """m and the other ready models with the same name and API, m first."""
    same = [x for x in cfg.models.values() if x.id != m.id and x.api == m.api and norm(x.model) == norm(m.model) and x.ready]
    return [m, *same]


def groups(cfg: Config) -> dict[str, list[str]]:
    """model id -> ids of every model it shares a name with (itself first), for models offered by 2+ providers."""
    out = {}
    for m in cfg.models.values():
        ids = [x.id for x in members(cfg, m)]
        if len(ids) > 1:
            out[m.id] = ids
    return out


class Pool:
    def __init__(self, keep: int = 5000) -> None:
        self.sticky: OrderedDict[str, str] = OrderedDict()   # conversation -> model id that serves it
        self.busy: Counter = Counter()                        # model id -> requests in flight
        self.paused: dict[str, float] = {}                    # model id -> skipped until this time
        self.keep = keep

    def order(self, cfg: Config, m: ModelConfig, conv: str = "") -> list[ModelConfig]:
        """Models to try, best first."""
        cands = members(cfg, m)
        if len(cands) == 1:
            return cands
        cands = [x for x in cands if x.ready] or cands  # one without a key is no help
        now = time.time()
        ok = [x for x in cands if self.paused.get(x.id, 0) <= now]
        pinned = self.sticky.get(conv) if conv else None
        if pinned and any(x.id == pinned for x in ok):
            first = next(x for x in ok if x.id == pinned)
        else:  # a new conversation (or its provider is paused): the least busy, the requested one on a tie
            first = min(ok or cands, key=lambda x: (self.busy[x.id], x.id != m.id))
        rest = sorted((x for x in cands if x is not first), key=lambda x: (self.paused.get(x.id, 0) > now, self.busy[x.id]))
        return [first, *rest]

    def start(self, mid: str) -> None:
        self.busy[mid] += 1

    def end(self, mid: str) -> None:
        self.busy[mid] = max(0, self.busy[mid] - 1)

    def served(self, conv: str, mid: str) -> None:
        if not conv:
            return
        self.sticky[conv] = mid
        self.sticky.move_to_end(conv)
        while len(self.sticky) > self.keep:
            self.sticky.popitem(last=False)

    def failed(self, mid: str, status: int | None) -> None:
        self.paused[mid] = time.time() + (LONG_PAUSE if status in (401, 402, 403, 404) else SHORT_PAUSE)

    def state(self) -> dict:
        now = time.time()
        return {"busy": {k: v for k, v in self.busy.items() if v},
                "paused": {k: int(t - now) for k, t in self.paused.items() if t > now}}
