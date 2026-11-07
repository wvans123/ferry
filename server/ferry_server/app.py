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

import asyncio
import hmac
import json
import os
import secrets
import time
from urllib.parse import unquote
from collections import deque
from types import SimpleNamespace

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

from . import PROTOCOL, __version__
from .config import Config, provider_labels, refresh_models
from .devices import Devices
from . import feishu
from . import globalmem
from . import memreview
from . import remote
from . import report as reports
from . import search as web_search
from . import side
from . import watchdog
from .presets import anthropic_url, chat_url
from .usage import AnthropicSSEUsage, normalize
from .usage import cost as usage_cost
from .fit import anthropic_answer, openai_answer, summarize, summary_prompt
from .responses import chat_lines, from_responses, responses_url, to_responses
from .pool import RETRY_STATUSES, RETRY_WAIT_S, TRANSIENT_STATUSES, Pool, groups, retry_delay, same_side
from .prompt import (adapt_params, add_cache_marks, apply_rules, cap_upstream, estimate_tokens, load_rules, overflow_message,
                     restore_cache_marks, summary_rules, wants_cache_marks)
from .store import BaseMismatch, MissingBlobs, Store


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def details_of(call_id: str, payload: dict, project: str, model: str, purpose: str, size: int) -> dict:
    """What the model is about to receive, after the server rules. Kept in memory only."""
    msgs = payload.get("messages", [])
    system = "\n\n".join(_text(m.get("content")) for m in msgs if m.get("role") in ("system", "developer"))
    users = [m for m in msgs if m.get("role") == "user"]
    tools = [t.get("function", {}).get("name", "") for t in payload.get("tools") or []]
    return {"id": call_id, "ts": round(time.time(), 3), "project": project, "model": model, "purpose": purpose,
            "bytes": size, "messages": len(msgs), "system": system[:60_000],
            "last_user": _text(users[-1].get("content"))[:20_000] if users else "", "tools": tools}


def without_placeholder_note(rules: str) -> str:
    """Rule files written before 0.26 still tell the model about redaction placeholders, which no longer exist."""
    return "\n".join(l for l in rules.splitlines() if "[FERRY-...]" not in l).strip()


async def pass_sse(lines, usage_out: dict):
    """Relay an OpenAI-style event stream as it comes, noting the usage it reports."""
    async for line in lines:
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data != "[DONE]":
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            if isinstance(chunk, dict) and chunk.get("usage"):
                usage_out.update(chunk["usage"])
        yield f"data: {data}\n\n".encode("utf-8")


