"""The server's help for the work computer's web tools: search (web_search) and reading a page with a question
(web_fetch with a prompt).

Search. Search engines' own result pages give automated requests poor results (Bing answered "agent memory github"
with dictionary entries). Better sources, all used from here so their keys stay on this computer:
- DeepSeek's Search API, with the DeepSeek key this server already has (the default when there is one);
- a search API (Tavily, Brave or Bocha), made for programs;
- a model's own web search, as Claude Code and Codex use it: Claude through Anthropic's API (its web_search
  server tool) or an OpenAI model through the Responses API (its web_search tool). The server is the model's
  client, so it asks the model to search and hands back what the search found.
The work computer sends the query (a few hundred bytes) and gets titles, addresses, dates and snippets back. Pages
themselves are still read on the work computer. Without an engine set, the work computer reads Bing's result page.

Reading with a question, like Claude Code's WebFetch: the work computer fetches the page and sends its text (at most
100k characters) with the question; a model here answers from the page, and only that answer goes into the
conversation instead of the whole page. The summary model does it when one is set, else the default model.
"""
from __future__ import annotations

import asyncio
import os
import re
import time
from pathlib import Path
from urllib.parse import unquote

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .config import Config, ModelConfig
from .presets import anthropic_url

ENGINES = {
    "deepseek": {"name": "DeepSeek 搜索", "key_url": "https://platform.deepseek.com",
                 "note": "用服务端已有的 DeepSeek Key，每千次 0.75 美元，结果带摘要、日期和权威度"},
    "tavily": {"name": "Tavily", "key_url": "https://app.tavily.com", "note": "给 AI agent 用的，每月有免费额度"},
    "brave": {"name": "Brave Search", "key_url": "https://api-dashboard.search.brave.com", "note": "有自己的索引"},
    "bocha": {"name": "博查", "key_url": "https://open.bochaai.com", "note": "中文网页多，国内能直接访问"},
}
RECENT = ("day", "week", "month", "year")
PAGE_CHARS = 100_000  # the most of a page that goes to the model, like Claude Code's WebFetch


def key_path(cfg: Config) -> Path:
    return (cfg.home or cfg.data_dir) / "search-key"


def search_model(cfg: Config, value: str) -> ModelConfig | None:
    """The model behind "model:<id>", if it can search: Claude's API, or an OpenAI model through the Responses API."""
    m = cfg.models.get(value[6:]) if value.startswith("model:") else None
    return m if m and m.api in ("anthropic", "openai-responses") else None


def deepseek_key(cfg: Config) -> str:
    """The key of a DeepSeek model this server calls at api.deepseek.com, for DeepSeek's Search API ("" when none)."""
    for m in cfg.models.values():
        if "api.deepseek.com" in m.base_url and m.api_key:
            return m.api_key
    return ""


def engine(cfg: Config) -> str:
    """The search source: "" (auto) uses DeepSeek's Search API when this server has a DeepSeek key; "bing" leaves
    searching to the work computer (Bing's page); otherwise the engine or "model:<id>" chosen on the admin page."""
    e = (os.environ.get("FERRY_SEARCH") or cfg.search_engine or "").strip()
    if e.startswith("model:"):
        return e if search_model(cfg, e) else ""
    e = e.lower()
    if not e:
        return "deepseek" if deepseek_key(cfg) else ""
    return e if e in ENGINES else ""


def label(cfg: Config) -> str:
    e = engine(cfg)
    return f"{e[6:]}'s web search" if e.startswith("model:") else ENGINES.get(e, {}).get("name", e)


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


def engine_key(cfg: Config, e: str) -> str:
    """The key for engine e: the one saved for search, or for DeepSeek the server's own DeepSeek key."""
    return api_key(cfg) or (deepseek_key(cfg) if e == "deepseek" else "")


def ready(cfg: Config) -> bool:
    e = engine(cfg)
    if e.startswith("model:"):
        m = search_model(cfg, e)
        return bool(m and m.ready)
    return bool(e and engine_key(cfg, e))


def base(name: str) -> str:
    """The engine's address; FERRY_SEARCH_API_<NAME> points it elsewhere (tests, a proxy)."""
    own = os.environ.get(f"FERRY_SEARCH_API_{name.upper()}", "").rstrip("/")
    return own or {"deepseek": "https://api.deepseek.com", "tavily": "https://api.tavily.com",
                   "brave": "https://api.search.brave.com", "bocha": "https://api.bochaai.com"}[name]


