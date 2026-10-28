"""Ferry server HTTP API.

  GET  /health                               liveness (no auth)
  GET  /v1/ferry/models                      models this user may use
  POST /v1/ferry/check                       send each model a tiny request (used by `ferry doctor`)
  POST /v1/ferry/upload/{upload}/{seq}       one part of a large upload (raw bytes)
  POST /v1/ferry/commit?conv=&base=&base_hash=[&upload=&parts=]
                                             append messages to the session cache; 409 = base mismatch
  POST /v1/chat/completions                  OpenAI-compatible; a "ferry" field refers to the session cache

Every request body is limited to max_body_bytes (413 above it). Access and audit logs never contain
conversation text.
"""
from __future__ import annotations

import hmac
import json
import os
import secrets
import time
import uuid
from urllib.parse import unquote, urlparse
from collections import Counter, deque
from types import SimpleNamespace

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

from . import PROTOCOL, __version__
from .config import Config, refresh_models
from .presets import anthropic_url, chat_url
from .usage import AnthropicSSEUsage, normalize
from .usage import cost as usage_cost
from .pool import RETRY_STATUSES, Pool, groups
from .prompt import (adapt_params, add_cache_marks, apply_rules, cap_upstream, estimate_tokens, load_rules, overflow_message,
                     restore_cache_marks, wants_cache_marks)
from .redact import Redactor
from .store import BaseMismatch, MissingBlobs, Store
from .stream import restore_message, restore_sse


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def details_of(call_id: str, payload: dict, project: str, model: str, purpose: str, size: int) -> dict:
    """What the model is about to receive, after server rules and redaction. Kept in memory only."""
    msgs = payload.get("messages", [])
    system = "\n\n".join(_text(m.get("content")) for m in msgs if m.get("role") in ("system", "developer"))
    users = [m for m in msgs if m.get("role") == "user"]
    tools = [t.get("function", {}).get("name", "") for t in payload.get("tools") or []]
    return {"id": call_id, "ts": round(time.time(), 3), "project": project, "model": model, "purpose": purpose,
            "bytes": size, "messages": len(msgs), "system": system[:60_000],
            "last_user": _text(users[-1].get("content"))[:20_000] if users else "", "tools": tools}


