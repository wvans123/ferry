"""Search eval: how often each search source, and the server's combined search, puts the right page in the top 5.

    python evals/search_eval.py                       every source this server can use, Bing, then the combined search
    python evals/search_eval.py --sources exa,bing    only these (and the combined search of the server's sources)
    python evals/search_eval.py --only ts38331,cn_5ga --no-combined

It uses the Ferry server's own settings and keys (FERRY_SERVER_HOME, default ~/.ferry-server; keys from the admin
page, FERRY_SEARCH_KEY_<ENGINE>, the DeepSeek key of its models), so run it on the server's computer. Sources without
a key are left out. "bing" reads Bing's result page from this computer, as the work computer does without the server.
The queries and their pass rules are in evals/search/queries.json; a result file goes to evals/search/results/.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import statistics
import sys
import time
from html import unescape
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))

import httpx  # noqa: E402

from ferry_server import search  # noqa: E402
from ferry_server.config import load_default  # noqa: E402

TOP = 5


async def bing(client: httpx.AsyncClient, query: str, count: int) -> list[dict]:
    """Bing's result page, read like the work computer's web_search does without the server."""
    import base64
    r = await client.get("https://www.bing.com/search", params={"q": query, "setlang": "zh-Hans", "adlt": "strict"},
                         headers={"User-Agent": search.UA, "Cookie": "SRCHHPGUSR=ADLT=STRICT"}, timeout=20,
                         follow_redirects=True)
    out = []
    for block in re.findall(r'<li class="b_algo"[^>]*>[\s\S]*?</li>', r.text):
        a = re.search(r'<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)</a>', block)
        if not a:
            continue
        url = unescape(a[1])
        u = re.search(r"[?&]u=a1([^&]+)", url)
        if "bing.com/ck/" in url and u:
            url = base64.urlsafe_b64decode(u[1] + "=" * (-len(u[1]) % 4)).decode("utf-8", "replace")
        out.append({"title": unescape(re.sub(r"<[^>]+>", "", a[2])).strip(), "url": url})
    return out[:count]


def passed(urls: list[str], expect: list[str]) -> bool:
    return any(e in u.lower() for u in urls[:TOP] for e in expect)


async def run_source(cfg, client, name: str, q: dict) -> dict:
    started = time.time()
    try:
        rows = await (bing(client, q["q"], 8) if name == "bing" else
                      asyncio.wait_for(search.search_one(cfg, client, name, q["q"], 8), search.MODEL_TIMEOUT))
        err = ""
    except Exception as e:  # noqa: BLE001 - an eval records the failure and goes on
        rows, err = [], repr(e)[:200]
    urls = [x.get("url", "") for x in rows]
    return {"ok": passed(urls, q["expect"]), "ms": int((time.time() - started) * 1000), "n": len(rows),
            "top": urls[:TOP], **({"error": err} if err else {})}


async def run_combined(cfg, client, names: list[str], q: dict) -> dict:
    """What /v1/ferry/search does: all sources at once, merged, passages from the top pages."""
    started = time.time()
    results, report = await search.search_all(cfg, client, q["q"], 8, names=names)
    await search.add_passages(cfg, client, q["q"], results)
    out = [search.public(x) for x in results]
    urls = [x["url"] for x in out]
    return {"ok": passed(urls, q["expect"]), "ms": int((time.time() - started) * 1000), "n": len(out), "top": urls[:TOP],
            "chars": len(json.dumps(out, ensure_ascii=False)), "passages": sum(len(x.get("passages", [])) for x in out),
            "sources": report}


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sources", default="", help="comma-separated: deepseek, tavily, brave, bocha, exa, model:<id>, bing")
    ap.add_argument("--only", default="", help="comma-separated query ids")
    ap.add_argument("--no-combined", action="store_true", help="leave out the combined search")
    ap.add_argument("--parallel", type=int, default=2, help="queries at a time (Exa's free search refuses many at once)")
    a = ap.parse_args()
    cfg = load_default()
    queries = json.loads((HERE / "search" / "queries.json").read_text(encoding="utf-8"))
    if a.only:
        queries = [q for q in queries if q["id"] in a.only.split(",")]
    server = search.sources(cfg)
    names = [s.strip() for s in a.sources.split(",") if s.strip()] or [*server, "bing"]
    combined = [s for s in names if s != "bing"] if a.sources else server
    print(f"{len(queries)} queries; sources: {', '.join(names)}"
          + ("" if a.no_combined or not combined else f"; combined: {'+'.join(combined)}"), flush=True)
    gate = asyncio.Semaphore(a.parallel)
    runs: dict[str, dict[str, dict]] = {n: {} for n in names}
    if combined and not a.no_combined:
        runs["combined"] = {}

    async with httpx.AsyncClient() as client:
        async def one(q):
            async with gate:
                for n in names:
                    runs[n][q["id"]] = await run_source(cfg, client, n, q)
                if "combined" in runs:
                    runs["combined"][q["id"]] = await run_combined(cfg, client, combined, q)
                marks = " ".join(f"{n}:{'✓' if runs[n][q['id']]['ok'] else '✗'}" for n in runs)
                print(f"  {q['id']:<18} {marks}", flush=True)
        await asyncio.gather(*(one(q) for q in queries))

    print(f"\n{'source':<22}{'hit@5':>8}{'median ms':>11}{'failed':>8}")
    summary = {}
    for n, rows in runs.items():
        hits = sum(r["ok"] for r in rows.values())
        ms = statistics.median([r["ms"] for r in rows.values()]) if rows else 0
        bad = sum(1 for r in rows.values() if r.get("error") or not r["n"])
        summary[n] = {"hit": hits, "of": len(rows), "median_ms": int(ms), "failed": bad}
        extra = ""
        if n == "combined" and rows:
            extra = (f"   ~{int(statistics.mean(r['chars'] for r in rows.values()))} characters, "
                     f"{statistics.mean(r['passages'] for r in rows.values()):.1f} passages per search")
        print(f"{n:<22}{f'{hits}/{len(rows)}':>8}{int(ms):>11}{bad:>8}{extra}")
    out = HERE / "search" / "results" / f"{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "runs": runs}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nsaved {out.relative_to(HERE.parent)}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
