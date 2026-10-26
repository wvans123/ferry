"""Web access on behalf of the work computer: read a page (fetch) and search (Bing or DuckDuckGo).

The work computer usually cannot reach the internet; the Ferry server can. Like Cursor's and Claude Code's web
tools, the request runs here and only text goes back. Off unless switched on in the admin page.

Safety: only http(s); never this machine or its local network (the admin page trusts requests from 127.0.0.1, so a
fetch must never reach it); every redirect is checked again; an optional allow list of sites; size and time limits.
"""
from __future__ import annotations

import asyncio
import html
import ipaddress
import os
import re
import socket
from html.parser import HTMLParser
from urllib.parse import parse_qs, quote_plus, unquote, urljoin, urlparse

import httpx

MAX_DOWNLOAD = 3_000_000
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/130.0 Safari/537.36 Ferry")


class WebError(Exception):
    pass


def host_allowed(host: str, allow: list[str]) -> bool:
    """Empty list: every site. Otherwise the host or one of its parents is listed (github.com covers api.github.com)."""
    host = host.lower().rstrip(".")
    if not allow:
        return True
    for a in allow:
        a = a.strip().lower().lstrip("*.").rstrip("/")
        if a and (host == a or host.endswith("." + a)):
            return True
    return False


async def check_public(host: str) -> None:
    """Refuse names that point at this machine or a private network."""
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError as e:
        raise WebError(f"cannot resolve {host}: {e}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise WebError(f"{host} points to a local or private address; not allowed")


async def _get(url: str, allow: list[str], proxy: str, timeout: float, method="GET", data=None) -> httpx.Response:
    async with httpx.AsyncClient(proxy=proxy or None, timeout=timeout, follow_redirects=False,
                                 headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"}) as c:
        for _ in range(6):
            u = urlparse(url)
            if u.scheme not in ("http", "https") or not u.hostname:
                raise WebError("only http and https addresses can be fetched")
            if not host_allowed(u.hostname, allow):
                raise WebError(f"{u.hostname} is not in the server's list of allowed sites")
            # through a proxy, the proxy resolves names; it cannot reach this machine's admin page
            if not proxy and not os.environ.get("FERRY_TEST_WEB_LOCAL"):
                await check_public(u.hostname)
            async with c.stream(method, url, data=data) as r:
                if r.is_redirect and r.headers.get("location"):
                    url = urljoin(url, r.headers["location"])
                    method, data = "GET", None
                    continue
                body = bytearray()
                async for chunk in r.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > MAX_DOWNLOAD:
                        break
                r._content = bytes(body)  # noqa: SLF001 - keep what was read, at most MAX_DOWNLOAD
                r.url_final = url  # type: ignore[attr-defined]
                return r
        raise WebError("too many redirects")


class _Text(HTMLParser):
    """HTML to readable text with a little Markdown: headings, links, list items, code blocks."""

    SKIP = {"script", "style", "noscript", "svg", "head", "nav", "footer", "form", "iframe", "template"}
    BLOCK = {"p", "div", "section", "article", "main", "br", "tr", "table", "ul", "ol", "header", "aside",
             "blockquote", "dl", "dt", "dd", "figure", "hr"}

    def __init__(self, base: str):
        super().__init__(convert_charrefs=True)
        self.base, self.out, self.skip, self.pre, self.title, self.in_title, self.href = base, [], 0, 0, "", False, None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in self.SKIP:
            self.skip += 1
        if tag == "title":
            self.in_title = True
        if self.skip:
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.out.append("\n\n" + "#" * int(tag[1]) + " ")
        elif tag == "li":
            self.out.append("\n- ")
        elif tag == "pre":
            self.pre += 1
            self.out.append("\n```\n")
        elif tag == "code" and not self.pre:
            self.out.append("`")
        elif tag == "a" and a.get("href") and not a["href"].startswith(("javascript:", "#")):
            self.href = urljoin(self.base, a["href"])
            self.out.append("[")
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        if tag == "title":
            self.in_title = False
        if self.skip:
            return
        if tag == "pre":
            self.pre = max(0, self.pre - 1)
            self.out.append("\n```\n")
        elif tag == "code" and not self.pre:
            self.out.append("`")
        elif tag == "a" and self.href:
            self.out.append(f"]({self.href})")
            self.href = None
        elif tag in self.BLOCK or tag.startswith("h") and len(tag) == 2:
            self.out.append("\n")

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        if self.skip:
            return
        self.out.append(data if self.pre else re.sub(r"\s+", " ", data))

    def text(self) -> str:
        t = "".join(self.out)
        t = re.sub(r"\[\s*\]\([^)]*\)", "", t)  # links without text
        t = re.sub(r"[ \t]+\n", "\n", t)
        return re.sub(r"\n{3,}", "\n\n", t).strip()


def to_text(body: bytes, content_type: str, url: str) -> tuple[str, str]:
    """(title, text) of a response body."""
    charset = re.search(r"charset=([\w-]+)", content_type or "")
    raw = body.decode(charset.group(1) if charset else "utf-8", errors="replace")
    if "html" in (content_type or "") or raw.lstrip()[:200].lower().startswith(("<!doctype html", "<html")):
        meta = re.search(r'<meta[^>]+charset=["\']?([\w-]+)', raw[:3000], re.I)
        if meta and not charset and meta.group(1).lower() not in ("utf-8", "utf8"):
            raw = body.decode(meta.group(1), errors="replace")
        p = _Text(url)
        p.feed(raw)
        return html.unescape(p.title.strip()), p.text()
    return "", raw


async def fetch(url: str, *, allow: list[str], proxy: str = "", offset: int = 0, max_chars: int = 40_000) -> dict:
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    r = await _get(url, allow, proxy, timeout=25)
    ctype = r.headers.get("content-type", "")
    if not any(t in ctype for t in ("text", "html", "json", "xml", "javascript")) and ctype:
        raise WebError(f"{ctype} is not text; only web pages and text files can be read")
    title, text = to_text(r.content, ctype, r.url_final)
    part = text[offset:offset + max_chars]
    more = len(text) > offset + max_chars
    return {"url": r.url_final, "status": r.status_code, "title": title, "content_type": ctype.split(";")[0],
            "chars": len(text), "offset": offset, "text": part,
            "next_offset": offset + max_chars if more else None, "bytes": len(r.content)}


def _bing_target(url: str) -> str:
    """Bing wraps result links as bing.com/ck/a?...&u=a1<base64url of the real address>."""
    import base64

    q = parse_qs(urlparse(url).query).get("u")
    if "bing.com/ck/" in url and q and q[0].startswith("a1"):
        b = q[0][2:]
        try:
            return base64.urlsafe_b64decode(b + "=" * (-len(b) % 4)).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return url
    return url


def _bing(body: str) -> list[dict]:
    out = []
    for block in re.findall(r'<li class="b_algo"[^>]*>(.*?)</li>', body, re.S):
        a = re.search(r'<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', block, re.S)
        if not a:
            continue
        snip = re.search(r'<p[^>]*>(.*?)</p>', block, re.S)
        clean = lambda s: html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()  # noqa: E731
        out.append({"title": clean(a.group(2)), "url": _bing_target(html.unescape(a.group(1))),
                    "snippet": clean(snip.group(1) if snip else "")})
    return out


def _ddg(body: str) -> list[dict]:
    out = []
    for m in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>(.*?)(?=<a[^>]+class="result__a"|$)', body, re.S):
        href = html.unescape(m.group(1))
        q = parse_qs(urlparse(href).query).get("uddg")
        snip = re.search(r'class="result__snippet"[^>]*>(.*?)</a>', m.group(3), re.S)
        clean = lambda s: html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()  # noqa: E731
        out.append({"title": clean(m.group(2)), "url": unquote(q[0]) if q else href,
                    "snippet": clean(snip.group(1) if snip else "")})
    return out


async def search(query: str, *, engine: str = "bing", allow: list[str], proxy: str = "", count: int = 8,
                 base: str = "") -> dict:
    """Search results: title, url, snippet. `base` replaces the engine's address (tests)."""
    if engine == "duckduckgo":
        url = (base or "https://html.duckduckgo.com") + "/html/"
        r = await _get(url, [], proxy, timeout=20, method="POST", data={"q": query})
        results = _ddg(r.text)
    else:
        url = (base or "https://www.bing.com") + f"/search?q={quote_plus(query)}&setlang=zh-Hans"
        r = await _get(url, [], proxy, timeout=20)
        results = _bing(r.text)
    if allow:
        results = [x for x in results if host_allowed(urlparse(x["url"]).hostname or "", allow)]
    return {"query": query, "engine": engine, "results": results[:count]}