def create_app(cfg: Config) -> FastAPI:
    app = FastAPI(title="Ferry server", version=__version__)
    # the session store can be swapped at run time from the admin page (settings)
    live = SimpleNamespace(store=None, started=time.time(), details=deque(maxlen=20), pool=Pool(),
                           no_marks=set(),  # models whose relay refused cache markers
                           fits={},         # model id -> biggest request (estimated tokens) it has answered
                           limits={})       # model id -> size it refused although configured for more (see fit.py)

    def limit_of(m) -> int:
        """The context size to work with: the configured one, or less when the provider refused smaller requests."""
        return min(m.context_window, live.limits.get(m.id) or m.context_window)

    def too_big(m, status: int, tokens: int) -> bool:
        """A failure that most likely means "too big": bigger than anything this model has answered (it has answered
        before), and an answer a relay gives for that (kiro: a bare 502)."""
        ok = live.fits.get(m.id, 0)
        return status in (400, 413, 422, 500, 502, 504) and ok > 0 and tokens > max(ok * 1.02, m.context_window * 0.3)

    def summary_models(model) -> list:
        """Who writes a summary: the conversation's model, then the summary model and the default one if set apart."""
        out = [model]
        for mid in (cfg.summary_model, cfg.default_model):
            m = cfg.models.get(mid)
            if m and m.ready and m.id != cfg.image_model and all(x.id != m.id for x in out):
                out.append(m)
        return out

    async def summary_reply(kind: str, model, sys_text: str, user_text: str, stream: bool, user, project: str,
                            tokens_est: int, started: float):
        async def run():
            ticket = await take_turn(user or "")
            try:
                return await summarize(client, summary_models(model), sys_text, user_text, limit_of)
            finally:
                ticket.release()

        def logged(status: int, **extra) -> None:
            write(audit_log, event="chat", user=user, project=project, purpose="summary", status=status,
                  tokens_in=tokens_est, ms=int((time.time() - started) * 1000), **extra)

        if not stream:
            try:
                text, mid, n = await run()
            except Exception as e:  # noqa: BLE001 - reported to the client
                logged(502, model=model.id, error=str(e)[:200])
                return JSONResponse({"error": {"message": f"writing the summary failed: {e}"}}, status_code=502)
            logged(200, model=mid, parts=n)
            body, kind_ = openai_answer(text, model.model, False)
            return Response(body, media_type=kind_)

        async def gen():
            task = asyncio.create_task(run())
            while True:  # a long summary: keep the connection alive so nothing on the way closes it
                done, _ = await asyncio.wait({task}, timeout=10)
                if done:
                    break
                yield b": ferry is writing the summary\n\n"
            try:
                text, mid, n = task.result()
            except Exception as e:  # noqa: BLE001 - reported to the client
                logged(502, model=model.id, error=str(e)[:200])
                msg = f"writing the summary failed: {e}"
                if kind == "anthropic":
                    yield ("event: error\ndata: " + json.dumps({"type": "error", "error": {"type": "api_error", "message": msg}}) + "\n\n").encode()
                else:
                    yield ("data: " + json.dumps({"error": {"message": msg}}) + "\n\n").encode()
                return
            logged(200, model=mid, parts=n)
            yield anthropic_answer(text, model.model) if kind == "anthropic" else openai_answer(text, model.model, True)[0]

        return StreamingResponse(gen(), media_type="text/event-stream")

    def limited(m, headers) -> tuple[float, object]:
        """A 429 from m's account: leave the account alone for its cool-down (Retry-After, else the provider's
        setting) and tell the phone once. Returns (seconds, the fallback model or None)."""
        prov = cfg.providers.get(m.provider) if m.provider else None
        try:
            secs = float((headers or {}).get("retry-after", "")) or 0
        except ValueError:
            secs = 0
        secs = min(max(secs or float(getattr(prov, "cooldown", 60) or 60), 1), 120)  # a client waits ~5 min at most
        fb = live.pool.fallback_for(cfg, m)
        if live.pool.cool(m, secs):
            write(audit_log, event="cooldown", model=m.id, seconds=secs, fallback=fb.id if fb else "")
            from .notify import send
            what = f"这段时间由 {fb.id} 回答" if fb else "请求在服务端排队，冷却后继续"
            asyncio.create_task(send(cfg, "Ferry", f"{m.id} 被限流，冷却 {int(secs)} 秒；{what}", "limit"))
        return secs, fb

    def reroute(request, purpose: str, kind: str, m, fb):
        """m cools down and its fallback speaks the other API (Claude's vs OpenAI's): the server cannot pass the
        stored conversation on as it is, so it tells the client to ask the fallback itself, in the fallback's format
        (the client keeps the conversation in a neutral form). 422: no SDK retries it (Node's fetch would resend a 421
        with an empty body). None when the client is too old for that, or for a summary (written here by summary_models)."""
        if request.headers.get("x-ferry-reroute") != "1" or purpose == "summary":
            return None
        left = int(live.pool.cooling(m))
        side = "anthropic" if fb.api == "anthropic" else "openai"
        msg = f"ferry-reroute:{fb.id}@{side} {m.id} is rate-limited ({left} s to go); ask {fb.id} meanwhile"
        write(audit_log, event="reroute", user=getattr(request.state, "user", ""), model=m.id, to=fb.id, seconds=left)
        if kind == "anthropic":
            return JSONResponse({"type": "error", "error": {"type": "ferry_reroute", "message": msg}}, status_code=422,
                                headers={"x-ferry-reroute": fb.id})
        return JSONResponse({"error": {"message": msg, "type": "ferry_reroute", "code": "ferry_reroute"}}, status_code=422,
                            headers={"x-ferry-reroute": fb.id})

    def api_changed(request, kind: str, m):
        """The client asked m in the other API's format: m's provider was switched (admin page: 接口格式) while the
        client kept its model list. A client that can ask in either format (x-ferry-reroute) is told to send this turn
        again in m's format and to remember it; an older one gets a plain error."""
        side = "anthropic" if m.api == "anthropic" else "openai"
        if request.headers.get("x-ferry-reroute") == "1":
            msg = f"ferry-reroute:{m.id}@{side} {m.id} now speaks the {'Anthropic' if side == 'anthropic' else 'OpenAI'} API"
            write(audit_log, event="api_changed", user=getattr(request.state, "user", ""), model=m.id, api=side)
            body = ({"type": "error", "error": {"type": "ferry_reroute", "message": msg}} if kind == "anthropic"
                    else {"error": {"message": msg, "type": "ferry_reroute", "code": "ferry_reroute"}})
            return JSONResponse(body, status_code=422, headers={"x-ferry-reroute": m.id})
        msg = (f"model {m.id} uses the {'Anthropic' if side == 'anthropic' else 'OpenAI'} API now; "
               "update the Ferry client (ferry update) and start ferry again")
        return JSONResponse({"type": "error", "error": {"type": "invalid_request_error", "message": msg}} if kind == "anthropic"
                            else {"error": {"message": msg}}, status_code=400)

    def gave_up(model, last_err, started: float, kind: str) -> Response:
        """The provider's error once the server has stopped asking. A busy or failing provider (5xx, 429, cannot
        reach it) becomes HTTP 424 with a message that names no status code and no retry words: the client's engine
        (pi) would otherwise send the whole request again three times, each time starting the server's own retries
        over (the same request reaching the model several times, and minutes without an answer). Other errors (a bad
        request, a wrong key) go back as the provider sent them."""
        status = last_err[0]
        if status not in TRANSIENT_STATUSES and status != 502:
            return Response(last_err[1], status_code=status, media_type=last_err[2])
        why = "kept refusing (HTTP 4xx, its usage limit)" if status == 429 else "kept failing (HTTP 5xx)"
        msg = (f"Ferry gave up: {model.id} did not answer. Its provider {why} for {int(time.time() - started)} s, and the "
               "Ferry server already asked again several times. Send your message once more in a while, or pick "
               "another model with /model. The server's call records have the details.")
        body = ({"type": "error", "error": {"type": "ferry_gave_up", "message": msg}} if kind == "anthropic"
                else {"error": {"message": msg, "type": "ferry_gave_up", "code": "ferry_gave_up"}})
        return JSONResponse(body, status_code=424)

    def cooling_notes() -> list[dict]:
        """Accounts cooling down now, for the client's status line (sent with each commit answer)."""
        out = []
        for m in cfg.models.values():
            left = live.pool.cooling(m)
            if left > 0 and all(o["model"] != m.id for o in out):
                fb = live.pool.fallback_for(cfg, m)
                out.append({"model": m.id, "seconds": int(left), "fallback": fb.id if fb else "",
                            **({"switch": True, "api": "anthropic" if fb.api == "anthropic" else "openai"}
                               if fb and not same_side(m, fb) else {})})  # the client asks fb itself
        return out[:5]

    def learn_limit(m, tokens: int) -> None:
        new = int(tokens * 0.97)
        if new < limit_of(m):
            live.limits[m.id] = new
            write(audit_log, event="limit_learned", model=m.id, tokens=new, configured=m.context_window)

    def rebuild(store_too: bool = True) -> None:
        if store_too or live.store is None:
            live.store = Store(cfg.data_dir / "ferry.db" if cfg.session_store == "disk" else ":memory:",
                               cfg.session_ttl_days)

    rebuild()
    live.devices = Devices((cfg.home or cfg.data_dir) / "devices.json")
    client = httpx.AsyncClient(timeout=httpx.Timeout(600, connect=15))
    access_log = cfg.data_dir / "access.jsonl"
    audit_log = cfg.data_dir / "audit.jsonl"
    drop_every = int(os.environ.get("FERRY_TEST_DROP_EVERY", "0"))  # test hook: forget sessions every N commits
    drop_before_chat = int(os.environ.get("FERRY_TEST_DROP_BEFORE_CHAT", "0"))  # test hook: forget before every Nth chat
    # test hook: act like a Cloudflare Access login in front of the server for requests without this header
    gate_header = os.environ.get("FERRY_TEST_REQUIRE_HEADER", "").lower()
    counter = {"commits": 0, "chats": 0}

    def identify(auth: str):
        """(user, device) for a token: a main token gives (user, None), a device token (its user, the device)."""
        if not auth.startswith("Bearer "):
            return None, None
        raw = auth[7:]
        given = raw.encode("utf-8")
        found = None
        for token, name in cfg.users.items():  # compare every token in constant time
            if hmac.compare_digest(given, token.encode("utf-8")):
                found = name
        if found is not None:
            return found, None
        dev = live.devices.find(raw)
        return (dev.user, dev) if dev else (None, None)

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
            with open(gate_file + ".blocked", "a", encoding="utf-8") as f:
                f.write(f"{request.method} {request.url.path}\n")
            return Response(status_code=302, headers={"location": "http://127.0.0.1:9100/proxycontrolwarn?url=ferry"})
        if request.url.path == "/health" or request.url.path.startswith("/admin"):
            return await call_next(request)  # the admin page has its own, local-only sign-in
        if request.url.path.startswith("/m/"):
            return await call_next(request)  # the phone page: a signed one-item link instead of a token (remote.py)
        if request.url.path.startswith("/feishu/"):
            return await call_next(request)  # Feishu's events: the app's verification token instead (feishu.py)
        if request.method == "GET" and request.url.path in ("/", "/favicon.ico", "/robots.txt"):
            # a browser lands here, e.g. after the company gateway's confirmation page: not an error, not logged
            if request.url.path != "/":
                return Response(status_code=204)
            return HTMLResponse("<!doctype html><meta charset=utf-8><title>Ferry</title>"
                                "<p style='font:16px system-ui;margin:40px'>Ferry 服务端在运行。可以关掉这个页面，回到 ferry 继续。</p>")
        body = await request.body()
        # Bearer for the OpenAI-style calls; x-api-key for the Anthropic-style ones (the Anthropic SDK sends that)
        user, device = identify(request.headers.get("authorization", ""))
        if user is None:
            user, device = identify(f"Bearer {request.headers.get('x-api-key', '')}")
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
            request.state.device = device
            request.state.device_id = device.id if device else "main"
            request.state.device_name = device.name if device else "主令牌"
            live.devices.touch(device, user, request.headers.get("cf-connecting-ip")
                               or (request.client.host if request.client else ""))
            resp = await call_next(request)
            status = resp.status_code
        write(access_log, user=user, **({"device": device.name} if device else {}), path=request.url.path,
              bytes=len(body), status=status)
        return resp

    @app.get("/health")
    async def health():
        return {"ok": True, "version": __version__, "protocol": PROTOCOL}

    def describe(m, mid=None, provider="") -> dict:
        # provider: the name the work PC shows in front of the model ("kiro/claude-opus-5.5"); "ferry" for "auto",
        # pooled models and models with an address of their own
        return {"id": mid or m.id, "contextWindow": limit_of(m), "maxTokens": m.max_tokens,
                "ready": m.ready, "keyEnv": m.api_key_env, "model": m.model, "api": m.api, "vision": m.vision,
                "price": m.price, "provider": provider or "ferry"}

    def reload() -> None:
        err = refresh_models(cfg)
        if err:
            print(f"models.toml not applied, still using the previous models: {err}", flush=True)
            write(audit_log, event="models_file_error", error=err[:300])

    @app.get("/v1/ferry/models")
    async def models():
        """Expose only configured models; hidden routing mode keeps its legacy auto alias."""
        reload()
        if not cfg.models:
            return {"models": [], "defaultModel": "", "sessionStore": cfg.session_store, "features": []}
        d = cfg.models[cfg.default_model]
        labels = provider_labels(cfg)
        auto = {**describe(d, "auto"), "routesTo": d.id}
        if cfg.summary_model:  # a summary request carries the whole history, so it must fit the smaller window
            auto["contextWindow"] = min(limit_of(d), limit_of(cfg.models[cfg.summary_model]))
            auto["summaryTo"] = cfg.summary_model
        # a model several providers offer is listed once; the server spreads conversations over the providers
        shared = groups(cfg)
        listed = [] if cfg.expose_models else [auto]
        ordered = [d, *(m for m in cfg.models.values() if m.id != d.id)]
        for m in ordered if cfg.expose_models else []:
            if m.id == cfg.image_model and m.id != d.id:
                continue  # draws pictures (image_create), does not chat
            ids = shared.get(m.id)
            if ids and any(x["id"] in ids for x in listed):
                continue  # another provider's copy of this model is listed already
            row = describe(m, provider="" if ids else labels.get(m.provider, ""))
            if ids:
                row["contextWindow"] = min(limit_of(cfg.models[i]) for i in ids)
                row["providers"] = len(ids)
            listed.append(row)
        if shared.get(d.id):
            auto["providers"] = len(shared[d.id])
            auto["contextWindow"] = min(auto["contextWindow"], *(limit_of(cfg.models[i]) for i in shared[d.id]))
        return {"models": listed, "defaultModel": cfg.default_model, "sessionStore": cfg.session_store,
                "features": (["refs"] if cfg.session_store != "none" else []) + (["image"] if cfg.image_model else [])
                + (["advisor"] if side.advisor_model(cfg) else []) + (["search"] if web_search.ready(cfg) else []) + (["extract", "read"] if web_search.extract_models(cfg) else [])
                + (["remote"] if remote.ready(cfg) or feishu.ready(cfg) else [])}

    @app.post("/v1/ferry/image")
    async def image(request: Request):
        """The agent's image_create tool: a picture from a description, by the model routing.image names."""
        from .images import create_image
        if not cfg.image_model:
            return JSONResponse({"error": "no image model: choose one on the admin page (生成图片用)"}, status_code=400)
        b = json.loads(await request.body() or b"{}")
        m = cfg.models[cfg.image_model]
        t = time.time()
        try:
            out = await create_image(client, m, str(b.get("prompt") or ""), str(b.get("size") or "auto"),
                                     [str(x) for x in (b.get("images") or [])][:4])
        except httpx.HTTPStatusError as e:
            write(audit_log, event="image", user=request.state.user, model=m.id, status=e.response.status_code)
            return JSONResponse({"error": f"{m.id}: HTTP {e.response.status_code} {e.response.text[:300]}"}, status_code=502)
        except (httpx.HTTPError, ValueError) as e:
            write(audit_log, event="image", user=request.state.user, model=m.id, status=502)
            return JSONResponse({"error": f"{m.id}: {type(e).__name__}: {e}"[:400]}, status_code=502)
        write(audit_log, event="image", user=request.state.user, model=m.id, status=200, ms=int((time.time() - t) * 1000),
              images=len(out["images"]))
        return out

    class Ticket:
        """One running model call of a user; released exactly once."""
        def __init__(self, sem: asyncio.Semaphore | None):
            self.sem = sem

        def release(self) -> None:
            if self.sem is not None:
                self.sem.release()
                self.sem = None

    sems: dict[str, asyncio.Semaphore] = {}

    async def take_turn(user: str) -> Ticket:
        """At most cfg.max_concurrent model calls per user at a time (a big batch of subagents waits here, not at the
        provider). After 10 minutes of waiting the call goes ahead anyway."""
        sem = sems.get(user)
        if sem is None or getattr(sem, "_ferry_size", None) != cfg.max_concurrent:
            sem = sems[user] = asyncio.Semaphore(cfg.max_concurrent)
            sem._ferry_size = cfg.max_concurrent  # type: ignore[attr-defined]
        try:
            await asyncio.wait_for(sem.acquire(), timeout=600)
            return Ticket(sem)
        except asyncio.TimeoutError:
            return Ticket(None)

    def route(requested: str, purpose: str):
        """The server decides which model answers. A client may name one only when routing.expose is on."""
        if not cfg.models:
            raise HTTPException(503, "No models configured. Add providers and models in the Ferry admin page.")
        if cfg.expose_models and requested not in ("", "auto"):
            if requested not in cfg.models:
                raise HTTPException(400, "This model is not configured on the Ferry server; refresh the model list.")
            return cfg.models[requested]
        if requested in cfg.models and any(live.pool.cooling(m) and (fb := live.pool.fallback_for(cfg, m)) and fb.id == requested
                                           for m in cfg.models.values()):
            return cfg.models[requested]  # the client asks a cooling model's fallback itself (reroute)
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
                if m.api == "openai-responses":
                    body, url = to_responses(body), responses_url(m.base_url)
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

    @app.post("/v1/ferry/notify")
    async def notify(request: Request):
        """The client asks for a phone notification (goal finished, long request done, approval waiting)."""
        from .notify import everywhere
        b = json.loads(await request.body() or b"{}")
        # the session's phone console opens when the push is tapped (remote.py)
        sid = str(b.get("session") or "")
        link = request.app.state.console_link(request.state.user or "", sid)
        ok, err = await everywhere(request.app, cfg, str(b.get("title") or "Ferry"), str(b.get("body") or ""),
                                   str(b.get("kind") or ""), link=link, user=request.state.user or "", session=sid)
        write(audit_log, event="notify", user=request.state.user, kind=str(b.get("kind") or ""), ok=ok, link=bool(link))
        return {"ok": ok, **({"error": err} if err else {})}

    # ---------- global memory, shared by all of a user's computers (off unless switched on) ----------

    def memory_off():
        return JSONResponse({"error": {"message": "global memory is off on this Ferry server (admin page: 设备和记忆)"}},
                            status_code=403)

    @app.get("/v1/ferry/memory")
    async def memory_index(request: Request):
        if not cfg.shared_memory:
            return {"enabled": False, "index": ""}
        return {"enabled": True, "index": globalmem.index(cfg.data_dir, request.state.user or "")}

    @app.get("/v1/ferry/memory/{name}")
    async def memory_read(name: str, request: Request):
        if not cfg.shared_memory:
            return memory_off()
        text = globalmem.read(cfg.data_dir, request.state.user or "", name)
        if text is None:
            return JSONResponse({"error": {"message": f'no global memory named "{name}"'}}, status_code=404)
        return {"name": globalmem.slug(name), "content": text}

    @app.put("/v1/ferry/memory/{name}")
    async def memory_save(name: str, request: Request):
        if not cfg.shared_memory:
            return memory_off()
        b = json.loads(await request.body() or b"{}")
        try:
            n = globalmem.save(cfg.data_dir, request.state.user or "", name, str(b.get("description") or ""),
                               str(b.get("content") or ""))
        except ValueError as e:
            return JSONResponse({"error": {"message": str(e)}}, status_code=400)
        write(audit_log, event="memory_save", user=request.state.user, device=request.state.device_name, name=n)
        return {"ok": True, "name": n}

    @app.delete("/v1/ferry/memory/{name}")
    async def memory_delete(name: str, request: Request):
        if not cfg.shared_memory:
            return memory_off()
        had = globalmem.delete(cfg.data_dir, request.state.user or "", name)
        write(audit_log, event="memory_delete", user=request.state.user, device=request.state.device_name,
              name=globalmem.slug(name))
        return {"ok": True, "existed": had}

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
        notes = cooling_notes()
        return {"count": count, "hash": h, **({"cooling": notes} if notes else {})}

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
            return api_changed(request, "openai", model)

        project = unquote(request.headers.get("x-ferry-project", ""))  # sent URL-encoded: folder names can be Chinese
        rules = load_rules(cfg.rules_dir, project)
        rules = without_placeholder_note(rules)
        if purpose == "summary":
            rules = f"{rules}\n\n{summary_rules(cfg.rules_dir)}".strip()
        apply_rules(payload, rules)
        user = request.state.user
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
        fb = live.pool.fallback_for(cfg, tries[0]) if live.pool.cooling(tries[0]) else None
        if fb and not same_side(tries[0], fb):  # the fallback speaks Claude's API: the client asks it itself
            sent = reroute(request, purpose, "openai", tries[0], fb)
            if sent:
                return sent
            fb = None
        if fb:  # its account cools down after "too many requests": the fallback answers meanwhile
            tries = [fb, *tries]
        model = tries[0]
        if not model.ready:
            how = (f"set {model.api_key_env} and restart ferry-server" if model.api_key_env
                   else "add the key on the server's admin page")
            return JSONResponse({"error": {"message": f"the Ferry server has no API key for model {model.id}: {how}"}},
                                status_code=503)
        tokens_est = estimate_tokens(payload)
        limit = limit_of(model)
        if purpose == "summary" and summary_prompt(payload.get("messages") or []):
            # summaries are written here, never streamed through: in parts when too big, again (or by the next model)
            # when the model refuses (fit.py)
            sys_text, user_text = summary_prompt(payload["messages"])
            return await summary_reply("openai", model, sys_text, user_text, bool(payload.get("stream")), user, project,
                                       tokens_est, started)
        if tokens_est > min(model.context_window * 1.15, live.limits.get(model.id) or 10**12):
            # the client thinks the model holds more than it does (or the provider refused this size before)
            write(audit_log, event="chat", user=user, project=project, model=model.id, status=400, overflow=tokens_est)
            return JSONResponse({"error": {"message": overflow_message(tokens_est, limit, model.id),
                                           "type": "invalid_request_error", "code": "context_length_exceeded"}},
                                status_code=400)
        call_id = secrets.token_hex(4)

        ticket = await take_turn(request.state.user or "")

        def done() -> None:
            ticket.release()
            if ref and cfg.session_store == "none":
                live.store.forget(key(request, ref["conv"]))

        last_err: tuple[int, bytes, str] = (502, b'{"error":{"message":"no provider answered"}}', "application/json")
        refused_marks = False
        again = 0  # how many times the same provider was asked again
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
            if model.api == "openai-responses":  # the provider speaks the Responses API: translate (responses.py)
                sent = to_responses(sent)
            body = json.dumps(sent, ensure_ascii=False).encode("utf-8")
            if cfg.record_details and n == 0:
                live.details.append(details_of(call_id, payload, project, model.id, purpose, len(body)))
            audit = dict(event="chat", id=call_id, user=request.state.user, project=project, model=model.id,
                         purpose=purpose, messages=len(payload.get("messages", [])), upstream_bytes=len(body),
                         trimmed=trimmed, **({"attempt": n + 1} if n else {}))
            headers = {"Content-Type": "application/json"}
            if model.api_key:
                headers["Authorization"] = f"Bearer {model.api_key}"
            url = responses_url(model.base_url) if model.api == "openai-responses" else chat_url(model.base_url)
            # another provider to try next (the same model without cache markers is only tried when they were refused)
            more = any(t[0] is not model for t in tries[n + 1:])
            refused_marks = False
            await live.pool.enter(cfg, model)
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
                if time.time() - started + retry_delay(None, again) < RETRY_WAIT_S:  # the only provider: once more after a short wait
                    d = retry_delay(None, again)
                    await asyncio.sleep(d)
                    again += 1
                    tries.append((model, marks))
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
                if r.status_code == 429:  # too many requests: cool down, then the fallback or this one again
                    secs, fb = limited(model, r.headers)
                    if fb and not same_side(model, fb):
                        sent = reroute(request, purpose, "openai", model, fb)
                        if sent:
                            return sent
                        fb = None
                    if fb:
                        tries.append((fb, False))
                        continue
                    if not more and time.time() - started + secs < RETRY_WAIT_S:
                        tries.append((model, marks))  # enter() waits for the cool-down
                        continue
                if more and r.status_code in RETRY_STATUSES:
                    live.pool.failed(model.id, r.status_code)
                    continue
                big = too_big(model, r.status_code, tokens_est)
                if not more and r.status_code in TRANSIENT_STATUSES and time.time() - started + retry_delay(r.headers, again) < RETRY_WAIT_S and not (big and again):
                    # the only (or last) provider is busy: wait as it asks (Retry-After) or a little, then once more,
                    # instead of handing the error to the client, which would ask again at once
                    d = retry_delay(r.headers, again)
                    write(audit_log, event="upstream_wait", model=model.id, status=r.status_code, seconds=d)
                    await asyncio.sleep(d)
                    again += 1
                    tries.append((model, marks))
                    continue
                if not more and big:  # refused because it is too big: the client summarises its history and goes on
                    learn_limit(model, tokens_est)
                    done()
                    return JSONResponse({"error": {"message": overflow_message(tokens_est, limit_of(model), model.id),
                                                   "type": "invalid_request_error", "code": "context_length_exceeded"}},
                                        status_code=400)
                break
            live.pool.served(conv, model.id)
            live.fits[model.id] = max(live.fits.get(model.id, 0), tokens_est)
            if not payload.get("stream"):
                live.pool.end(model.id)
                answer = from_responses(r.json(), model.model) if model.api == "openai-responses" else r.json()
                tokens = normalize(answer.get("usage") or {})
                write(audit_log, **audit, status=200, ms=int((time.time() - started) * 1000),
                      tokens=tokens, cost=usage_cost(tokens, model.price))
                done()
                return JSONResponse(answer)
            usage: dict = {}

            async def relay(upstream=r, model=model, audit=audit):
                try:
                    lines = (chat_lines(upstream.aiter_lines(), model.model) if model.api == "openai-responses"
                             else upstream.aiter_lines())
                    async for b in pass_sse(lines, usage):
                        yield b
                finally:
                    live.pool.end(model.id)
                    tokens = normalize(usage)
                    write(audit_log, **audit, status=200, ms=int((time.time() - started) * 1000), usage=usage,
                          tokens=tokens, cost=usage_cost(tokens, model.price))
                    done()

            return StreamingResponse(relay(), media_type="text/event-stream", background=BackgroundTask(r.aclose))
        done()
        return gave_up(model, last_err, started, "openai")

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
            return api_changed(request, "anthropic", model)
        conv = key(request, ref["conv"]) if ref else ""
        tries = live.pool.order(cfg, model, conv)
        fb = live.pool.fallback_for(cfg, tries[0]) if live.pool.cooling(tries[0]) else None
        if fb and not same_side(tries[0], fb):  # the fallback speaks OpenAI's API: the client asks it itself
            sent = reroute(request, purpose, "anthropic", tries[0], fb)
            if sent:
                return sent
            fb = None
        if fb:
            tries = [fb, *tries]
        model = tries[0]
        if not model.ready:
            return JSONResponse({"type": "error", "error": {"type": "authentication_error", "message":
                                 f"the Ferry server has no API key for model {model.id}: add it on the admin page"}}, status_code=503)
        project = unquote(request.headers.get("x-ferry-project", ""))
        rules = without_placeholder_note(load_rules(cfg.rules_dir, project))
        if purpose == "summary":
            rules = f"{rules}\n\n{summary_rules(cfg.rules_dir)}".strip()
        if rules:  # after the client's own (cached) system prompt
            system = payload.get("system") or []
            if isinstance(system, str):
                system = [{"type": "text", "text": system}]
            payload["system"] = [*system, {"type": "text", "text": f"<server-rules>\n{rules}\n</server-rules>"}]
        tokens_est = estimate_tokens(payload)
        limit = limit_of(model)
        if purpose == "summary":
            sys_blocks = payload.get("system") or ""
            sys_text = sys_blocks if isinstance(sys_blocks, str) else "".join(b.get("text", "") for b in sys_blocks if isinstance(b, dict))
            sp = summary_prompt([{"role": "system", "content": sys_text}, *(payload.get("messages") or [])])
            if sp:
                return await summary_reply("anthropic", model, sp[0], sp[1], True, request.state.user, project, tokens_est, started)
        if tokens_est > min(model.context_window * 1.15, live.limits.get(model.id) or 10**12):
            write(audit_log, event="chat", user=request.state.user, project=project, model=model.id, status=400, overflow=tokens_est)
            return JSONResponse({"type": "error", "error": {"type": "invalid_request_error",
                                 "message": f"prompt is too long: {tokens_est} tokens > {model.context_window} maximum "
                                            "(the history will be summarised)"}}, status_code=400)
        call_id = secrets.token_hex(4)

        ticket = await take_turn(request.state.user or "")

        def done() -> None:
            ticket.release()
            if ref and cfg.session_store == "none":
                live.store.forget(key(request, ref["conv"]))

        last_err: tuple[int, bytes, str] = (502, b'{"type":"error","error":{"type":"api_error","message":"no provider answered"}}',
                                            "application/json")
        tries = list(tries)
        again = 0
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
                         messages=len(one.get("messages", [])), upstream_bytes=len(body), trimmed=0,
                         **({"attempt": n + 1} if n else {}))
            headers = {"Content-Type": "application/json", "x-api-key": model.api_key,
                       "anthropic-version": request.headers.get("anthropic-version", "2023-06-01")}
            if request.headers.get("anthropic-beta"):
                headers["anthropic-beta"] = request.headers["anthropic-beta"]
            more = n + 1 < len(tries)
            await live.pool.enter(cfg, model)
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
                if time.time() - started + retry_delay(None, again) < RETRY_WAIT_S:
                    d = retry_delay(None, again)
                    await asyncio.sleep(d)
                    again += 1
                    tries.append(model)
                    continue
                break
            if upstream.status_code != 200:
                err = await upstream.aread()
                await upstream.aclose()
                live.pool.end(model.id)
                write(audit_log, **audit, status=upstream.status_code, ms=int((time.time() - started) * 1000))
                last_err = (upstream.status_code, err, upstream.headers.get("content-type", "application/json"))
                if upstream.status_code == 429:
                    secs, fb = limited(model, upstream.headers)
                    if fb and not same_side(model, fb):
                        sent = reroute(request, purpose, "anthropic", model, fb)
                        if sent:
                            return sent
                        fb = None
                    if fb:
                        tries.append(fb)
                        continue
                    if not more and time.time() - started + secs < RETRY_WAIT_S:
                        tries.append(model)
                        continue
                if more and upstream.status_code in RETRY_STATUSES:
                    live.pool.failed(model.id, upstream.status_code)
                    continue
                big = too_big(model, upstream.status_code, tokens_est)
                if not more and upstream.status_code in TRANSIENT_STATUSES and time.time() - started + retry_delay(upstream.headers, again) < RETRY_WAIT_S and not (big and again):
                    d = retry_delay(upstream.headers, again)
                    write(audit_log, event="upstream_wait", model=model.id, status=upstream.status_code, seconds=d)
                    await asyncio.sleep(d)
                    again += 1
                    tries.append(model)
                    continue
                if not more and big:
                    learn_limit(model, tokens_est)
                    done()
                    return JSONResponse({"type": "error", "error": {"type": "invalid_request_error",
                                         "message": f"prompt is too long: {tokens_est} tokens > {limit_of(model)} maximum "
                                                    "(the history will be summarised)"}}, status_code=400)
                break
            live.pool.served(conv, model.id)
            live.fits[model.id] = max(live.fits.get(model.id, 0), tokens_est)
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
        return gave_up(model, last_err, started, "anthropic")

    from .admin import mount_admin
    mount_admin(app, cfg, live, rebuild, run_check, access_log, audit_log)
    reports.mount(app, cfg, client, lambda **row: write(audit_log, **row))
    web_search.mount(app, cfg, client, lambda **row: write(audit_log, **row))
    side.mount(app, cfg, client, lambda **row: write(audit_log, **row), lambda: live.store, key, limit_of)
    memreview.mount(app, cfg, client, lambda **row: write(audit_log, **row))
    console_link = remote.mount(app, cfg, lambda **row: write(audit_log, **row))
    feishu.mount(app, cfg, lambda **row: write(audit_log, **row))
    watchdog.mount(app, cfg, lambda **row: write(audit_log, **row), console_link)
    return app
