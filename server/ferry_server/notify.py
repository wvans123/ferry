"""Notifications to the user's phone through Bark (iPhone): a goal finished, a long request is done, approval needed."""
from __future__ import annotations

import httpx

from .config import Config


async def send(cfg: Config, title: str, body: str, kind: str = "") -> tuple[bool, str]:
    """POST to the Bark address set on the admin page. Returns (sent, error)."""
    if not cfg.bark_url:
        return False, "no Bark address set (admin page > 设置 > 手机通知)"
    url = cfg.bark_url.rstrip("/")
    payload = {"title": title[:80], "body": body[:500], "group": "Ferry"}
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
