"""Notifications to the user's phone through Bark (iPhone): a goal finished, a long request is done, approval needed.
Other channels (the Feishu bot) register with also() and get every notification that goes through everywhere().
"""
from __future__ import annotations

import httpx

from .config import Config


async def send(cfg: Config, title: str, body: str, kind: str = "", link: str = "") -> tuple[bool, str]:
    """POST to the Bark address set on the admin page; link opens when the notification is tapped. Returns (sent, error)."""
    if not cfg.bark_url:
        return False, "no Bark address set (admin page > 设置 > 手机通知)"
    url = cfg.bark_url.rstrip("/")
    payload = {"title": title[:80], "body": body[:500], "group": "Ferry", **({"url": link} if link else {})}
    if kind == "approval":
        payload["level"] = "timeSensitive"  # shows even in a focus mode
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.post(url, json=payload)
        if r.status_code == 200:
            return True, ""
        return False, f"Bark answered HTTP {r.status_code}: {r.text[:200]}"
    except httpx.HTTPError as e:
        return False, f"cannot reach Bark: {type(e).__name__}"


def also(app, on, fn) -> None:
    """Another channel: on() says whether it is set up; fn(title, body, kind, user, session) must not block."""
    app.state.notify_also = [*getattr(app.state, "notify_also", []), (on, fn)]


def ready(app, cfg: Config) -> bool:
    """Some channel can carry a notification: Bark, or another one that is set up."""
    return bool(cfg.bark_url) or any(on() for on, _ in getattr(app.state, "notify_also", []))


async def everywhere(app, cfg: Config, title: str, body: str, kind: str = "", link: str = "", user: str = "",
                     session: str = "") -> tuple[bool, str]:
    """Bark, and every other channel that is set up. Returns Bark's (sent, error)."""
    for on, fn in getattr(app.state, "notify_also", []):
        if on():
            fn(title, body, kind, user, session)
    return await send(cfg, title, body, kind, link)
