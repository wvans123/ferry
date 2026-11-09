"""A streaming request that waits for its upstream sends SSE comments, so Cloudflare Tunnel (524 after ~100 s of
silence) keeps the connection; errors after that point arrive as SSE error events."""
import asyncio
import json

import httpx
import pytest

import ferry_server.app as app_mod
from test_pool import CLAUDE, REAL, make

OPENAI_SSE = (b'data: {"choices":[{"index":0,"delta":{"content":"later"}}]}\n\n'
              b'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\ndata: [DONE]\n\n')
CLAUDE_SSE = (b'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n'
              b'event: message_stop\ndata: {"type":"message_stop"}\n\n')


@pytest.fixture(autouse=True)
def quick(monkeypatch):
    monkeypatch.setattr(app_mod, "KEEPALIVE_S", 0.1)


def ask(app, token, kind, extra=None, headers=None, model=None):
    if kind == "anthropic":
        url = "/anthropic/v1/messages"
        body = {"model": model or "kiro", "max_tokens": 100, "stream": True, "messages": [{"role": "user", "content": "hi"}]}
    else:
        url = "/v1/chat/completions"
        body = {"model": model or "other", "stream": True, "messages": [{"role": "user", "content": "hi"}]}
    body.update(extra or {})

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            return await c.post(url, headers={"Authorization": f"Bearer {token}", **(headers or {})}, json=body)

    return asyncio.run(go())


def events(text):
    """(event name, data) for every SSE block that is not a comment."""
    out = []
    for block in text.split("\n\n"):
        lines = [l for l in block.split("\n") if l and not l.startswith(":")]
        if lines:
            ev = next((l[6:].strip() for l in lines if l.startswith("event:")), "")
            data = "".join(l[5:].strip() for l in lines if l.startswith("data:"))
            out.append((ev, data))
    return out


def slow(delay, response):
    async def handler(req):
        await asyncio.sleep(delay)
        return response() if callable(response) else response
    return handler


def test_openai_slow_headers_get_comments_then_the_stream(tmp_path, monkeypatch):
    cfg, app = make(tmp_path, monkeypatch, slow(0.45, lambda: httpx.Response(200, content=OPENAI_SSE)))
    r = ask(app, (tmp_path / "token").read_text().strip(), "openai")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    assert r.text.count(": ferry waiting") >= 3
    assert r.text.index(": ferry waiting") < r.text.index('"later"')
    assert [d for _, d in events(r.text)][-1] == "[DONE]"


def test_a_fast_answer_is_the_same_as_before(tmp_path, monkeypatch):
    cfg, app = make(tmp_path, monkeypatch, lambda req: httpx.Response(200, content=OPENAI_SSE))
    r = ask(app, (tmp_path / "token").read_text().strip(), "openai")
    assert r.status_code == 200 and ": ferry waiting" not in r.text and '"later"' in r.text


def test_a_fast_error_keeps_its_status_code(tmp_path, monkeypatch):
    cfg, app = make(tmp_path, monkeypatch, lambda req: httpx.Response(401, json={"error": {"message": "bad key"}}))
    r = ask(app, (tmp_path / "token").read_text().strip(), "openai")
    assert r.status_code == 401 and "bad key" in r.text


def test_openai_error_after_commit_is_an_error_chunk(tmp_path, monkeypatch):
    cfg, app = make(tmp_path, monkeypatch, slow(0.3, lambda: httpx.Response(401, json={"error": {"message": "bad key"}})))
    r = ask(app, (tmp_path / "token").read_text().strip(), "openai")
    assert r.status_code == 200 and ": ferry waiting" in r.text
    (ev, data), = events(r.text)
    err = json.loads(data)["error"]
    assert ev == "" and "bad key" in err["message"] and err["message"].startswith("401: ")


def test_anthropic_error_after_commit_is_an_error_event(tmp_path, monkeypatch):
    err = {"type": "error", "error": {"type": "authentication_error", "message": "bad key"}}
    cfg, app = make(tmp_path, monkeypatch, slow(0.3, lambda: httpx.Response(401, json=err)), CLAUDE)
    r = ask(app, (tmp_path / "token").read_text().strip(), "anthropic")
    assert r.status_code == 200 and ": ferry waiting" in r.text
    (ev, data), = events(r.text)
    d = json.loads(data)
    assert ev == "error" and d["type"] == "error" and "bad key" in d["error"]["message"]


def test_anthropic_slow_headers_then_the_stream(tmp_path, monkeypatch):
    cfg, app = make(tmp_path, monkeypatch, slow(0.35, lambda: httpx.Response(200, content=CLAUDE_SSE)), CLAUDE)
    r = ask(app, (tmp_path / "token").read_text().strip(), "anthropic")
    assert r.status_code == 200 and ": ferry waiting" in r.text
    assert [e for e, _ in events(r.text)] == ["message_start", "message_stop"]


