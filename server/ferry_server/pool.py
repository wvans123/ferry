"""The same model from several providers: one conversation stays with one provider, new conversations go to the
least busy one, and a provider that fails is skipped for a while.

Models count as the same when their names match after normalising ("anthropic/claude-opus-5.5" and
"claude-opus-5-5" are the same) and they speak the same API (a conversation cannot move between the OpenAI-style
and the Anthropic request format).
"""
from __future__ import annotations

import asyncio
import time
from collections import Counter, OrderedDict, deque

from .config import Config, ModelConfig
from .presets import norm

# HTTP answers after which another provider is tried: limits, overload, outages, and this provider's own key or
# model problems. A bad request (400, 413, 422) would fail the same way everywhere, so it is not retried.
RETRY_STATUSES = {401, 402, 403, 404, 408, 409, 429, 500, 502, 503, 504, 520, 521, 522, 524, 529}
# A limit or a hiccup (not a key or model problem): worth asking the same provider again after a short wait when no
# other provider has the model. Relays such as kiro answer 502 within milliseconds when they are busy.
TRANSIENT_STATUSES = {408, 429, 500, 502, 503, 504, 520, 521, 522, 524, 529}
RETRY_WAIT_S = 90     # the most a request takes in total (attempts, waits, cool-downs) before the error goes back;
                      # Cloudflare and other proxies give up on a request that has sent nothing for 100-120 s
SHORT_PAUSE = 60      # seconds a provider is skipped after a limit / overload / outage
LONG_PAUSE = 300      # ... after a key or model problem (401, 402, 403, 404)


def members(cfg: Config, m: ModelConfig) -> list[ModelConfig]:
    """m and the other ready models with the same name and API, m first, when m's provider shares (share = true):
    then the sharing providers' copies form one pool. By default a model stands alone."""
    if not getattr(m, "share", False):
        return [m]
    same = [x for x in cfg.models.values() if x.id != m.id and getattr(x, "share", False) and x.api == m.api
            and norm(x.model) == norm(m.model) and x.ready]
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
        self.gates: dict[str, tuple[int, asyncio.Semaphore]] = {}  # provider -> (limit, its semaphore)
        self.held: dict[str, list[asyncio.Semaphore]] = {}         # model id -> gates its running calls hold
        self.waiting: Counter = Counter()                          # provider -> requests waiting for a free slot
        self.cool_until: dict[str, float] = {}                     # provider -> left alone until (after a 429)
        self.started: dict[str, deque] = {}                        # provider -> start times in the last minute (rpm)

    @staticmethod
    def account(m: ModelConfig) -> str:
        return m.provider or m.id

    def cooling(self, m: ModelConfig) -> float:
        """Seconds this model's account still cools down (0 = not)."""
        return max(0.0, self.cool_until.get(self.account(m), 0) - time.time())

    def cool(self, m: ModelConfig, seconds: float) -> bool:
        """After a 429: leave the account alone for a while. True when this starts a new cool-down."""
        key, until = self.account(m), time.time() + seconds
        new = self.cool_until.get(key, 0) <= time.time()
        self.cool_until[key] = max(self.cool_until.get(key, 0), until)
        return new

    async def enter(self, cfg: Config, m: ModelConfig) -> None:
        """Before a call to the provider: wait while it already has as many calls running as it may (the
        provider's max_concurrent; 0 = no limit). Every enter() is followed by one end()."""
        prov = cfg.providers.get(m.provider) if m.provider else None
        key = self.account(m)
        # a cool-down after "too many requests", then the pace (calls per minute): wait here, quietly
        while self.cooling(m) > 0:
            await asyncio.sleep(min(self.cooling(m), 5))
        rpm = int(getattr(prov, "rpm", 0) or 0)
        if rpm > 0:
            times = self.started.setdefault(key, deque())
            while True:
                now = time.time()
                while times and now - times[0] >= 60:
                    times.popleft()
                if len(times) < rpm:
                    times.append(now)
                    break
                await asyncio.sleep(60 - (now - times[0]) + 0.05)
        limit = int(getattr(prov, "max_concurrent", 0) or 0)
        if limit > 0:
            key = m.provider
            g = self.gates.get(key)
            if not g or g[0] != limit:
                g = self.gates[key] = (limit, asyncio.Semaphore(limit))
            self.waiting[key] += 1
            try:
                await g[1].acquire()
            finally:
                self.waiting[key] -= 1
            self.held.setdefault(m.id, []).append(g[1])
        self.start(m.id)

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
        if self.held.get(mid):
            self.held[mid].pop().release()

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
                "paused": {k: int(t - now) for k, t in self.paused.items() if t > now},
                "waiting": {k: v for k, v in self.waiting.items() if v},
                "cooling": {k: int(t - now) for k, t in self.cool_until.items() if t > now}}


def retry_delay(headers, attempt: int) -> float:
    """How long to wait before asking the same provider again: its Retry-After when it says (at most 30 s),
    otherwise 2, 4, 8, 16 s."""
    try:
        ra = float((headers or {}).get("retry-after", ""))
        if ra >= 0:
            return min(ra, 30.0)
    except (TypeError, ValueError):
        pass
    return float(min(2 ** (attempt + 1), 16))