def domains(v) -> list[str]:
    """Bare host names (optionally with a path) from what the client sent: no scheme, at most 20."""
    out = []
    for d in v if isinstance(v, list) else []:
        d = re.sub(r"^[a-z]+://", "", str(d).strip().lower()).strip("/")
        if d and re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}(/[\w./-]*)?", d):
            out.append(d)
    return out[:20]


def with_sites(query: str, allowed: list[str], blocked: list[str]) -> str:
    """Domain limits written into the query, for engines without their own parameter."""
    if allowed:
        sites = " OR ".join(f"site:{d}" for d in allowed)
        return f"{query} ({sites})" if len(allowed) > 1 else f"{query} {sites}"
    return " ".join([query, *(f"-site:{d}" for d in blocked)])


class SearchFailed(Exception):
    """The engine answered, but not with results (a model's search error, an API's refusal)."""


async def search(cfg: Config, client: httpx.AsyncClient, query: str, count: int = 8, recent: str = "",
                 allowed: list[str] | None = None, blocked: list[str] | None = None, spent: dict | None = None) -> list[dict]:
    """[{title, url, snippet, date}] from the configured engine. Raises httpx.HTTPStatusError on an API error.
    A model's own search costs tokens: spent gets {"model": its id, "usage": the API's usage object}."""
    name = engine(cfg)
    key = engine_key(cfg, name)
    count = max(1, min(int(count or 8), 20))
    recent = recent if recent in RECENT else ""
    allowed, blocked = allowed or [], ([] if allowed else blocked or [])
    if name.startswith("model:"):
        return await model_search(client, search_model(cfg, name), query, count, recent, allowed, blocked, spent)
    if name == "deepseek":
        # DeepSeek's Search API (the one DeepSeek Harness uses by default); operators: site:, -site:, after:, lang:
        days = {"day": 1, "week": 7, "month": 31, "year": 366}.get(recent, 0)
        after = f" after:{time.strftime('%Y-%m-%d', time.gmtime(time.time() - days * 86400))}" if days else ""
        q = with_sites(query, allowed, blocked) + after
        if len(q) > 128:  # the API takes at most 128 characters: shorten the words, keep the operators
            q = query[:max(10, 128 - len(q) + len(query))].rstrip() + q[len(query):]
        r = await client.post(f"{base(name)}/v1/tools/search", headers={"Authorization": f"Bearer {key}"}, timeout=30,
                              json={"query": q[:128], "count": count, "ori_question": query[:128]})
        r.raise_for_status()
        return [{"title": x.get("title", ""), "url": x.get("url", ""), "snippet": x.get("summary") or x.get("snippet", ""),
                 "date": x.get("date") or ""} for x in r.json().get("results", [])]
    if name == "tavily":
        r = await client.post(f"{base(name)}/search", headers={"Authorization": f"Bearer {key}"}, timeout=30, json={
            "query": query, "max_results": count, "search_depth": "basic",
            **({"time_range": recent} if recent else {}),
            **({"include_domains": allowed} if allowed else {}), **({"exclude_domains": blocked} if blocked else {})})
        r.raise_for_status()
        return [{"title": x.get("title", ""), "url": x.get("url", ""), "snippet": x.get("content", ""),
                 "date": x.get("published_date", "")} for x in r.json().get("results", [])]
    if name == "brave":
        r = await client.get(f"{base(name)}/res/v1/web/search", headers={"X-Subscription-Token": key, "Accept": "application/json"},
                             timeout=30, params={"q": with_sites(query, allowed, blocked), "count": count,
                                                 **({"freshness": "p" + recent[0]} if recent else {})})
        r.raise_for_status()
        return [{"title": x.get("title", ""), "url": x.get("url", ""), "snippet": x.get("description", ""),
                 "date": x.get("page_age", "") or x.get("age", "")} for x in (r.json().get("web") or {}).get("results", [])]
    if name == "bocha":
        fresh = {"day": "oneDay", "week": "oneWeek", "month": "oneMonth", "year": "oneYear"}.get(recent, "noLimit")
        r = await client.post(f"{base(name)}/v1/web-search", headers={"Authorization": f"Bearer {key}"}, timeout=30,
                              json={"query": with_sites(query, allowed, blocked), "count": count, "summary": True,
                                    "freshness": fresh})
        r.raise_for_status()
        j = r.json()
        d = j.get("data") if isinstance(j.get("data"), dict) else j  # the answer may come wrapped in {code, data}
        return [{"title": x.get("name", ""), "url": x.get("url", ""), "snippet": x.get("summary") or x.get("snippet", ""),
                 "date": x.get("datePublished", "")} for x in (d.get("webPages") or {}).get("value", [])]
    raise ValueError("no search engine set")


