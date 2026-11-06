"""The server's help for the work computer's web tools: search (web_search) and reading a page with a question
(web_fetch with a prompt).

Search. Search engines' own result pages give automated requests poor results (Bing answered "agent memory github"
with dictionary entries). Better sources, all used from here so their keys stay on this computer, and all asked at
once for every search:
- DeepSeek's Search API, with the DeepSeek key this server already has;
- the search APIs with a key entered on the admin page (Tavily, Brave, Bocha);
- a model's own web search when one is chosen, as Claude Code and Codex use it: Claude through Anthropic's API (its
  web_search server tool) or an OpenAI model through the Responses API (its web_search tool);
- Exa's hosted search, free without a key (as opencode uses it).
Their lists are merged by reciprocal rank fusion, the same page once. The top pages are read here and the passages
that bear on the query are quoted from them, so the work computer sends the query (a few hundred bytes) and gets
titles, addresses, dates, snippets and those passages back, a few thousand tokens. The same search within 10 minutes
comes from a cache. With "bing" chosen the work computer reads Bing's result page itself.

Reading with a question, like Claude Code's WebFetch: the work computer fetches the page and sends its text (at most
100k characters) with the question; a model here answers from the page, and only that answer goes into the
conversation instead of the whole page. The summary model does it when one is set, else the default model.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit

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
SOURCE_TIMEOUT = 20
MODEL_TIMEOUT = 60    # a model's own search takes tens of seconds; a Cloudflare tunnel gives up at 100
CACHE_SECONDS = 600
PAGES = 3             # top results read for passages
PAGE_TIMEOUT = 12
PASSAGE_CHARS = 400
PASSAGES_TOTAL = 4000
SNIPPET_CHARS = 400


def key_path(cfg: Config) -> Path:
    """Before keys per engine: one key, for the engine chosen then."""
    return (cfg.home or cfg.data_dir) / "search-key"


def keys_path(cfg: Config) -> Path:
    return (cfg.home or cfg.data_dir) / "search-keys.json"


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


def chosen(cfg: Config) -> str:
    """The admin page's choice: "" (auto), "bing" (no server search), "model:<id>" (that model's search joins the
    others), or an engine (from before keys per engine: the one FERRY_SEARCH_KEY and the old key file belong to)."""
    e = (os.environ.get("FERRY_SEARCH") or cfg.search_engine or "").strip()
    return e if e.startswith("model:") else e.lower()


def saved_keys(cfg: Config) -> dict[str, str]:
    p, old = keys_path(cfg), key_path(cfg)
    try:
        keys = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    except ValueError:
        keys = {}
    if old.exists() and cfg.search_engine in ENGINES:
        keys.setdefault(cfg.search_engine, old.read_text(encoding="utf-8").strip())
    return {k: str(v) for k, v in keys.items() if k in ENGINES and v}


def save_key(cfg: Config, name: str, value: str) -> None:
    if name not in ENGINES:
        return
    keys = saved_keys(cfg)
    if value.strip():
        keys[name] = value.strip()
    else:
        keys.pop(name, None)
    p = keys_path(cfg)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(keys), encoding="utf-8")
    try:
        p.chmod(0o600)
    except OSError:
        pass
    key_path(cfg).unlink(missing_ok=True)


def engine_key(cfg: Config, e: str) -> str:
    """The key for engine e: FERRY_SEARCH_KEY_<E>, FERRY_SEARCH_KEY for the engine in FERRY_SEARCH, the one saved on
    the admin page, or for DeepSeek the server's own DeepSeek key."""
    own = os.environ.get(f"FERRY_SEARCH_KEY_{e.upper()}", "").strip()
    env = os.environ.get("FERRY_SEARCH_KEY", "").strip() if chosen(cfg) == e else ""
    return own or env or saved_keys(cfg).get(e, "") or (deepseek_key(cfg) if e == "deepseek" else "")


def exa_on() -> bool:
    return os.environ.get("FERRY_SEARCH_EXA", "").strip().lower() not in ("off", "0", "false", "no")


