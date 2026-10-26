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
import time
from types import SimpleNamespace
from collections import Counter

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

from . import PROTOCOL, __version__
from .config import Config, refresh_models
from .prompt import adapt_params, apply_rules, cap_upstream, load_rules
from .redact import Redactor
from .store import BaseMismatch, Store
from .stream import restore_message, restore_sse


def create_app(cfg: Config) -> FastAPI:
    app = FastAPI(title="Ferry server", version=__version__)
    # session store and redactor can be swapped at run time from the admin page (settings, word list)
    live = SimpleNamespace(store=None, red=None, started=time.time())

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
        if request.url.path == "/health" or request.url.path.startswith("/admin"):
            return await call_next(request)  # the admin page has its own, local-only sign-in
        body = await request.body()
        user = find_user(request.headers.get("authorization", ""))
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
                "ready": bool(m.api_key) or not m.api_key_env, "keyEnv": m.api_key_env, "model": m.model}

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
        listed = [auto] + ([describe(m) for m in cfg.models.values()] if cfg.expose_models else [])
        return {"models": listed, "sessionStore": cfg.session_store}

    def route(requested: str, purpose: str):
        """The server decides which model answers. A client may name one only when routing.expose is on."""
        if cfg.expose_models and requested in cfg.models:
            return cfg.models[requested]
        if purpose == "summary" and cfg.summary_model:
            return cfg.models[cfg.summary_model]
        return cfg.models[cfg.default_model]

    async def run_check(want: str | None, user: str) -> list[dict]:
        """Ask each model (or the one named) for a two-word answer: proves the key, the network path and the model
        name work, which `ferry doctor` cannot know otherwise. Costs a few tokens."""
        reload()
        out = []
        for m in list(cfg.models.values()):
            if want and m.id != want:
                continue
            row = {"id": m.id, "model": m.model, "base_url": m.base_url}
            if m.api_key_env and not m.api_key:
                out.append({**row, "ok": False, "error": f"{m.api_key_env} is not set"})
                continue
            t = time.time()
            body = adapt_params({"model": m.id, "max_completion_tokens": 32,
                                 "messages": [{"role": "user", "content": "Reply with OK"}]}, m)
            headers = {"Content-Type": "application/json"}
            if m.api_key:
                headers["Authorization"] = f"Bearer {m.api_key}"
            try:
                r = await client.post(f"{m.base_url.rstrip('/')}/chat/completions", json=body, headers=headers,
                                      timeout=60)
                ok = r.status_code == 200
                err = "" if ok else f"HTTP {r.status_code}: {r.text[:300]}"
            except httpx.HTTPError as e:
                ok, err = False, f"{type(e).__name__}: {e}"
            out.append({**row, "ok": ok, "ms": int((time.time() - t) * 1000), **({"error": err} if err else {})})
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
            count, h = live.store.commit(key(request, conv), base, base_hash, blob.get("append") or [], blob.get("tools"))
        except BaseMismatch as e:
            return JSONResponse({"error": "base mismatch", "count": e.count, "hash": e.hash}, status_code=409)
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
        model = route(payload.get("model", ""), purpose)

        project = request.headers.get("x-ferry-project", "")
        apply_rules(payload, load_rules(cfg.rules_dir, project))
        user = request.state.user
        hits: Counter = live.red.mask_payload(payload, user)
        trimmed, size = cap_upstream(payload, cfg.max_upstream_bytes)
        if cfg.max_upstream_bytes and size > cfg.max_upstream_bytes:
            write(audit_log, event="chat", user=user, project=project, model=model.id, status=413, trimmed=trimmed,
                  upstream_bytes=size)
            return JSONResponse({"error": {"message": f"the conversation is still {size:,} bytes after dropping old "
                                                      f"tool outputs (limit {cfg.max_upstream_bytes:,}). Run /compact "
                                                      f"or start a new session."}}, status_code=413)
        if not model.api_key and model.api_key_env:
            return JSONResponse({"error": {"message": f"the Ferry server has no API key for model {model.id}: "
                                                      f"set {model.api_key_env} and restart ferry-server"}},
                                status_code=503)
        body = json.dumps(adapt_params(payload, model), ensure_ascii=False).encode("utf-8")
        audit = dict(event="chat", user=request.state.user, project=project, model=model.id,
                     purpose=purpose,
                     messages=len(payload.get("messages", [])), upstream_bytes=len(body), masked=dict(hits),
                     trimmed=trimmed)
        headers = {"Content-Type": "application/json"}
        if model.api_key:
            headers["Authorization"] = f"Bearer {model.api_key}"
        url = f"{model.base_url.rstrip('/')}/chat/completions"

        def done() -> None:
            if ref and cfg.session_store == "none":
                live.store.forget(key(request, ref["conv"]))

        if not payload.get("stream"):
            r = await client.post(url, content=body, headers=headers)
            write(audit_log, **audit, status=r.status_code, ms=int((time.time() - started) * 1000))
            done()
            if r.status_code != 200:
                return Response(r.content, status_code=r.status_code, media_type="application/json")
            return JSONResponse(restore_message(r.json(), live.red, user))

        upstream = await client.send(client.build_request("POST", url, content=body, headers=headers), stream=True)
        if upstream.status_code != 200:
            err = await upstream.aread()
            await upstream.aclose()
            write(audit_log, **audit, status=upstream.status_code, ms=int((time.time() - started) * 1000))
            done()
            return Response(err, status_code=upstream.status_code,
                            media_type=upstream.headers.get("content-type", "application/json"))

        usage: dict = {}

        async def relay():
            try:
                async for b in restore_sse(upstream.aiter_lines(), live.red, usage, user):
                    yield b
            finally:
                write(audit_log, **audit, status=200, ms=int((time.time() - started) * 1000), usage=usage)
                done()

        return StreamingResponse(relay(), media_type="text/event-stream", background=BackgroundTask(upstream.aclose))

    from .admin import mount_admin
    mount_admin(app, cfg, live, rebuild, run_check, access_log, audit_log)
    return app