def search_request(query: str, recent: str) -> str:
    when = {"day": " Only pages from the last day.", "week": " Only pages from the last week.",
            "month": " Only pages from the last month.", "year": " Only pages from the last year."}.get(recent, "")
    return (f"Search the web for: {query}\n\nSearch with exactly these words first.{when} This search is for another "
            "program that reads the results itself: do not answer the question, reply with the single word done.")


async def model_search(client: httpx.AsyncClient, m: ModelConfig, query: str, count: int, recent: str,
                       allowed: list[str], blocked: list[str], spent: dict | None = None) -> list[dict]:
    """A model's own web search: the server is the model's client and keeps only what the search found."""
    spent = spent if spent is not None else {}
    limits = {"allowed_domains": allowed} if allowed else {"blocked_domains": blocked} if blocked else {}
    if m.api == "anthropic":
        # the basic search tool: results come straight back (no filtering code run on Anthropic's side)
        body = {"model": m.model, "max_tokens": 4096, "messages": [{"role": "user", "content": search_request(query, recent)}],
                "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 2, **limits}]}
        r = await client.post(anthropic_url(m.base_url), json=body, timeout=90,
                              headers={"x-api-key": m.api_key, "anthropic-version": "2023-06-01"})
        r.raise_for_status()
        spent.update(model=m.id, usage=r.json().get("usage") or {})
        blocks = r.json().get("content") or []
        cited = {}
        for b in blocks:
            for c in b.get("citations") or [] if b.get("type") == "text" else []:
                cited.setdefault(c.get("url", ""), c.get("cited_text", ""))
        out, errors = [], []
        for b in blocks:
            if b.get("type") != "web_search_tool_result":
                continue
            content = b.get("content")
            if isinstance(content, dict):  # a failed search is an error object, not a list
                errors.append(content.get("error_code", "error"))
                continue
            for x in content or []:
                if x.get("type") == "web_search_result" and x.get("url"):
                    out.append({"title": x.get("title", ""), "url": x["url"], "snippet": cited.get(x["url"], ""),
                                "date": x.get("page_age", "") or ""})
        if not out and errors:
            raise SearchFailed(f"{m.id}'s web search failed: {', '.join(errors)}")
        return dedupe(out)[:count]
    from .responses import responses_url
    tool = {"type": "web_search", "search_context_size": "low", **({"filters": limits} if limits else {})}
    body = {"model": m.model, "input": search_request(query, recent), "tools": [tool],
            "include": ["web_search_call.action.sources"], "max_output_tokens": 4096}
    r = await client.post(responses_url(m.base_url), json=body, timeout=90,
                          headers={"Authorization": f"Bearer {m.api_key}", "Content-Type": "application/json"})
    r.raise_for_status()
    spent.update(model=m.id, usage=r.json().get("usage") or {})
    out = []
    for item in r.json().get("output") or []:
        if item.get("type") == "message":
            for part in item.get("content") or []:
                text = part.get("text", "")
                for a in part.get("annotations") or []:
                    if a.get("type") == "url_citation" and a.get("url"):
                        out.append({"title": a.get("title", ""), "url": a["url"], "date": "",
                                    "snippet": text[a.get("start_index", 0):a.get("end_index", 0)][:300]})
    for item in r.json().get("output") or []:  # every page the search looked at, after the cited ones
        if item.get("type") == "web_search_call":
            for s in (item.get("action") or {}).get("sources") or []:
                if s.get("url"):
                    out.append({"title": s.get("title", ""), "url": s["url"], "snippet": "", "date": ""})
    return dedupe(out)[:count]


def dedupe(rows: list[dict]) -> list[dict]:
    seen, out = set(), []
    for x in rows:
        u = x["url"].split("#")[0]
        if u not in seen:
            seen.add(u)
            out.append(x)
    return out


EXTRACT_SYSTEM = """You read one web page for an assistant that is working on a task, and answer its question from \
that page only.
- Answer concisely, with the details the question needs: figures, names, versions, dates, steps, short code or \
table excerpts.
- Use only what is on the page. If the page does not answer it, say so in one line and say what the page is about.
- Quote exact wording only in quotation marks and keep each quote short; say everything else in your own words.
- Note the page's date or version when it shows one.
- Answer in the language of the question."""


def extract_models(cfg: Config) -> list[ModelConfig]:
    """Who reads pages: the summary model when one is set, else the default model (the next one if the first refuses)."""
    ids = [i for i in (cfg.summary_model, cfg.default_model) if i and i in cfg.models]
    return [cfg.models[i] for i in dict.fromkeys(ids) if cfg.models[i].ready]


# ---------- reading a page on the server ----------
# The work computer asks the server to read public pages (only the address goes up, the answer or text comes back),
# like Claude Code reads pages away from the user's machine. Pages the server cannot reach (the company's intranet,
# addresses on the server's own network, sites that refuse it) are read on the work computer as before.

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Ferry"
TEXT_PART = 40_000
FETCH_BYTES = 5_000_000


class Unreachable(Exception):
    """The server cannot or will not read this address; the work computer should."""


class NotText(Exception):
    """The address is a file (PDF, Office, archive): the work computer downloads it."""


def private_host(host: str) -> bool:
    """True when host is or resolves to an address on a private network (the server's own LAN, loopback, ...)."""
    import ipaddress
    import socket
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        raise Unreachable(f"{host} does not resolve from the Ferry server") from None
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return True
    return False


ENT = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "nbsp": " ", "#39": "'"}