def sources(cfg: Config) -> list[str]:
    """Every source a search asks at once: engines with a key, the chosen model's own search, Exa's free search."""
    e = chosen(cfg)
    if e == "bing":
        return []
    out = [n for n in ENGINES if engine_key(cfg, n)]
    m = search_model(cfg, e)
    if m and m.ready:
        out.append(e)
    return out + (["exa"] if exa_on() else [])


def ready(cfg: Config) -> bool:
    return bool(sources(cfg))


def label(source: str) -> str:
    if source.startswith("model:"):
        return f"{source[6:]}'s web search"
    return "Exa" if source == "exa" else ENGINES.get(source, {}).get("name", source)


def base(name: str) -> str:
    """The engine's address; FERRY_SEARCH_API_<NAME> points it elsewhere (tests, a proxy)."""
    own = os.environ.get(f"FERRY_SEARCH_API_{name.upper()}", "").rstrip("/")
    return own or {"deepseek": "https://api.deepseek.com", "tavily": "https://api.tavily.com",
                   "brave": "https://api.search.brave.com", "bocha": "https://api.bochaai.com",
                   "exa": "https://mcp.exa.ai/mcp"}[name]


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


def on_site(url: str, d: str) -> bool:
    p = urlsplit(url)
    host, _, path = d.partition("/")
    h = (p.hostname or "").lower()
    return (h == host or h.endswith("." + host)) and p.path.lower().startswith(f"/{path}" if path else "")


def keep_domains(rows: list[dict], allowed: list[str], blocked: list[str]) -> list[dict]:
    """The domain limits once more on the results: not every source keeps to them."""
    if allowed:
        return [x for x in rows if any(on_site(x["url"], d) for d in allowed)]
    return [x for x in rows if not any(on_site(x["url"], d) for d in blocked)]


class SearchFailed(Exception):
    """The engine answered, but not with results (a model's search error, an API's refusal)."""


async def search_one(cfg: Config, client: httpx.AsyncClient, name: str, query: str, count: int = 8, recent: str = "",
                     allowed: list[str] | None = None, blocked: list[str] | None = None) -> list[dict]:
    """[{title, url, snippet, date}] from one source. Raises httpx.HTTPStatusError on an API error."""
    key = engine_key(cfg, name)
    allowed, blocked = allowed or [], ([] if allowed else blocked or [])
    if name.startswith("model:"):
        return await model_search(client, search_model(cfg, name), query, count, recent, allowed, blocked)
    if name == "exa":
        return await exa_search(client, query, count)
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
    raise ValueError(f"unknown search source {name}")


async def exa_search(client: httpx.AsyncClient, query: str, count: int) -> list[dict]:
    """Exa's hosted MCP server, called as JSON-RPC without a session. Each result comes with highlights quoted from
    the page; they are kept as the result's text, for passages when the page itself cannot be read."""
    for wait in (2, 0):
        r = await client.post(base("exa"), timeout=30, headers={"Accept": "application/json, text/event-stream"}, json={
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "web_search_exa", "arguments": {"query": query, "numResults": count, "objective": query}}})
        if r.status_code != 429 or not wait:  # the free search allows only a few at a time
            break
        await asyncio.sleep(wait)
    r.raise_for_status()
    if "json" in r.headers.get("content-type", ""):
        reply = r.json()
    else:  # one server-sent event
        reply = next((json.loads(line[5:]) for line in r.text.splitlines() if line.startswith("data:")), {})
    res = reply.get("result") or {}
    if reply.get("error") or res.get("isError"):
        raise SearchFailed(f"Exa: {json.dumps(reply.get('error') or res.get('content'), ensure_ascii=False)[:200]}")
    text = "\n".join(c.get("text", "") for c in res.get("content") or [] if c.get("type") == "text")
    out = []
    for block in re.split(r"(?m)^(?=Title: )", text):
        head, _, body = block.partition("\nHighlights:")
        field = {k: v.strip() for k, v in re.findall(r"(?m)^(Title|URL|Published): (.*)$", head)}
        if not field.get("URL", "").startswith("http"):
            continue
        body = re.sub(r"\n-{3}\s*$", "", body.strip())
        out.append({"title": "" if field.get("Title") == "N/A" else field.get("Title", ""), "url": field["URL"],
                    "snippet": re.sub(r"\s+", " ", body)[:SNIPPET_CHARS],
                    "date": "" if field.get("Published") == "N/A" else field.get("Published", ""), "text": body})
    return out


