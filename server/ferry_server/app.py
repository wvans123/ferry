"""Ferry server HTTP API.

  GET  /health                               liveness (no auth)
  GET  /v1/ferry/models                      models this user may use
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
from collections import Counter

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

from . import PROTOCOL, __version__
from .config import Config
from .prompt import adapt_params, apply_rules, cap_upstream, load_rules
from .redact import Redactor
from .store import BaseMismatch, Store
from .stream import restore_message, restore_sse


def create_app(cfg: Config) -> FastAPI:
    app = FastAPI(title="Ferry server", version=__version__)
    store = Store(cfg.data_dir / "ferry.db", cfg.session_ttl_days)
    red = Redactor(cfg.dictionary, cfg.secret, store)
    client = httpx.AsyncClient(timeout=httpx.Timeout(600, connect=15))
    access_log = cfg.data_dir / "access.jsonl"
    audit_log = cfg.data_dir / "audit.jsonl"
    drop_every = int(os.environ.get("FERRY_TEST_DROP_EVERY", "0"))  # test hook: forget sessions every N commits
    drop_before_chat = int(os.environ.get("FERRY_TEST_DROP_BEFORE_CHAT", "0"))  # test hook: forget before every Nth chat
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
        if request.url.path == "/health":
            return await call_next(request)
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

    @app.get("/v1/ferry/models")
    async def models():
        return {"models": [{"id": m.id, "contextWindow": m.context_window, "maxTokens": m.max_tokens,
                            "ready": bool(m.api_key) or not m.api_key_env}
                           for m in cfg.models.values()]}

    @app.post("/v1/ferry/upload/{upload}/{seq}")
    async def upload(upload: str, seq: int, request: Request):
        store.put_part(key(request, upload), seq, await request.body())
        return {"ok": True}

    @app.post("/v1/ferry/commit")
    async def commit(request: Request, conv: str, base: int, base_hash: str = "", upload: str = "", parts: int = 0):
        try:
            raw = store.take_upload(key(request, upload), parts) if upload else await request.body()
        except ValueError as e:
            raise HTTPException(400, str(e))
        blob = json.loads(raw.decode("utf-8"))
        counter["commits"] += 1
        if drop_every and counter["commits"] % drop_every == 0:
            store.drop_sessions()
            write(audit_log, event="test_drop")
        try:
            count, h = store.commit(key(request, conv), base, base_hash, blob.get("append") or [], blob.get("tools"))
        except BaseMismatch as e:
            return JSONResponse({"error": "base mismatch", "count": e.count, "hash": e.hash}, status_code=409)
        write(audit_log, event="commit", user=request.state.user, conv=conv[:12], base=base,
              appended=len(blob.get("append") or []), count=count, upload_bytes=len(raw), parts=parts)
        return {"count": count, "hash": h}

    @app.post("/v1/chat/completions")
    async def chat(request: Request):
        started = time.time()
        payload = json.loads(await request.body())
        ref = payload.pop("ferry", None)
        counter["chats"] += 1
        if ref and drop_before_chat and counter["chats"] % drop_before_chat == 0:
            store.drop_sessions()
            write(audit_log, event="test_drop_before_chat")
        if ref:
            try:
                payload["messages"], tools = store.load(key(request, ref["conv"]), ref["count"], ref["hash"],
                                                        ref.get("tools_hash"))
            except KeyError as e:
                return JSONResponse({"error": {"message": f"{e.args[0]}; the client will resend"}}, status_code=409)
            if tools is not None:
                payload["tools"] = tools
        model = cfg.models.get(payload.get("model", ""))
        if not model:
            return JSONResponse({"error": {"message": f"unknown model {payload.get('model')!r}"}}, status_code=404)

        project = request.headers.get("x-ferry-project", "")
        apply_rules(payload, load_rules(cfg.rules_dir, project))
        user = request.state.user
        hits: Counter = red.mask_payload(payload, user)
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
                     messages=len(payload.get("messages", [])), upstream_bytes=len(body), masked=dict(hits),
                     trimmed=trimmed)
        headers = {"Content-Type": "application/json"}
        if model.api_key:
            headers["Authorization"] = f"Bearer {model.api_key}"
        url = f"{model.base_url.rstrip('/')}/chat/completions"

        if not payload.get("stream"):
            r = await client.post(url, content=body, headers=headers)
            write(audit_log, **audit, status=r.status_code, ms=int((time.time() - started) * 1000))
            if r.status_code != 200:
                return Response(r.content, status_code=r.status_code, media_type="application/json")
            return JSONResponse(restore_message(r.json(), red, user))

        upstream = await client.send(client.build_request("POST", url, content=body, headers=headers), stream=True)
        if upstream.status_code != 200:
            err = await upstream.aread()
            await upstream.aclose()
            write(audit_log, **audit, status=upstream.status_code, ms=int((time.time() - started) * 1000))
            return Response(err, status_code=upstream.status_code,
                            media_type=upstream.headers.get("content-type", "application/json"))

        usage: dict = {}

        async def relay():
            try:
                async for b in restore_sse(upstream.aiter_lines(), red, usage, user):
                    yield b
            finally:
                write(audit_log, **audit, status=200, ms=int((time.time() - started) * 1000), usage=usage)

        return StreamingResponse(relay(), media_type="text/event-stream", background=BackgroundTask(upstream.aclose))

    return app