def html_to_text(html: str, base: str) -> tuple[str, str]:
    """(title, readable text) of an HTML page: like the work computer's web_fetch, links kept as [text](address)."""
    from html import unescape
    from urllib.parse import urljoin
    title = unescape(re.sub(r"\s+", " ", (re.search(r"<title[^>]*>([\s\S]*?)</title>", html, re.I) or [None, ""])[1])).strip()
    h = re.sub(r"<!--[\s\S]*?-->", "", html)
    h = re.sub(r"<(script|style|noscript|svg|head|title|nav|footer|form|iframe|template)\b[\s\S]*?</\1>", "", h, flags=re.I)
    pres: list[str] = []

    def keep_pre(m):
        pres.append(unescape(re.sub(r"<[^>]+>", "", m.group(1))))
        return f"\x00PRE{len(pres) - 1}\x00"
    h = re.sub(r"<pre\b[^>]*>([\s\S]*?)</pre>", keep_pre, h, flags=re.I)

    def link(m):
        t = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", m.group(2))).strip()
        href = unescape(m.group(1))
        if not t or re.match(r"(javascript:|#)", href, re.I):
            return t
        return f"[{t}]({urljoin(base, href)})"
    h = re.sub(r"""<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)</a>""", link, h, flags=re.I)
    h = re.sub(r"<h([1-6])\b[^>]*>", lambda m: "\n\n" + "#" * int(m.group(1)) + " ", h, flags=re.I)
    h = re.sub(r"<li\b[^>]*>", "\n- ", h, flags=re.I)
    h = re.sub(r"</?code\b[^>]*>", "`", h, flags=re.I)
    h = re.sub(r"</?(p|div|section|article|main|br|tr|table|ul|ol|header|aside|blockquote|dl|dt|dd|figure|hr|h[1-6])\b[^>]*>",
               "\n", h, flags=re.I)
    h = re.sub(r"<(td|th)\b[^>]*>", " | ", h, flags=re.I)
    h = unescape(re.sub(r"<[^>]+>", "", h))
    text = "\n".join(re.sub(r"[ \t\r\f\v]+", " ", line).strip() for line in h.split("\n"))
    text = re.sub(r"\x00PRE(\d+)\x00", lambda m: "\n```\n" + pres[int(m.group(1))].strip("\n") + "\n```\n", text)
    return title, re.sub(r"\n{3,}", "\n\n", text).strip()