def create_app(cfg: Config) -> FastAPI:
    app = FastAPI(title="Ferry server", version=__version__)
    # session store and redactor can be swapped at run time from the admin page (settings, word list)
    live = SimpleNamespace(store=None, red=None, started=time.time(), details=deque(maxlen=20), pool=Pool(),
                           no_marks=set())  # models whose relay refused cache markers

    def rebuild(store_too: bool = True) -> None:
        if store_too or live.store is None:
            live.store = Store(cfg.data_dir / "ferry.db" if cfg.session_store == "disk" else ":memory:",
                               cfg.session_ttl_days)
        live.red = Redactor(cfg.dictionary if cfg.redact else None, cfg.secret, live.store)

    rebuild()
    client = httpx.AsyncClient(timeout=httpx.Timeout(600, connect=15))
    access_log = cfg.data_dir / "access.jsonl"
    audit_log = cfg.data_dir / "audit.jsonl"
    drop_every = int(os.environ.get("FERRY_TEST_DROP_EVERY", "0"))  # test hook: forget sessions every N commits
    drop_before_chat = int(os.environ.get("FERRY_TEST_DROP_BEFORE_CHAT", "0"))  # test hook: forget before every Nth chat
    # test hook: act like a Cloudflare Access login in front of the server for requests without this header
    gate_header = os.environ.get("FERRY_TEST_REQUIRE_HEADER", "").lower()
    counter = {"commits": 0, "chats": 0}

    def find_user(auth: str) -> str | None:
        if not auth.startswith("Bearer "):
            return None
        given = auth[7:].encode("utf-8")
        found = None
        for token, name in cfg.users.items():  # compare every token in constant time
            if hmac.compare_digest(given, token.encode("utf-8")):
                found = name
        return found

    def key(request: Request, ident: str) -> str:
        """Sessions and uploads live in each user's own namespace."""
        return f"{request.state.user}\x1f{ident}"

    def write(log_file, **row):
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": round(time.time(), 3), **row}, ensure_ascii=False) + "\n")

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if gate_header and gate_header not in request.headers:
            return Response(status_code=302, headers={
                "location": "https://example.cloudflareaccess.com/cdn-cgi/access/login/ferry"})
        gate_file = os.environ.get("FERRY_TEST_GATEWAY_FILE")  # self-test: a company gateway until "confirmed"
        if gate_file and not os.path.exists(gate_file):
            return Response(status_code=302, headers={"location": "http://127.0.0.1:9100/proxycontrolwarn?url=ferry"})
        if request.url.path == "/health" or request.url.path.startswith("/admin"):
            return await call_next(request)  # the admin page has its own, local-only sign-in
        if request.method == "GET" and request.url.path in ("/", "/favicon.ico", "/robots.txt"):
            # a browser lands here, e.g. after the company gateway's confirmation page: not an error, not logged
            if request.url.path != "/":
                return Response(status_code=204)
            return HTMLResponse("<!doctype html><meta charset=utf-8><title>Ferry</title>"
                                "<p style='font:16px system-ui;margin:40px'>Ferry 服务端在运行。可以关掉这个页面，回到 ferry 继续。</p>")
        body = await request.body()
        # Bearer for the OpenAI-style calls; x-api-key for the Anthropic-style ones (the Anthropic SDK sends that)
        user = find_user(request.headers.get("authorization", "")) or find_user(f"Bearer {request.headers.get('x-api-key', '')}")
        proto = request.headers.get("x-ferry-protocol")
        status = 200
        if proto and proto.split(".")[0] != PROTOCOL:
            status = 426
            resp = JSONResponse({"error": {"message": f"client protocol {proto}, server protocol {PROTOCOL}: "
                                                      f"update the older side"}}, status_code=426)
        elif len(body) > cfg.max_body_bytes:
            status = 413
            resp = JSONResponse({"error": {"message": f"request body {len(body)} bytes exceeds the "
                                                      f"{cfg.max_body_bytes}-byte limit"}}, status_code=413)
        elif user is None:
            status = 401
            resp = JSONResponse({"error": {"message": "invalid or missing Ferry token"}}, status_code=401)
        else:
            request.state.user = user
            resp = await call_next(request)
            status = resp.status_code
        write(access_log, user=user, path=request.url.path, bytes=len(body), status=status)
        return resp

    @app.get("/health")
    async def health():
        return {"ok": True, "version": __version__, "protocol": PROTOCOL}

    def describe(m, mid=None) -> dict:
        return {"id": mid or m.id, "contextWindow": m.context_window, "maxTokens": m.max_tokens,
                "ready": m.ready, "keyEnv": m.api_key_env, "model": m.model, "api": m.api, "vision": m.vision,
                "price": m.price}

    def reload() -> None:
        err = refresh_models(cfg)
        if err:
            print(f"models.toml not applied, still using the previous models: {err}", flush=True)
            write(audit_log, event="models_file_error", error=err[:300])

    @app.get("/v1/ferry/models")
    async def models():
        """The client sees "auto" (the server picks); other models only when routing.expose is on."""
        reload()
        d = cfg.models[cfg.default_model]
        auto = {**describe(d, "auto"), "routesTo": d.id}
        if cfg.summary_model:  # a summary request carries the whole history, so it must fit the smaller window
            auto["contextWindow"] = min(d.context_window, cfg.models[cfg.summary_model].context_window)
            auto["summaryTo"] = cfg.summary_model
        # a model several providers offer is listed once; the server spreads conversations over the providers
        shared = groups(cfg)
        listed = [auto]
        for m in cfg.models.values() if cfg.expose_models else []:
            ids = shared.get(m.id)
            if ids and any(x["id"] in ids for x in listed[1:]):
                continue  # another provider's copy of this model is listed already
            row = describe(m)
            if ids:
                row["contextWindow"] = min(cfg.models[i].context_window for i in ids)
                row["providers"] = len(ids)
            listed.append(row)
        if shared.get(d.id):
            auto["providers"] = len(shared[d.id])
            auto["contextWindow"] = min(auto["contextWindow"], *(cfg.models[i].context_window for i in shared[d.id]))
        return {"models": listed, "sessionStore": cfg.session_store, "web": cfg.web_enabled,
                "features": ["refs"] if cfg.session_store != "none" else []}

    async def web_call(request: Request, kind: str):
        from . import web

        if not cfg.web_enabled:
            return JSONResponse({"error": {"message": "web access is switched off on the Ferry server "
                                           "(admin page > 设置 > 联网)"}}, status_code=403)
        b = json.loads(await request.body() or b"{}")
        started = time.time()
        what = b.get("url", "") if kind == "fetch" else b.get("query", "")
        row = dict(event="web", id=uuid.uuid4().hex[:12], user=request.state.user,
                   project=unquote(request.headers.get("x-ferry-project", "")), kind=kind,
                   host=(urlparse(what).hostname or what[:60]) if kind == "fetch" else cfg.web_engine)
        try:
            if kind == "fetch":
                out = await web.fetch(str(what), allow=cfg.web_allow, proxy=cfg.web_proxy,
                                      offset=max(0, int(b.get("offset") or 0)))
            else:
                out = await web.search(str(what), engine=cfg.web_engine, allow=cfg.web_allow, proxy=cfg.web_proxy,
                                       count=max(1, min(int(b.get("count") or 8), 20)),
                                       base=os.environ.get("FERRY_TEST_SEARCH_BASE", ""))
        except (web.WebError, httpx.HTTPError) as e:
            write(audit_log, **row, status=502, ms=int((time.time() - started) * 1000), error=str(e)[:200])
            return JSONResponse({"error": {"message": f"{type(e).__name__}: {e}" if not isinstance(e, web.WebError) else str(e)}},
                                status_code=502)
        size = len(json.dumps(out, ensure_ascii=False).encode())
        write(audit_log, **row, status=200, ms=int((time.time() - started) * 1000), upstream_bytes=size)
        return out

    @app.post("/v1/ferry/web/fetch")
    async def web_fetch(request: Request):
        return await web_call(request, "fetch")

    @app.post("/v1/ferry/web/search")
    async def web_search(request: Request):
        return await web_call(request, "search")

    def route(requested: str, purpose: str):
        """The server decides which model answers. A client may name one only when routing.expose is on."""
        if cfg.expose_models and requested in cfg.models:
            return cfg.models[requested]
        default = cfg.models[cfg.default_model]
        if purpose == "summary" and cfg.summary_model and cfg.models[cfg.summary_model].api == default.api:
            return cfg.models[cfg.summary_model]  # (a summary model with another API cannot take this request)
        return default

    async def run_check(want: str | list | None, user: str) -> list[dict]:
        """Ask each model (or the one named) for a two-word answer: proves the key, the network path and the model
        name work, which `ferry doctor` cannot know otherwise. Costs a few tokens."""
        reload()
        out = []
        for m in list(cfg.models.values()):
            if want and m.id not in (want if isinstance(want, list) else [want]):
                continue
            row = {"id": m.id, "model": m.model, "base_url": m.base_url}
            if not m.ready:
                out.append({**row, "ok": False, "error": (f"{m.api_key_env} is not set" if m.api_key_env
                                                          else "no API key: add it on the admin page")})
                continue
            t = time.time()
            if m.api == "anthropic":
                body = {"model": m.model, "max_tokens": 64, "messages": [{"role": "user", "content": "Reply with OK"}]}
                url, headers = anthropic_url(m.base_url), {"x-api-key": m.api_key, "anthropic-version": "2023-06-01"}
            else:
                body = adapt_params({"model": m.id, "max_completion_tokens": 32,
                                     "messages": [{"role": "user", "content": "Reply with OK"}]}, m)
                url, headers = chat_url(m.base_url), {"Content-Type": "application/json"}
                if m.api_key:
                    headers["Authorization"] = f"Bearer {m.api_key}"
            try:
                r = await client.post(url, json=body, headers=headers, timeout=60)
                ok = r.status_code == 200
                err = "" if ok else f"HTTP {r.status_code}: {r.text[:300]}"
            except httpx.HTTPError as e:
                ok, err = False, f"{type(e).__name__}: {e}"
            extra = {}
            if ok and wants_cache_marks(m):  # a Claude relay: does it also speak Claude's own API (better caching)?
                try:
                    a = await client.post(anthropic_url(m.base_url), timeout=30, json={
                        "model": m.model, "max_tokens": 16, "messages": [{"role": "user", "content": "Reply with OK"}]},
                        headers={"x-api-key": m.api_key, "Authorization": f"Bearer {m.api_key}", "anthropic-version": "2023-06-01"})
                    extra["anthropic"] = a.status_code == 200 and "content" in a.text
                except httpx.HTTPError:
                    extra["anthropic"] = False
            out.append({**row, "ok": ok, "ms": int((time.time() - t) * 1000), **extra, **({"error": err} if err else {})})
            write(audit_log, event="check", user=user, model=m.id, ok=ok)
        return out

    @app.post("/v1/ferry/check")
    async def check(request: Request):
        want = (json.loads(await request.body() or b"{}") or {}).get("model")
        return {"models": await run_check(want, request.state.user)}

    @app.post("/v1/ferry/upload/{upload}/{seq}")
    async def upload(upload: str, seq: int, request: Request):
        live.store.put_part(key(request, upload), seq, await request.body())
        return {"ok": True}

    @app.post("/v1/ferry/have")
    async def have(request: Request):
        """After a restart or /resume the client asks which messages the server still has, and sends only the rest."""
        hashes = [str(h) for h in (json.loads(await request.body() or b"{}").get("hashes") or [])][:20000]
        return {"have": live.store.have(request.state.user or "", hashes)}

    @app.post("/v1/ferry/probe")
    async def probe(request: Request):
        """ferry doctor --upload: how big an upload gets through (the body is read and thrown away)."""
        return {"bytes": len(await request.body())}

    @app.post("/v1/ferry/commit")
    async def commit(request: Request, conv: str, base: int, base_hash: str = "", upload: str = "", parts: int = 0):
        try:
            raw = live.store.take_upload(key(request, upload), parts) if upload else await request.body()
        except ValueError as e:
            raise HTTPException(400, str(e))
        blob = json.loads(raw.decode("utf-8"))
        counter["commits"] += 1
        if drop_every and counter["commits"] % drop_every == 0:
            live.store.drop_sessions()
            write(audit_log, event="test_drop")
        try:
            count, h = live.store.commit(key(request, conv), base, base_hash, blob.get("append") or [], blob.get("tools"),
                                         owner=request.state.user or "", keep_blobs=cfg.session_store != "none")
        except BaseMismatch as e:
            return JSONResponse({"error": "base mismatch", "count": e.count, "hash": e.hash}, status_code=409)
        except MissingBlobs as e:
            return JSONResponse({"error": "missing messages", "missing": e.missing[:50]}, status_code=409)
        write(audit_log, event="commit", user=request.state.user, conv=conv[:12], base=base,
              appended=len(blob.get("append") or []), count=count, upload_bytes=len(raw), parts=parts)
        return {"count": count, "hash": h}

    @app.post("/v1/chat/completions")
    async def chat(request: Request):
        started = time.time()
        reload()
        payload = json.loads(await request.body())
        ref = payload.pop("ferry", None)
        counter["chats"] += 1
        if ref and drop_before_chat and counter["chats"] % drop_before_chat == 0:
            live.store.drop_sessions()
            write(audit_log, event="test_drop_before_chat")
        if ref:
            try:
                payload["messages"], tools = live.store.load(key(request, ref["conv"]), ref["count"], ref["hash"],
                                                        ref.get("tools_hash"))
            except KeyError as e:
                return JSONResponse({"error": {"message": f"{e.args[0]}; the client will resend"}}, status_code=409)
            if tools is not None:
                payload["tools"] = tools
        purpose = (ref or {}).get("purpose") or "agent"
        if purpose not in ("agent", "summary", "subagent"):
            purpose = "agent"
        model = route(payload.get("model", ""), purpose)
        if model.api == "anthropic":
            return JSONResponse({"error": {"message": f"model {model.id} uses the Anthropic API; update the Ferry client "
                                                      "(ferry update) to talk to it"}}, status_code=400)

        project = unquote(request.headers.get("x-ferry-project", ""))  # sent URL-encoded: folder names can be Chinese
        rules = load_rules(cfg.rules_dir, project)
        if not cfg.redact:  # no placeholders will appear, so the note about them is noise
            rules = "\n".join(l for l in rules.splitlines() if "[FERRY-...]" not in l).strip()
        if purpose == "summary" and cfg.rules_dir and (cfg.rules_dir / "_summary.md").is_file():
            extra = (cfg.rules_dir / "_summary.md").read_text(encoding="utf-8").strip()
            rules = f"{rules}\n\n{extra}".strip() if extra else rules
        apply_rules(payload, rules)
        user = request.state.user
        hits: Counter = live.red.mask_payload(payload, user)
        trimmed, size = cap_upstream(payload, cfg.max_upstream_bytes)
        if cfg.max_upstream_bytes and size > cfg.max_upstream_bytes:
            write(audit_log, event="chat", user=user, project=project, model=model.id, status=413, trimmed=trimmed,
                  upstream_bytes=size)
            return JSONResponse({"error": {"message": f"the conversation is still {size:,} bytes after dropping old "
                                                      f"tool outputs (limit {cfg.max_upstream_bytes:,}): "
                                                      "context_length_exceeded. The history will be summarised.",
                                           "code": "context_length_exceeded"}}, status_code=413)
        conv = key(request, ref["conv"]) if ref else ""
        tries = live.pool.order(cfg, model, conv)
        model = tries[0]
        if not model.ready:
            how = (f"set {model.api_key_env} and restart ferry-server" if model.api_key_env
                   else "add the key on the server's admin page")
            return JSONResponse({"error": {"message": f"the Ferry server has no API key for model {model.id}: {how}"}},
                                status_code=503)
        tokens_est = estimate_tokens(payload)
        if tokens_est > model.context_window * 1.15:  # the client thinks the model holds more than it does
            write(audit_log, event="chat", user=user, project=project, model=model.id, status=400, overflow=tokens_est)
            return JSONResponse({"error": {"message": overflow_message(tokens_est, model.context_window, model.id),
                                           "type": "invalid_request_error", "code": "context_length_exceeded"}},
                                status_code=400)
        call_id = secrets.token_hex(4)

        def done() -> None:
            if ref and cfg.session_store == "none":
                live.store.forget(key(request, ref["conv"]))

        last_err: tuple[int, bytes, str] = (502, b'{"error":{"message":"no provider answered"}}', "application/json")
        refused_marks = False
        attempts = []
        for model in tries:  # with cache markers first where they help; the same without if the relay refuses them
            if wants_cache_marks(model) and model.id not in live.no_marks:
                attempts.append((model, True))
            attempts.append((model, False))
        tries = attempts
        for n, (model, marks) in enumerate(tries):
            if not marks and n and tries[n - 1][0] is model and tries[n - 1][1] and not refused_marks:
                continue  # the marked request got an answer that was not about the markers
            sent = adapt_params(add_cache_marks(payload) if marks else payload, model)
            body = json.dumps(sent, ensure_ascii=False).encode("utf-8")
            if cfg.record_details and n == 0:
                live.details.append(details_of(call_id, payload, project, model.id, purpose, len(body)))
            audit = dict(event="chat", id=call_id, user=request.state.user, project=project, model=model.id,
                         purpose=purpose, messages=len(payload.get("messages", [])), upstream_bytes=len(body),
                         masked=dict(hits), trimmed=trimmed, **({"attempt": n + 1} if n else {}))
            headers = {"Content-Type": "application/json"}
            if model.api_key:
                headers["Authorization"] = f"Bearer {model.api_key}"
            url = chat_url(model.base_url)
            more = n + 1 < len(tries)
            refused_marks = False
            live.pool.start(model.id)
            try:
                if not payload.get("stream"):
                    r = await client.post(url, content=body, headers=headers)
                else:
                    r = await client.send(client.build_request("POST", url, content=body, headers=headers), stream=True)
            except httpx.HTTPError as e:
                live.pool.end(model.id)
                live.pool.failed(model.id, None)
                write(audit_log, **audit, status=502, error=f"{type(e).__name__}: {e}"[:200], ms=int((time.time() - started) * 1000))
                last_err = (502, json.dumps({"error": {"message": f"cannot reach {model.id}: {type(e).__name__}"}}).encode(), "application/json")
                if more:
                    continue
                break
            if r.status_code != 200:
                err = await r.aread()
                await r.aclose()
                live.pool.end(model.id)
                write(audit_log, **audit, status=r.status_code, ms=int((time.time() - started) * 1000))
                last_err = (r.status_code, err, r.headers.get("content-type", "application/json"))
                if marks and r.status_code in (400, 422):  # this relay does not take cache markers: never again
                    live.no_marks.add(model.id)
                    refused_marks = True
                    write(audit_log, event="cache_marks_refused", model=model.id)
                    continue
                if more and r.status_code in RETRY_STATUSES:
                    live.pool.failed(model.id, r.status_code)
                    continue
                break
            live.pool.served(conv, model.id)
            if not payload.get("stream"):
                live.pool.end(model.id)
                tokens = normalize(r.json().get("usage") or {})
                write(audit_log, **audit, status=200, ms=int((time.time() - started) * 1000),
                      tokens=tokens, cost=usage_cost(tokens, model.price))
                done()
                return JSONResponse(restore_message(r.json(), live.red, user))
            usage: dict = {}

            async def relay(upstream=r, model=model, audit=audit):
                try:
                    async for b in restore_sse(upstream.aiter_lines(), live.red, usage, user):
                        yield b
                finally:
                    live.pool.end(model.id)
                    tokens = normalize(usage)
                    write(audit_log, **audit, status=200, ms=int((time.time() - started) * 1000), usage=usage,
                          tokens=tokens, cost=usage_cost(tokens, model.price))
                    done()

            return StreamingResponse(relay(), media_type="text/event-stream", background=BackgroundTask(r.aclose))
        done()
        return Response(last_err[1], status_code=last_err[0], media_type=last_err[2])

    @app.post("/anthropic/v1/messages")
    async def anthropic_messages(request: Request):
        """Claude through its own Messages API (prompt caching, thinking, images). The client's pi sends a normal
        Anthropic request in which the conversation is replaced by a reference to the server's copy (synced like
        the OpenAI-style requests); the system prompt travels as the first synced item. Redaction does not apply."""
        started = time.time()
        reload()
        payload = json.loads(await request.body())
        ref = payload.pop("ferry", None)
        if ref:
            try:
                payload["messages"], tools = live.store.load(key(request, ref["conv"]), ref["count"], ref["hash"],
                                                        ref.get("tools_hash"))
            except KeyError as e:
                return JSONResponse({"type": "error", "error": {"type": "not_found_error",
                                                                "message": f"{e.args[0]}; the client will resend"}}, status_code=409)
            if tools is not None:
                payload["tools"] = tools
            restore_cache_marks(payload, ref.get("cache") or [])
        msgs = payload.get("messages") or []
        if msgs and msgs[0].get("role") == "__system__":
            payload["system"] = msgs.pop(0).get("content")
        purpose = (ref or {}).get("purpose") or "agent"
        if purpose not in ("agent", "summary", "subagent"):
            purpose = "agent"
        model = route(payload.get("model", ""), purpose)
        if model.api != "anthropic":
            return JSONResponse({"type": "error", "error": {"type": "invalid_request_error",
                                                            "message": f"model {model.id} is not an Anthropic model"}}, status_code=400)
        conv = key(request, ref["conv"]) if ref else ""
        tries = live.pool.order(cfg, model, conv)
        model = tries[0]
        if not model.ready:
            return JSONResponse({"type": "error", "error": {"type": "authentication_error", "message":
                                 f"the Ferry server has no API key for model {model.id}: add it on the admin page"}}, status_code=503)
        project = unquote(request.headers.get("x-ferry-project", ""))
        rules = "\n".join(l for l in load_rules(cfg.rules_dir, project).splitlines() if "[FERRY-...]" not in l).strip()
        if purpose == "summary" and cfg.rules_dir and (cfg.rules_dir / "_summary.md").is_file():
            rules = f"{rules}\n\n{(cfg.rules_dir / '_summary.md').read_text(encoding='utf-8').strip()}".strip()
        if rules:  # after the client's own (cached) system prompt
            system = payload.get("system") or []
            if isinstance(system, str):
                system = [{"type": "text", "text": system}]
            payload["system"] = [*system, {"type": "text", "text": f"<server-rules>\n{rules}\n</server-rules>"}]
        tokens_est = estimate_tokens(payload)
        if tokens_est > model.context_window * 1.15:
            write(audit_log, event="chat", user=request.state.user, project=project, model=model.id, status=400, overflow=tokens_est)
            return JSONResponse({"type": "error", "error": {"type": "invalid_request_error",
                                 "message": f"prompt is too long: {tokens_est} tokens > {model.context_window} maximum "
                                            "(the history will be summarised)"}}, status_code=400)
        call_id = secrets.token_hex(4)

        def done() -> None:
            if ref and cfg.session_store == "none":
                live.store.forget(key(request, ref["conv"]))

        last_err: tuple[int, bytes, str] = (502, b'{"type":"error","error":{"type":"api_error","message":"no provider answered"}}',
                                            "application/json")
        for n, model in enumerate(tries):
            one = dict(payload)
            one["model"] = model.model
            for k in model.drop_params:
                one.pop(k, None)
            if isinstance(one.get("max_tokens"), int):
                one["max_tokens"] = min(one["max_tokens"], model.max_tokens)
            one.update(model.extra_params)
            body = json.dumps(one, ensure_ascii=False).encode("utf-8")
            audit = dict(event="chat", id=call_id, user=request.state.user, project=project, model=model.id, purpose=purpose,
                         messages=len(one.get("messages", [])), upstream_bytes=len(body), masked={}, trimmed=0,
                         **({"attempt": n + 1} if n else {}))
            headers = {"Content-Type": "application/json", "x-api-key": model.api_key,
                       "anthropic-version": request.headers.get("anthropic-version", "2023-06-01")}
            if request.headers.get("anthropic-beta"):
                headers["anthropic-beta"] = request.headers["anthropic-beta"]
            more = n + 1 < len(tries)
            live.pool.start(model.id)
            try:
                upstream = await client.send(client.build_request("POST", anthropic_url(model.base_url), content=body,
                                                                  headers=headers), stream=True)
            except httpx.HTTPError as e:
                live.pool.end(model.id)
                live.pool.failed(model.id, None)
                write(audit_log, **audit, status=502, error=f"{type(e).__name__}: {e}"[:200], ms=int((time.time() - started) * 1000))
                last_err = (502, json.dumps({"type": "error", "error": {"type": "api_error",
                            "message": f"cannot reach {model.id}: {type(e).__name__}"}}).encode(), "application/json")
                if more:
                    continue
                break
            if upstream.status_code != 200:
                err = await upstream.aread()
                await upstream.aclose()
                live.pool.end(model.id)
                write(audit_log, **audit, status=upstream.status_code, ms=int((time.time() - started) * 1000))
                last_err = (upstream.status_code, err, upstream.headers.get("content-type", "application/json"))
                if more and upstream.status_code in RETRY_STATUSES:
                    live.pool.failed(model.id, upstream.status_code)
                    continue
                break
            live.pool.served(conv, model.id)
            seen = AnthropicSSEUsage()

            async def relay(upstream=upstream, model=model, audit=audit, seen=seen):
                try:
                    async for line in upstream.aiter_lines():
                        seen.feed(line)
                        yield (line + "\n").encode("utf-8")
                finally:
                    live.pool.end(model.id)
                    tokens = normalize(seen.usage)
                    write(audit_log, **audit, status=200, ms=int((time.time() - started) * 1000), usage=seen.usage,
                          tokens=tokens, cost=usage_cost(tokens, model.price))
                    done()

            return StreamingResponse(relay(), media_type="text/event-stream", background=BackgroundTask(upstream.aclose))
        done()
        return Response(last_err[1], status_code=last_err[0], media_type=last_err[2])

    from .admin import mount_admin
    mount_admin(app, cfg, live, rebuild, run_check, access_log, audit_log)
    return app