def search_request(query: str, recent: str, count: int) -> str:
    when = {"day": " Only pages from the last day.", "week": " Only pages from the last week.",
            "month": " Only pages from the last month.", "year": " Only pages from the last year."}.get(recent, "")
    return (f"Search the web for: {query}\n\nSearch with exactly these words first.{when} This search is for another "
            "program that reads the pages itself: do not answer the question. List the most relevant pages, at most "
            f"{count}, one line each: the page's address, then one or two sentences quoted word for word from that page "
            "that bear on the search.")


def quote_line(line: str) -> str:
    """What the model wrote on a result's line, without the address, the link and the list marker."""
    line = re.sub(r"\[[^\]]*\]\(https?://[^)]*\)", "", line)
    line = re.sub(r"https?://\S+", "", re.sub(r"^\s*(?:[-*•>]|\d+[.)])\s*", "", line))
    return line.strip(" \t-—–:|*\"'“”()[]")[:SNIPPET_CHARS]


def quotes_by_url(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        q = quote_line(line)
        for u in re.findall(r"https?://[^\s)\]>\"'，。]+", line):
            if q:
                out.setdefault(u.rstrip(".,;"), q)
    return out


async def model_search(client: httpx.AsyncClient, m: ModelConfig, query: str, count: int, recent: str,
                       allowed: list[str], blocked: list[str]) -> list[dict]:
    """A model's own web search: the server is the model's client and keeps what the search found, with the
    sentences the model quoted from each page as its snippet."""
    limits = {"allowed_domains": allowed} if allowed else {"blocked_domains": blocked} if blocked else {}
    if m.api == "anthropic":
        # the basic search tool: results come straight back (no filtering code run on Anthropic's side)
        body = {"model": m.model, "max_tokens": 2048,
                "messages": [{"role": "user", "content": search_request(query, recent, count)}],
                "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 2, **limits}]}
        r = await client.post(anthropic_url(m.base_url), json=body, timeout=90,
                              headers={"x-api-key": m.api_key, "anthropic-version": "2023-06-01"})
        r.raise_for_status()
        blocks = r.json().get("content") or []
        cited: dict[str, list[str]] = {}
        text = ""
        for b in blocks:
            if b.get("type") == "text":
                text += b.get("text", "")
                for c in b.get("citations") or []:
                    if c.get("cited_text"):
                        cited.setdefault(c.get("url", ""), []).append(c["cited_text"].strip())
        quoted = quotes_by_url(text)
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
                    said = " … ".join(list(dict.fromkeys(cited.get(x["url"], [])))[:2])
                    out.append({"title": x.get("title", ""), "url": x["url"], "snippet": said or quoted.get(x["url"], ""),
                                "date": x.get("page_age", "") or ""})
        if not out and errors:
            raise SearchFailed(f"{m.id}'s web search failed: {', '.join(errors)}")
        return dedupe(out)[:count]
    from .responses import responses_url
    tool = {"type": "web_search", "search_context_size": "low", **({"filters": limits} if limits else {})}
    body = {"model": m.model, "input": search_request(query, recent, count), "tools": [tool],
            "include": ["web_search_call.action.sources"], "max_output_tokens": 4096}
    r = await client.post(responses_url(m.base_url), json=body, timeout=90,
                          headers={"Authorization": f"Bearer {m.api_key}", "Content-Type": "application/json"})
    r.raise_for_status()
    out = []
    for item in r.json().get("output") or []:
        if item.get("type") == "message":
            for part in item.get("content") or []:
                text = part.get("text", "")
                quoted = quotes_by_url(text)
                for a in part.get("annotations") or []:
                    if a.get("type") == "url_citation" and a.get("url"):
                        at, end = a.get("start_index", 0), text.find("\n", a.get("start_index", 0))
                        line = text[text.rfind("\n", 0, at) + 1:end if end >= 0 else len(text)]
                        out.append({"title": a.get("title", ""), "url": a["url"], "date": "",
                                    "snippet": quote_line(line) or quoted.get(a["url"], "")})
    for item in r.json().get("output") or []:  # every page the search looked at, after the cited ones
        if item.get("type") == "web_search_call":
            for s in (item.get("action") or {}).get("sources") or []:
                if s.get("url"):
                    out.append({"title": s.get("title", ""), "url": s["url"], "snippet": "", "date": ""})
    return dedupe(out)[:count]


def norm_url(u: str) -> str:
    """The same page, however a source wrote its address: no scheme, www., fragment, trailing slash or tracking."""
    p = urlsplit(u.strip())
    host = (p.hostname or "").lower().removeprefix("www.")
    try:
        port = f":{p.port}" if p.port and p.port not in (80, 443) else ""
    except ValueError:
        port = ""
    q = urlencode(sorted((k, v) for k, v in parse_qsl(p.query, keep_blank_values=True)
                         if not re.match(r"(utm_|fbclid$|gclid$|spm$)", k)))
    return f"{host}{port}{p.path.rstrip('/')}{'?' + q if q else ''}"


def dedupe(rows: list[dict]) -> list[dict]:
    seen, out = set(), []
    for x in rows:
        u = norm_url(x["url"])
        if u not in seen:
            seen.add(u)
            out.append(x)
    return out


def merge(found: dict[str, list[dict]], query: str, count: int) -> list[dict]:
    """Reciprocal rank fusion: pages high on several sources' lists come first, each page once. Bocha counts double
    for Chinese queries."""
    chinese = bool(re.search(r"[\u3400-\u9fff]", query))
    score: dict[str, float] = {}
    rows: dict[str, dict] = {}
    for source, results in found.items():
        weight = 2.0 if source == "bocha" and chinese else 1.0
        for rank, x in enumerate(dedupe(results)):
            k = norm_url(x["url"])
            score[k] = score.get(k, 0) + weight / (60 + rank)
            row = rows.setdefault(k, {**x, "engines": []})
            row["engines"].append(source)
            for f in ("title", "snippet", "date", "text"):
                if not row.get(f) and x.get(f):
                    row[f] = x[f]
    return [rows[k] for k in sorted(rows, key=lambda k: -score[k])][:count]


async def search_all(cfg: Config, client: httpx.AsyncClient, query: str, count: int = 8, recent: str = "",
                     allowed: list[str] | None = None, blocked: list[str] | None = None,
                     names: list[str] | None = None) -> tuple[list[dict], dict]:
    """(merged results, {source: how many results, or why it failed}) from every source at once."""
    names = sources(cfg) if names is None else names
    count = max(1, min(int(count or 8), 20))
    recent = recent if recent in RECENT else ""
    allowed, blocked = allowed or [], ([] if allowed else blocked or [])

    async def one(s: str):
        try:
            rows = await asyncio.wait_for(search_one(cfg, client, s, query, count, recent, allowed, blocked),
                                          MODEL_TIMEOUT if s.startswith("model:") else SOURCE_TIMEOUT)
            return keep_domains([x for x in rows if x.get("url")], allowed, blocked)
        except httpx.HTTPStatusError as e:
            return f"{label(s)} answered HTTP {e.response.status_code}: {e.response.text[:200]}"
        except asyncio.TimeoutError:
            return f"{label(s)} did not answer in time"
        except Exception as e:  # noqa: BLE001 - one source failing must not lose the others' results
            return f"{label(s)} did not answer: {e!r}"[:300]
    got = dict(zip(names, await asyncio.gather(*(one(s) for s in names))))
    found = {s: r for s, r in got.items() if isinstance(r, list)}
    return merge(found, query, count), {s: len(r) if isinstance(r, list) else r for s, r in got.items()}


# ---------- passages: the parts of the top pages that bear on the query ----------

STOP = {"the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "how", "what", "why", "by",
        "from", "at", "as", "be", "it", "this", "that", "vs", "not", "do", "does", "can", "i", "my"}


def terms(query: str) -> set[str]:
    """The query's words (lower case, no operators or stop words); Chinese as pairs of characters."""
    q = re.sub(r"-?\b(site|after|before|lang|filetype):\S+", " ", query.lower())
    words = {w.strip("._-") for w in re.findall(r"[a-z0-9][\w.-]*", q, flags=re.ASCII)} - STOP
    han = re.findall(r"[\u3400-\u9fff]+", q)
    return {w for w in words if len(w) > 1} | {s[i:i + 2] for s in han for i in range(len(s) - 1)} \
        | {s for s in han if len(s) == 1}


def chunks(text: str, size: int) -> list[str]:
    """The text in pieces of about size characters along line breaks; a heading starts a new piece."""
    out, cur = [], ""
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        if cur and (line.startswith("#") or len(cur) + len(line) > size):
            out.append(cur)
            cur = ""
        cur = f"{cur}\n{line}" if cur else line
    return out + ([cur] if cur else [])


def window(c: str, hits: list[str], size: int) -> str:
    """At most size characters of c, word for word, starting a little before the first query word."""
    if len(c) <= size:
        return c
    first = min((i for i in (c.lower().find(t) for t in hits) if i >= 0), default=0)
    start = max(0, first - size // 4)
    if start:
        line = c.rfind("\n", 0, first)
        start = line + 1 if line >= start - size // 4 else start
    end = min(len(c), start + size)
    return ("…" if start else "") + c[start:end].strip() + ("…" if end < len(c) else "")


def pick_passages(text: str, query: str, n: int = 3, size: int = PASSAGE_CHARS) -> list[str]:
    """Up to n passages of the page that share the most words with the query, in page order."""
    want = terms(query)
    if not want or not text:
        return []
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)  # links and pictures: their words only
    scored = []
    for i, c in enumerate(chunks(text, size)):
        low = c.lower()
        hits = [t for t in want if t in low]
        if hits:
            scored.append((len(hits) + min(sum(low.count(t) for t in hits), 10) / 10, i, c, hits))
    need = 1 if len(want) < 3 else 2
    best = sorted([s for s in scored if len(s[3]) >= need] or scored, key=lambda s: -s[0])[:n]
    return [window(c, hits, size) for _, _, c, hits in sorted(best, key=lambda s: s[1])]


async def add_passages(cfg: Config, client: httpx.AsyncClient, query: str, results: list[dict],
                       cache: dict | None = None) -> None:
    """Each of the top results gets "passages": quoted from its page, read here concurrently (or from what the
    source sent with it when the page cannot be read), at most PASSAGES_TOTAL characters in all."""
    cache = {} if cache is None else cache

    async def text_of(x: dict) -> str:
        hit = cache.get(x["url"])
        if hit and time.time() - hit[0] < 900:
            return hit[1][2]
        try:
            page = await asyncio.wait_for(fetch_page(cfg, client, x["url"]), PAGE_TIMEOUT)
        except (Unreachable, NotText, asyncio.TimeoutError, httpx.HTTPError, ValueError, LookupError):
            return x.get("text", "")
        cache[x["url"]] = (time.time(), page)
        while len(cache) > 200:
            cache.pop(next(iter(cache)))
        return page[2] or x.get("text", "")
    top = results[:PAGES]
    budget = PASSAGES_TOTAL
    for x, text in zip(top, await asyncio.gather(*(text_of(x) for x in top))):
        x["passages"] = []
        for p in pick_passages(text, query):
            if len(p) > budget:
                break
            x["passages"].append(p)
            budget -= len(p)


def public(x: dict) -> dict:
    """A result as the work computer gets it; no snippet when the passages already say it."""
    snippet = str(x.get("snippet") or "")[:SNIPPET_CHARS]
    flat = lambda s: re.sub(r"\s+", " ", s).strip()  # noqa: E731
    if x.get("passages") and flat(snippet) in flat(" ".join(x["passages"])):
        snippet = ""
    return {"title": x.get("title", ""), "url": x["url"], "snippet": snippet,
            "date": x.get("date", ""), **({"passages": x["passages"]} if x.get("passages") else {})}


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
# blocks around the content: cookie banners, comments, sidebars, share buttons, related links
BOILER = (r"<(div|section|aside|ul|ol|p|span|footer|header|dialog)\b[^>]*\b(?:id|class|role)\s*=\s*[\"'](?:[^\"']*\s)?"
          r"(?:cookie|consent|gdpr|comments?|sidebar|related|share|social|newsletter|breadcrumbs?|advert|ads|promo|popup|"
          r"modal|complementary|contentinfo)(?:[-_][^\"'\s]*)?(?:\s[^\"']*)?[\"'][^>]*>")


def element_end(h: str, tag: str, start: int) -> int:
    """Where the element whose start tag begins at start ends, counting elements of the same name inside it."""
    depth = 0
    for m in re.compile(rf"<(/?){tag}\b[^>]*>", re.I).finditer(h, start):
        if not m.group(1) and m.group(0).endswith("/>"):
            continue
        depth += -1 if m.group(1) else 1
        if depth == 0:
            return m.end()
    return len(h)


def drop_elements(h: str, open_tag: str) -> str:
    """h without the elements whose start tag matches open_tag (a pattern whose first group is the tag name)."""
    out, pos = [], 0
    pat = re.compile(open_tag, re.I)
    while m := pat.search(h, pos):
        out.append(h[pos:m.start()])
        pos = max(element_end(h, m.group(1), m.start()), m.end())
    return "".join(out) + h[pos:]


def visible(h: str) -> int:
    return len(re.sub(r"\s+", "", re.sub(r"<[^>]+>", "", h)))


def main_part(h: str) -> str:
    """The page's own content: without boilerplate blocks, and only its <main> or longest <article> when that holds
    most of it. Each cut is undone when it would leave too little."""
    whole = visible(h)
    cut = drop_elements(h, BOILER)
    h = cut if visible(cut) >= whole * 0.3 else h
    parts = []
    for tag in ("main", "article"):
        for m in re.finditer(rf"<{tag}\b[^>]*>", h, re.I):
            parts.append(h[m.start():element_end(h, tag, m.start())])
        if parts:
            break
    best = max(parts, key=visible, default="")
    if best and visible(best) >= 500:
        return best
    cut = drop_elements(h, r"<(header|aside)\b[^>]*>")
    return cut if visible(cut) >= visible(h) * 0.3 else h


def html_to_text(html: str, base: str) -> tuple[str, str]:
    """(title, readable text) of an HTML page, its main content only: like the work computer's web_fetch, links kept
    as [text](address)."""
    from html import unescape
    from urllib.parse import urljoin
    title = unescape(re.sub(r"\s+", " ", (re.search(r"<title[^>]*>([\s\S]*?)</title>", html, re.I) or [None, ""])[1])).strip()
    h = re.sub(r"<!--[\s\S]*?-->", "", html)
    h = re.sub(r"<(script|style|noscript|svg|head|title|nav|footer|form|iframe|template|button|dialog)\b[\s\S]*?</\1>", "", h, flags=re.I)
    h = main_part(h)
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
    from urllib.parse import urljoin
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


def raw_github(url: str) -> str:
    """A file's page on GitHub (github.com/o/r/blob/branch/path) as the file itself."""
    m = re.match(r"https?://github\.com/([^/]+)/([^/]+)/blob/([^?#]+)", url)
    return f"https://raw.githubusercontent.com/{m[1]}/{m[2]}/{m[3]}" if m else url


async def fetch_page(cfg: Config, client: httpx.AsyncClient, url: str) -> tuple[str, str, str, str]:
    """(address, title, text, how): DeepSeek's Fetch API when this server has a DeepSeek key (Markdown, also many
    script-built pages), else this server's own fetch."""
    url = raw_github(url)
    key = engine_key(cfg, "deepseek")
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
                           user: str, audit) -> dict:
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
        audit(event="chat", user=user, purpose="extract", model=m.id, status=200,
              ms=int((time.time() - started) * 1000), tokens=tokens, cost=cost(tokens, m.price))
        return {"answer": answer, "model": m.id}
    audit(event="chat", user=user, purpose="extract", status=502, error=last)
    raise RuntimeError(f"no model could read the page ({last})")


def mount(app: FastAPI, cfg: Config, client: httpx.AsyncClient, audit) -> None:
    """POST /v1/ferry/search {query, count, recent, allowed_domains, blocked_domains}: the work computer's web_search.
    POST /v1/ferry/read {url, prompt, offset}: read a public page here; with a prompt only the answer goes back.
    POST /v1/ferry/extract {url, title, prompt, text}: answer a question from a page the work computer fetched."""
    if key_path(cfg).exists() and cfg.search_engine in ENGINES:
        save_key(cfg, cfg.search_engine, saved_keys(cfg).get(cfg.search_engine, ""))
    pages: dict[str, tuple[float, tuple]] = {}  # address -> (when, (address, title, text, how)), 15 minutes
    found: dict[tuple, tuple[float, dict]] = {}  # a search -> (when, its answer), CACHE_SECONDS

    @app.post("/v1/ferry/search")
    async def web_search(request: Request):
        b = await request.json()
        query = str(b.get("query") or "").strip()[:500]
        if not query:
            return JSONResponse({"error": "query is empty"}, 400)
        names = sources(cfg)
        if not names:
            return JSONResponse({"error": "no search engine is set on the Ferry server"}, 404)
        count = max(1, min(int(b.get("count") or 8), 20))
        recent = str(b.get("recent") or "")
        allowed, blocked = domains(b.get("allowed_domains")), domains(b.get("blocked_domains"))
        key = (tuple(names), query, count, recent, tuple(allowed), tuple(blocked))
        hit = found.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            audit(event="search", user=request.state.user, engine=hit[1]["engine"], ok=True, cached=True,
                  results=len(hit[1]["results"]))
            return hit[1]
        started = time.time()
        results, report = await search_all(cfg, client, query, count, recent, allowed, blocked, names)
        failed = {s: r for s, r in report.items() if isinstance(r, str)}
        if len(failed) == len(report):
            audit(event="search", user=request.state.user, engine="+".join(names), ok=False)
            return JSONResponse({"error": "; ".join(failed.values())[:600]}, 502)
        await add_passages(cfg, client, query, results, pages)
        out = {"engine": "+".join(s for s, r in report.items() if r and not isinstance(r, str)) or "+".join(names),
               "results": [public(x) for x in results], **({"failed": failed} if failed else {})}
        audit(event="search", user=request.state.user, engine=out["engine"], ok=True, results=len(results),
              ms=int((time.time() - started) * 1000))
        if results:
            found[key] = (time.time(), out)
            while len(found) > 200:
                found.pop(next(iter(found)))
        return out

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
            audit(event="read", user=request.state.user, ok=False)
            return JSONResponse({"unreachable": str(e)}, 422)
        pages[url] = (time.time(), page)
        while len(pages) > 200:
            pages.pop(next(iter(pages)))
        address, title, text, how = page
        audit(event="read", user=request.state.user, ok=True, via=how, chars=len(text))
        if prompt and not offset:
            try:
                out = await answer_from_page(client, cfg, address, title, text, prompt, request.state.user, audit)
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
                                         request.state.user, audit)
        except RuntimeError as e:
            return JSONResponse({"error": str(e)}, 502)
        return {**out, "chars": len(text)}