def test_a_provider_that_keeps_failing_gives_up_in_the_stream_without_retry_words(tmp_path, monkeypatch):
    cfg, app = make(tmp_path, monkeypatch, slow(0.15, lambda: httpx.Response(502, json={"error": {"message": "busy"}})))
    monkeypatch.setattr(app_mod, "retry_delay", lambda headers, attempt: 0.05)
    monkeypatch.setattr(app_mod, "RETRY_WAIT_S", 0.8)
    r = ask(app, (tmp_path / "token").read_text().strip(), "openai")
    assert r.status_code == 200 and ": ferry waiting" in r.text
    (_, data), = events(r.text)
    err = json.loads(data)["error"]
    assert err["code"] == "ferry_gave_up" and err["message"].startswith("Ferry gave up")


def test_overflow_after_commit_keeps_the_text_pi_recognises(tmp_path, monkeypatch):
    state = {"n": 0}

    async def handler(req):
        state["n"] += 1
        if state["n"] == 1:
            return httpx.Response(200, content=OPENAI_SSE)
        await asyncio.sleep(0.3)
        return httpx.Response(400, json={"error": {"message": "too long"}})

    cfg, app = make(tmp_path, monkeypatch, handler)
    token = (tmp_path / "token").read_text().strip()
    assert ask(app, token, "openai").status_code == 200  # the model has answered a small request
    big = "word " * 40_000  # about 50k tokens: more than 30% of the window and bigger than anything answered
    r = ask(app, token, "openai", {"messages": [{"role": "user", "content": big}]})
    assert r.status_code == 200 and ": ferry waiting" in r.text
    msg = json.loads(events(r.text)[0][1])["error"]["message"]
    assert "context_length_exceeded" in msg and "exceeds the context window" in msg


def test_reroute_after_commit_carries_the_reroute_text(tmp_path, monkeypatch):
    import re
    err = {"type": "error", "error": {"type": "rate_limit_error", "message": "slow down"}}
    cfg, app = make(tmp_path, monkeypatch, slow(0.3, lambda: httpx.Response(429, json=err, headers={"retry-after": "5"})), CLAUDE)
    token = (tmp_path / "token").read_text().strip()
    r = ask(app, token, "anthropic", headers={"x-ferry-reroute": "1"})
    assert r.status_code == 200 and ": ferry waiting" in r.text
    ev, data = events(r.text)[0]
    assert ev == "error"
    # what pi's Anthropic stream throws is the data text; the client's REROUTE pattern is searched in it
    reroute = re.compile(r"ferry-reroute:([^\s\"'\\,}@]+)@(anthropic|openai)(?:.*?\((\d+) s to go\))?(?:.*?\[model=([^\]\s]+)\])?")
    m = reroute.search(data)
    assert m and m.group(1) == "gpt" and m.group(2) == "openai" and m.group(4) == "gpt-6.1-sol"


def test_a_client_that_leaves_while_queued_frees_its_place(tmp_path, monkeypatch):
    state = {"calls": 0}

    cfg, _ = make(tmp_path, monkeypatch, lambda req: httpx.Response(200, content=OPENAI_SSE))
    token = (tmp_path / "token").read_text().strip()

    async def go():
        gate = asyncio.Event()

        async def handler(req):
            state["calls"] += 1
            if state["calls"] == 1:
                await gate.wait()  # the first request holds the only slot
            return httpx.Response(200, content=OPENAI_SSE)

        monkeypatch.setattr(app_mod.httpx, "AsyncClient", lambda **kw: REAL(transport=httpx.MockTransport(handler), **kw))
        app2 = app_mod.create_app(cfg)
        cfg.providers["b"].max_concurrent = 1
        async with REAL(transport=httpx.ASGITransport(app=app2), base_url="http://t") as c:
            def post():
                return c.post("/v1/chat/completions", headers={"Authorization": f"Bearer {token}"},
                              json={"model": "other", "stream": True, "messages": [{"role": "user", "content": "hi"}]})
            first = asyncio.create_task(post())
            await asyncio.sleep(0.05)
            second = asyncio.create_task(post())
            await asyncio.sleep(0.4)  # committed and queued behind the first
            second.cancel()
            await asyncio.sleep(0.05)
            gate.set()
            assert (await first).status_code == 200
            third = await asyncio.wait_for(post(), 3)  # would hang if the cancelled request still held a place
            return third, state["calls"]

    third, calls = asyncio.run(go())
    assert third.status_code == 200 and '"later"' in third.text
    assert calls == 2  # the cancelled request never reached the provider