async def fetch_here(client: httpx.AsyncClient, url: str) -> tuple[str, str, str]:
    """(final address, title, text), fetched by this server. Raises Unreachable or NotText."""
    from urllib.parse import urljoin, urlsplit
    current = url
    for _ in range(6):
        parts = urlsplit(current)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise Unreachable("only http and https addresses")
        if await asyncio.to_thread(private_host, parts.hostname):
            raise Unreachable(f"{parts.hostname} is on a private network")
        try:
            async with client.stream("GET", current, headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"},
                                     timeout=30, follow_redirects=False) as r:
                if r.is_redirect and r.headers.get("location"):
                    current = urljoin(current, r.headers["location"])
                    continue
                if r.status_code >= 400:
                    raise Unreachable(f"the site answered HTTP {r.status_code}")
                ctype = r.headers.get("content-type", "")
                if ctype and not re.search(r"text|html|json|xml|javascript", ctype, re.I):
                    raise NotText(ctype)
                body = b""
                async for chunk in r.aiter_bytes():
                    body += chunk
                    if len(body) > FETCH_BYTES:
                        break
        except httpx.HTTPError as e:
            raise Unreachable(f"cannot reach it from the Ferry server: {type(e).__name__}") from None
        charset = (re.search(r"charset=([\w-]+)", ctype, re.I) or re.search(rb"<meta[^>]+charset=[\"']?([\w-]+)", body[:3000], re.I))
        enc = charset.group(1) if charset else "utf-8"
        text = body.decode(enc.decode() if isinstance(enc, bytes) else enc, errors="replace")
        if "html" in ctype.lower() or re.match(r"\s*<(!doctype html|html)", text[:200], re.I):
            title, plain = html_to_text(text, current)
            if len(re.sub(r"\s+", " ", plain)) < 300 and re.search(r"<script\b", text, re.I):
                raise Unreachable("the page is built by JavaScript")  # the work computer's browser can read it
            return current, title, plain
        return current, "", text
    raise Unreachable("too many redirects")


async def fetch_page(cfg: Config, client: httpx.AsyncClient, url: str) -> tuple[str, str, str, str]:
    """(address, title, text, how): DeepSeek's Fetch API when this server has a DeepSeek key (Markdown, also many
    script-built pages), else this server's own fetch."""
    key = deepseek_key(cfg)
    if key:
        try:
            r = await client.post(f"{base('deepseek')}/v1/tools/fetch", json={"url": url[:8192]}, timeout=60,
                                  headers={"Authorization": f"Bearer {key}"})
            if r.status_code == 200 and (r.json().get("content") or "").strip():
                return url, r.json().get("title") or "", r.json()["content"], "deepseek"
        except (httpx.HTTPError, ValueError):
            pass
    address, title, text = await fetch_here(client, url)
    return address, title, text, "server"


async def answer_from_page(client: httpx.AsyncClient, cfg: Config, url: str, title: str, text: str, prompt: str,
                           user: str, audit, project: str = "") -> dict:
    """A model here answers prompt from the page. {"answer", "model"}; raises RuntimeError when none could."""
    from .fit import Refused, complete
    from .usage import cost, normalize
    models = extract_models(cfg)
    if not models:
        raise RuntimeError("no model is ready to read the page")
    page = f"Address: {url[:500]}\nTitle: {title[:300]}\n\n{text[:PAGE_CHARS]}"
    user_text = f"<page>\n{page}\n</page>\n\nQuestion: {prompt}"
    started, last = time.time(), ""
    for m in models:
        try:
            answer, usage = await complete(client, m, EXTRACT_SYSTEM, user_text, 4000)
        except (Refused, httpx.HTTPError) as e:
            last = f"{m.id}: {e!r}"[:300]
            continue
        tokens = normalize(usage)
        audit(event="chat", user=user, project=project, purpose="extract", model=m.id, status=200,
              ms=int((time.time() - started) * 1000), tokens=tokens, cost=cost(tokens, m.price))
        return {"answer": answer, "model": m.id}
    audit(event="chat", user=user, project=project, purpose="extract", status=502, error=last)
    raise RuntimeError(f"no model could read the page ({last})")


