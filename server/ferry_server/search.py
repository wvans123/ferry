"""Web search through a search API (Tavily, Brave or Bocha), for the work computer's web_search.

Search engines' own result pages give automated requests poor results (Bing answered "agent memory github" with
dictionary entries), so web_search is only as good as the page it scrapes. A search API is made for programs and
returns better results. Its key stays here like the model keys; the work computer sends the query (a few hundred
bytes) and gets titles, addresses and snippets back. Pages themselves are still read on the work computer.
Without an engine set, the work computer reads Bing's result page as before.
"""
from __future__ import annotations

import os
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .config import Config

ENGINES = {
    "tavily": {"name": "Tavily", "key_url": "https://app.tavily.com", "note": "给 AI agent 用的，每月有免费额度"},
    "brave": {"name": "Brave Search", "key_url": "https://api-dashboard.search.brave.com", "note": "有自己的索引"},
    "bocha": {"name": "博查", "key_url": "https://open.bochaai.com", "note": "中文网页多，国内能直接访问"},
}
RECENT = ("day", "week", "month", "year")


def key_path(cfg: Config) -> Path:
    return (cfg.home or cfg.data_dir) / "search-key"


def engine(cfg: Config) -> str:
    e = (os.environ.get("FERRY_SEARCH") or cfg.search_engine or "").strip().lower()
    return e if e in ENGINES else ""


def api_key(cfg: Config) -> str:
    env = os.environ.get("FERRY_SEARCH_KEY", "").strip()
    if env:
        return env
    p = key_path(cfg)
    return p.read_text(encoding="utf-8").strip() if p.exists() else ""


def save_key(cfg: Config, value: str) -> None:
    p = key_path(cfg)
    if not value:
        p.unlink(missing_ok=True)
        return
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(value.strip(), encoding="utf-8")
    try:
        p.chmod(0o600)
    except OSError:
        pass


def ready(cfg: Config) -> bool:
    return bool(engine(cfg) and api_key(cfg))


def base(name: str) -> str:
    """The engine's address; FERRY_SEARCH_API_<NAME> points it elsewhere (tests, a proxy)."""
    own = os.environ.get(f"FERRY_SEARCH_API_{name.upper()}", "").rstrip("/")
    return own or {"tavily": "https://api.tavily.com", "brave": "https://api.search.brave.com",
                   "bocha": "https://api.bochaai.com"}[name]


async def search(cfg: Config, client: httpx.AsyncClient, query: str, count: int = 8, recent: str = "") -> list[dict]:
    """[{title, url, snippet, date}] from the configured engine. Raises httpx.HTTPStatusError on an API error."""
    name, key = engine(cfg), api_key(cfg)
    count = max(1, min(int(count or 8), 20))
    recent = recent if recent in RECENT else ""
    if name == "tavily":
        r = await client.post(f"{base(name)}/search", headers={"Authorization": f"Bearer {key}"}, timeout=30, json={
            "query": query, "max_results": count, "search_depth": "basic",
            **({"time_range": recent} if recent else {})})
        r.raise_for_status()
        return [{"title": x.get("title", ""), "url": x.get("url", ""), "snippet": x.get("content", ""),
                 "date": x.get("published_date", "")} for x in r.json().get("results", [])]
    if name == "brave":
        r = await client.get(f"{base(name)}/res/v1/web/search", headers={"X-Subscription-Token": key, "Accept": "application/json"},
                             timeout=30, params={"q": query, "count": count,
                                                 **({"freshness": "p" + recent[0]} if recent else {})})
        r.raise_for_status()
        return [{"title": x.get("title", ""), "url": x.get("url", ""), "snippet": x.get("description", ""),
                 "date": x.get("page_age", "") or x.get("age", "")} for x in (r.json().get("web") or {}).get("results", [])]
    if name == "bocha":
        fresh = {"day": "oneDay", "week": "oneWeek", "month": "oneMonth", "year": "oneYear"}.get(recent, "noLimit")
        r = await client.post(f"{base(name)}/v1/web-search", headers={"Authorization": f"Bearer {key}"}, timeout=30,
                              json={"query": query, "count": count, "summary": True, "freshness": fresh})
        r.raise_for_status()
        j = r.json()
        d = j.get("data") if isinstance(j.get("data"), dict) else j  # the answer may come wrapped in {code, data}
        return [{"title": x.get("name", ""), "url": x.get("url", ""), "snippet": x.get("summary") or x.get("snippet", ""),
                 "date": x.get("datePublished", "")} for x in (d.get("webPages") or {}).get("value", [])]
    raise ValueError("no search engine set")


def mount(app: FastAPI, cfg: Config, client: httpx.AsyncClient, audit) -> None:
    """POST /v1/ferry/search {query, count, recent}: what the work computer's web_search asks."""

    @app.post("/v1/ferry/search")
    async def web_search(request: Request):
        b = await request.json()
        query = str(b.get("query") or "").strip()[:500]
        if not query:
            return JSONResponse({"error": "query is empty"}, 400)
        if not ready(cfg):
            return JSONResponse({"error": "no search engine is set on the Ferry server"}, 404)
        try:
            results = await search(cfg, client, query, b.get("count") or 8, str(b.get("recent") or ""))
        except httpx.HTTPStatusError as e:
            audit(event="search", user=request.state.user, engine=engine(cfg), ok=False, status=e.response.status_code)
            return JSONResponse({"error": f"{ENGINES[engine(cfg)]['name']} answered HTTP {e.response.status_code}: "
                                          f"{e.response.text[:300]}"}, 502)
        except httpx.HTTPError as e:
            audit(event="search", user=request.state.user, engine=engine(cfg), ok=False)
            return JSONResponse({"error": f"{ENGINES[engine(cfg)]['name']} did not answer: {e!r}"[:400]}, 502)
        audit(event="search", user=request.state.user, engine=engine(cfg), ok=True, results=len(results))
        return {"engine": engine(cfg), "results": results}