def mount(app: FastAPI, cfg: Config, client: httpx.AsyncClient, audit) -> None:
    """POST /v1/ferry/search {query, count, recent, allowed_domains, blocked_domains}: the work computer's web_search.
    POST /v1/ferry/read {url, prompt, offset}: read a public page here; with a prompt only the answer goes back.
    POST /v1/ferry/extract {url, title, prompt, text}: answer a question from a page the work computer fetched."""
    pages: dict[str, tuple[float, tuple]] = {}  # address -> (when, (address, title, text, how)), 15 minutes

    @app.post("/v1/ferry/search")
    async def web_search(request: Request):
        b = await request.json()
        query = str(b.get("query") or "").strip()[:500]
        if not query:
            return JSONResponse({"error": "query is empty"}, 400)
        if not ready(cfg):
            return JSONResponse({"error": "no search engine is set on the Ferry server"}, 404)
        name, spent, started = engine(cfg), {}, time.time()
        who = {"user": request.state.user, "project": unquote(request.headers.get("x-ferry-project", ""))}

        def charged() -> None:
            """A model's own search is a model call: in the call records and the cost, like any other."""
            if spent.get("model") in cfg.models:
                from .usage import cost, normalize
                tokens = normalize(spent.get("usage") or {})
                searches = int(((spent.get("usage") or {}).get("server_tool_use") or {}).get("web_search_requests") or 0)
                audit(event="chat", **who, purpose="search", model=spent["model"], status=200,
                      ms=int((time.time() - started) * 1000), tokens=tokens, cost=cost(tokens, cfg.models[spent["model"]].price),
                      **({"searches": searches} if searches else {}))
        try:
            results = await search(cfg, client, query, b.get("count") or 8, str(b.get("recent") or ""),
                                   domains(b.get("allowed_domains")), domains(b.get("blocked_domains")), spent)
        except httpx.HTTPStatusError as e:
            audit(event="search", **who, engine=name, ok=False, status=e.response.status_code)
            return JSONResponse({"error": f"{label(cfg)} answered HTTP {e.response.status_code}: "
                                          f"{e.response.text[:300]}"}, 502)
        except (httpx.HTTPError, SearchFailed) as e:
            charged()
            audit(event="search", **who, engine=name, ok=False)
            return JSONResponse({"error": f"{label(cfg)} did not answer: {e!r}"[:400]}, 502)
        charged()
        audit(event="search", **who, engine=name, ok=True, results=len(results), ms=int((time.time() - started) * 1000))
        return {"engine": name, "results": results}

    @app.post("/v1/ferry/read")
    async def read(request: Request):
        b = await request.json()
        url = str(b.get("url") or "").strip()
        if not re.match(r"https?://", url, re.I):
            url = f"https://{url}" if url else ""
        if not url:
            return JSONResponse({"error": "url is empty"}, 400)
        prompt = str(b.get("prompt") or "").strip()[:4000]
        offset = max(0, int(b.get("offset") or 0))
        hit = pages.get(url)
        try:
            page = hit[1] if hit and time.time() - hit[0] < 900 else await fetch_page(cfg, client, url)
        except NotText as e:
            return JSONResponse({"file": str(e)}, 415)
        except Unreachable as e:
            audit(event="read", user=request.state.user, project=unquote(request.headers.get("x-ferry-project", "")), ok=False)
            return JSONResponse({"unreachable": str(e)}, 422)
        pages[url] = (time.time(), page)
        while len(pages) > 200:
            pages.pop(next(iter(pages)))
        address, title, text, how = page
        audit(event="read", user=request.state.user, project=unquote(request.headers.get("x-ferry-project", "")), ok=True,
              via=how, chars=len(text))
        if prompt and not offset:
            try:
                out = await answer_from_page(client, cfg, address, title, text, prompt, request.state.user, audit,
                                             unquote(request.headers.get("x-ferry-project", "")))
            except RuntimeError as e:
                return JSONResponse({"error": str(e)}, 502)
            return {"url": address, "title": title, "chars": len(text), "via": how, **out}
        part = text[offset:offset + TEXT_PART]
        return {"url": address, "title": title, "chars": len(text), "via": how, "text": part,
                "next_offset": offset + TEXT_PART if len(text) > offset + TEXT_PART else None}

    @app.post("/v1/ferry/extract")
    async def extract(request: Request):
        b = await request.json()
        prompt = str(b.get("prompt") or "").strip()[:4000]
        text = str(b.get("text") or "")[:PAGE_CHARS]
        if not prompt or not text.strip():
            return JSONResponse({"error": "prompt and text are needed"}, 400)
        if not extract_models(cfg):
            return JSONResponse({"error": "no model is ready to read the page"}, 503)
        try:
            out = await answer_from_page(client, cfg, str(b.get("url") or ""), str(b.get("title") or ""), text, prompt,
                                         request.state.user, audit, unquote(request.headers.get("x-ferry-project", "")))
        except RuntimeError as e:
            return JSONResponse({"error": str(e)}, 502)
        return {**out, "chars": len(text)}
