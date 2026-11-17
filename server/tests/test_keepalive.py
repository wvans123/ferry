"""A streaming request that waits for its upstream sends SSE comments, so Cloudflare Tunnel (524 after ~100 s of
silence) keeps the connection; errors after that point arrive as SSE error events."""
import asyncio
import json
import time

import httpx
import pytest

import ferry_server.app as app_mod
from test_pool import CLAUDE, REAL, make

OPENAI_SSE = (b'data: {"choices":[{"index":0,"delta":{"content":"later"}}]}\n\n'
              b'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\ndata: [DONE]\n\n')
CLAUDE_SSE = (b'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n'
              b'event: message_stop\ndata: {"type":"message_stop"}\n\n')
CLAUDE_LENGTH_SSE = (b'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n'
                     b'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},'
                     b'"usage":{"output_tokens":100}}\n\n'
                     b'event: message_stop\ndata: {"type":"message_stop"}\n\n')
CLAUDE_ERROR_SSE = (b'event: error\ndata: {"type":"error","error":{"type":"upstream_error",'
                    b'"message":"Upstream access forbidden, please contact administrator"}}\n\n')


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


def test_openai_eof_without_finish_is_a_retryable_error_event(tmp_path, monkeypatch):
    partial = b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
    cfg, app = make(tmp_path, monkeypatch, lambda req: httpx.Response(200, content=partial))
    r = ask(app, (tmp_path / "token").read_text().strip(), "openai")
    assert r.status_code == 200 and '"partial"' in r.text
    error = json.loads(events(r.text)[-1][1])["error"]
    assert error["type"] == "ferry_stream_incomplete"
    assert "upstream stream ended before completion" in error["message"] and "504" in error["message"]
    assert audit_rows(cfg)[-1]["status"] == 504


def test_anthropic_eof_without_message_stop_is_a_retryable_error_event(tmp_path, monkeypatch):
    partial = b'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n'
    cfg, app = make(tmp_path, monkeypatch, lambda req: httpx.Response(200, content=partial), CLAUDE)
    r = ask(app, (tmp_path / "token").read_text().strip(), "anthropic")
    assert r.status_code == 200 and "message_start" in r.text
    ev, data = events(r.text)[-1]
    error = json.loads(data)
    assert ev == "error" and error["error"]["type"] == "ferry_stream_incomplete"
    assert "message_stop" in error["error"]["message"] and "504" in error["error"]["message"]
    assert audit_rows(cfg)[-1]["status"] == 504


def test_anthropic_audit_records_output_limit_stop_reason_and_effective_cap(tmp_path, monkeypatch):
    cfg, app = make(tmp_path, monkeypatch, lambda req: httpx.Response(200, content=CLAUDE_LENGTH_SSE), CLAUDE)
    r = ask(app, (tmp_path / "token").read_text().strip(), "anthropic")
    assert r.status_code == 200
    row = audit_rows(cfg)[-1]
    assert row["stop_reason"] == "max_tokens" and row["max_tokens"] == 100


def test_anthropic_error_event_inside_http_200_is_audited_as_upstream_error(tmp_path, monkeypatch):
    monkeypatch.setattr(app_mod, "retry_delay", lambda headers, attempt: 0)
    cfg, app = make(tmp_path, monkeypatch, lambda req: httpx.Response(200, content=CLAUDE_ERROR_SSE), CLAUDE)
    r = ask(app, (tmp_path / "token").read_text().strip(), "anthropic")
    assert r.status_code == 403 and "Upstream access forbidden" in r.text
    assert "ferry_stream_incomplete" not in r.text
    row = audit_rows(cfg)[-1]
    assert len(audit_rows(cfg)) == 2
    assert row["retry_count"] == 1 and row["attempt"] == 2
    assert row["status"] == 403 and row["upstream_http_status"] == 200
    assert "Upstream access forbidden" in row["upstream_error"]


@pytest.mark.parametrize("kind", ["openai", "anthropic", "responses"])
def test_opening_sse_forbidden_retries_before_output_and_keeps_success(tmp_path, monkeypatch, kind):
    calls = []
    success = CLAUDE_SSE if kind == "anthropic" else OPENAI_SSE
    if kind == "responses":
        success = (b'data: {"type":"response.output_text.delta","delta":"later"}\n\n'
                   b'data: {"type":"response.completed","response":{}}\n\n')

    def handler(req):
        calls.append(req)
        return httpx.Response(200, content=b": upstream heartbeat\n\n" + CLAUDE_ERROR_SSE if len(calls) == 1 else success)

    cfg, app = make(tmp_path, monkeypatch, handler, CLAUDE)
    if kind == "responses":
        cfg.models["other"].api = "openai-responses"
    monkeypatch.setattr(app_mod, "retry_delay", lambda headers, attempt: 0)
    r = ask(app, (tmp_path / "token").read_text().strip(), kind)
    assert r.status_code == 200 and len(calls) == 2
    assert "forbidden" not in r.text and "ferry_stream_incomplete" not in r.text
    assert [row["status"] for row in audit_rows(cfg)] == [403, 200]
    if kind == "anthropic":
        assert r.content == CLAUDE_SSE
    elif kind == "openai":
        assert r.content == OPENAI_SSE
    else:
        assert "later" in r.text and "[DONE]" in r.text


@pytest.mark.parametrize("kind", ["openai", "anthropic"])
@pytest.mark.parametrize("error,status,attempts", [
    ({"type": "authentication_error", "message": "invalid api key"}, 401, 1),
    ({"type": "permission_error", "message": "account disabled"}, 403, 1),
    ({"type": "upstream_error", "message": "Upstream access forbidden"}, 403, 2),
    ({"type": "overloaded_error", "message": "busy"}, 424, 4),
    ({"code": "context_length_exceeded", "message": "prompt is too long"}, 400, 1),
])
def test_opening_sse_error_policy(tmp_path, monkeypatch, kind, error, status, attempts):
    calls = []

    def handler(req):
        calls.append(req)
        body = 'event: error\ndata: ' + json.dumps({"type": "error", "error": error}) + '\n\n'
        return httpx.Response(200, text=body)

    cfg, app = make(tmp_path, monkeypatch, handler, CLAUDE)
    monkeypatch.setattr(app_mod, "retry_delay", lambda headers, attempt: 0)
    r = ask(app, (tmp_path / "token").read_text().strip(), kind)
    assert r.status_code == status and len(calls) == attempts
    if status == 424:
        assert r.json()["error"]["upstream_status"] == 529
    assert all(row["status"] != 200 for row in audit_rows(cfg))
    rows = audit_rows(cfg)
    assert [row["retry_count"] for row in rows] == list(range(attempts))
    assert all(row["upstream_http_status"] == 200 for row in rows)


@pytest.mark.parametrize("kind", ["openai", "anthropic", "responses"])
def test_midstream_error_preserves_classification_and_redacts_credentials(tmp_path, monkeypatch, kind):
    calls = []
    error = {"type": "permission_error", "code": "access_denied",
             "message": "permission denied; Bearer private-value api_key=private-key sk-private123456",
             "request": {"messages": "private conversation"}}
    if kind == "anthropic":
        content = CLAUDE_SSE.split(b'event: message_stop')[0]
        event = {"type": "error", "error": error}
    elif kind == "responses":
        content = b'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
        event = {"type": "response.failed", "response": {"error": error}}
    else:
        content = OPENAI_SSE.split(b'\n\n')[0] + b'\n\n'
        event = {"error": error}
    content += ("data: " + json.dumps(event) + "\n\n").encode()

    def handler(req):
        calls.append(req)
        return httpx.Response(200, content=content)

    cfg, app = make(tmp_path, monkeypatch, handler, CLAUDE)
    if kind == "responses":
        cfg.models["other"].api = "openai-responses"
    r = ask(app, (tmp_path / "token").read_text().strip(), kind)
    row = audit_rows(cfg)[-1]
    assert r.status_code == 200 and len(calls) == 1
    assert row["status"] == 403 and row["upstream_http_status"] == 200
    assert "ferry_stream_incomplete" not in r.text and "permission_error" in r.text
    for secret in ("private-value", "private-key", "sk-private123456", "private conversation"):
        assert secret not in r.text and secret not in json.dumps(row)


@pytest.mark.parametrize("kind", ["openai", "anthropic"])
@pytest.mark.parametrize("status,error,attempts,expected", [
    (503, {"type": "authentication_error", "message": "invalid api key"}, 1, 503),
    (403, {"message": "Upstream access forbidden"}, 2, 403),
    (400, {"code": "context_length_exceeded", "message": "prompt is too long"}, 1, 400),
    (502, {"message": "busy"}, 4, 424),
])
def test_http_error_policy_and_diagnostics(tmp_path, monkeypatch, kind, status, error, attempts, expected):
    cfg, app = make(tmp_path, monkeypatch, lambda req: httpx.Response(status, json={"error": error}), CLAUDE)
    monkeypatch.setattr(app_mod, "retry_delay", lambda headers, attempt: 0)
    r = ask(app, (tmp_path / "token").read_text().strip(), kind)
    rows = audit_rows(cfg)
    assert r.status_code == expected and len(rows) == attempts
    assert [row["retry_count"] for row in rows] == list(range(attempts))
    assert all(row["upstream_http_status"] == status and row["estimated_tokens"] > 0 for row in rows)


def test_error_diagnostics_only_copy_known_fields():
    body = json.dumps({"request": {"messages": "private text"}, "api_key": "private-key"}).encode()
    assert "private" not in app_mod.upstream_error_summary(body)
    safe = json.loads(app_mod.safe_error_body(403, body))["error"]
    assert safe["upstream_status"] == 403 and "private" not in json.dumps(safe)
    body = json.dumps({"error": {"message": 'gateway rejected {"api_key": "private-key", "token": "private-token"}'}}).encode()
    assert "private" not in app_mod.upstream_error_summary(body)


def test_error_after_anthropic_output_is_logged_without_replaying_the_request(tmp_path, monkeypatch):
    calls = []

    def handler(req):
        calls.append(req)
        return httpx.Response(200, content=CLAUDE_SSE.split(b'event: message_stop')[0] + CLAUDE_ERROR_SSE)

    cfg, app = make(tmp_path, monkeypatch, handler, CLAUDE)
    r = ask(app, (tmp_path / "token").read_text().strip(), "anthropic")
    assert r.status_code == 200 and len(calls) == 1 and "ferry_stream_incomplete" not in r.text
    row = audit_rows(cfg)[-1]
    assert row["status"] == 403 and row["last_event"] == "error"


def test_opening_event_handles_split_lines_multiline_data_and_keeps_pings():
    async def go():
        async def lines():
            for line in [": heartbeat", "", 'data: {"type":"ping"}', "", "event: error",
                         'data: {"error":', 'data: {"message":"Upstream access forbidden"}}', ""]:
                yield line
        first, failure = await app_mod.opening_event(lines())
        assert first[:4] == [": heartbeat", "", 'data: {"type":"ping"}', ""]
        assert failure[0] == 403
    asyncio.run(go())


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


def test_a_429_after_the_keepalive_began_waits_on_the_server_and_the_answer_follows(tmp_path, monkeypatch):
    calls = []

    def handler(req):
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(429, json={"type": "error", "error": {"type": "rate_limit_error", "message": "slow down"}},
                                  headers={"retry-after": "1"})
        return httpx.Response(200, content=CLAUDE_SSE)

    cfg, app = make(tmp_path, monkeypatch, slow(0.3, lambda: handler(None)), CLAUDE)
    token = (tmp_path / "token").read_text().strip()
    r = ask(app, token, "anthropic", headers={"x-ferry-reroute": "1"})
    assert r.status_code == 200 and ": ferry waiting" in r.text
    assert [ev for ev, _ in events(r.text)] == ["message_start", "message_stop"] and "ferry-reroute" not in r.text
    assert len(calls) == 2  # asked again after the cool-down, the same model


async def until(cond, limit=10):
    """Wait for a condition, not for a fixed time: a slow machine (Windows CI) takes longer than any guess."""
    end = time.time() + limit
    while not cond():
        assert time.time() < end, "timed out waiting for the condition"
        await asyncio.sleep(0.01)


def queued_then_leaves(tmp_path, monkeypatch, leave_at_commit):
    """First request holds the provider's only slot, the second is queued behind it and leaves, then the first ends
    and a third must get the slot. leave_at_commit: the second leaves in the very moment its stream is committed,
    before the response has started (the client side of that is a plain cancel)."""
    state = {"calls": 0, "commits": 0}
    cfg, _ = make(tmp_path, monkeypatch, lambda req: httpx.Response(200, content=OPENAI_SSE))
    token = (tmp_path / "token").read_text().strip()
    box = {}
    real_aok = app_mod.answer_or_keepalive

    async def aok(request, kind, stream, work, on_commit=None):
        def committed():
            state["commits"] += 1
            if leave_at_commit and state["commits"] == 2:
                box["second"].cancel()
            if on_commit:
                on_commit()
        return await real_aok(request, kind, stream, work, committed)

    monkeypatch.setattr(app_mod, "answer_or_keepalive", aok)

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
            await until(lambda: state["calls"] == 1)  # the first has the slot
            box["second"] = asyncio.create_task(post())
            await until(lambda: state["commits"] == 2)  # the second is committed and queued behind the first
            if not leave_at_commit:
                box["second"].cancel()
            await asyncio.wait({box["second"]}, timeout=5)
            await asyncio.sleep(0.05)  # lets the cancel reach the queued work
            gate.set()
            assert (await first).status_code == 200
            third = await asyncio.wait_for(post(), 5)  # would hang if the cancelled request still held a place
            return third, state["calls"]

    return asyncio.run(go())


def test_a_client_that_leaves_while_queued_frees_its_place(tmp_path, monkeypatch):
    third, calls = queued_then_leaves(tmp_path, monkeypatch, False)
    assert third.status_code == 200 and '"later"' in third.text
    assert calls == 2  # the cancelled request never reached the provider


def test_a_client_that_leaves_before_the_committed_stream_starts_frees_its_place(tmp_path, monkeypatch):
    third, calls = queued_then_leaves(tmp_path, monkeypatch, True)
    assert third.status_code == 200 and '"later"' in third.text
    assert calls == 2


# ---- an upstream that accepts the request and then goes silent (a stalled relay)

class Silent(httpx.AsyncByteStream):
    """Response headers, optionally one chunk, then nothing for a long time."""
    closed = False

    def __init__(self, first=b""):
        self.first = first

    async def __aiter__(self):
        if self.first:
            yield self.first
        await asyncio.sleep(30)

    async def aclose(self):
        Silent.closed = True


def audit_rows(cfg):
    path = cfg.data_dir / "audit.jsonl"
    return [json.loads(l) for l in path.read_text().splitlines() if '"event": "chat"' in l or '"event":"chat"' in l]


def test_a_mid_stream_disconnect_records_the_last_upstream_event(tmp_path, monkeypatch):
    class ResetAfterText(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
            raise httpx.ReadError("connection reset by peer")

        async def aclose(self):
            pass

    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(200, stream=ResetAfterText())

    cfg, app = make(tmp_path, monkeypatch, handler)
    r = ask(app, (tmp_path / "token").read_text().strip(), "openai")
    rows = audit_rows(cfg)
    assert r.status_code == 200 and "partial" in r.text and "upstream stream failed" in r.text
    assert len(calls) == 1  # Ferry never replays a request after it has sent response data
    assert rows[-1]["last_event"] == "chat.completion.chunk" and "connection reset" in rows[-1]["error"]


def test_a_stall_before_any_data_goes_to_the_other_pool_member(tmp_path, monkeypatch):
    seen = []

    def handler(req):
        seen.append(req.url.host)
        if req.url.host == "a.example.com":
            return httpx.Response(200, stream=Silent())
        return httpx.Response(200, content=OPENAI_SSE)

    cfg, app = make(tmp_path, monkeypatch, handler)
    cfg.providers["a"].stall_seconds = 0.3
    monkeypatch.setattr(app_mod, "KEEPALIVE_S", 30)
    r = ask(app, (tmp_path / "token").read_text().strip(), "openai", model="gpt")
    assert r.status_code == 200 and '"later"' in r.text and seen == ["a.example.com", "b.example.com"]
    rows = audit_rows(cfg)
    assert rows[0]["status"] == 504 and "stalled after 0.3 s" in rows[0]["error"] and rows[-1]["status"] == 200


def test_a_stall_asks_the_same_model_once_more_even_past_the_time_budget(tmp_path, monkeypatch):
    calls = []

    def handler(req):
        calls.append(req.url.host)
        return httpx.Response(200, stream=Silent()) if len(calls) == 1 else httpx.Response(200, content=OPENAI_SSE)

    cfg, app = make(tmp_path, monkeypatch, handler)
    cfg.providers["b"].stall_seconds = 0.3
    monkeypatch.setattr(app_mod, "retry_delay", lambda headers, attempt: 0.01)
    monkeypatch.setattr(app_mod, "RETRY_WAIT_S", 0.1)  # the stall alone used it up
    monkeypatch.setattr(app_mod, "KEEPALIVE_S", 30)
    r = ask(app, (tmp_path / "token").read_text().strip(), "openai")  # "other" is only on provider b: no other model answers
    assert r.status_code == 200 and '"later"' in r.text and calls == ["b.example.com", "b.example.com"]
    rows = audit_rows(cfg)
    assert [x["status"] for x in rows] == [504, 200]


def test_a_stall_after_data_ends_the_stream_with_a_retryable_error_and_is_not_a_success(tmp_path, monkeypatch):
    import re
    cfg, app = make(tmp_path, monkeypatch, lambda req: httpx.Response(200, stream=Silent(OPENAI_SSE.split(b"\n\n")[0] + b"\n\n")))
    cfg.providers["b"].stall_seconds = 0.3
    cfg.providers["b"].max_concurrent = 1
    token = (tmp_path / "token").read_text().strip()
    r = ask(app, token, "openai")
    assert r.status_code == 200 and '"later"' in r.text
    err = json.loads(events(r.text)[-1][1])["error"]["message"]
    # pi asks again when its error text has one of these words
    assert re.search(r"overloaded|(?<![a-z0-9])504(?![a-z0-9])", err) and "upstream stalled" in err
    rows = audit_rows(cfg)
    assert [x["status"] for x in rows] == [504] and "stalled after 0.3 s" in rows[0]["error"]
    assert Silent.closed
    # its place is free again
    monkeypatch.setattr(app_mod.httpx, "AsyncClient", lambda **kw: REAL(transport=httpx.MockTransport(lambda q: httpx.Response(200, content=OPENAI_SSE)), **kw))
    app2 = app_mod.create_app(cfg)
    cfg.providers["b"].max_concurrent = 1
    assert '"later"' in ask(app2, token, "openai").text


def test_anthropic_stall_after_data_is_an_error_event(tmp_path, monkeypatch):
    cfg, app = make(tmp_path, monkeypatch, lambda req: httpx.Response(200, stream=Silent(CLAUDE_SSE.split(b"\n\n")[0] + b"\n\n")), CLAUDE)
    cfg.providers["c"].stall_seconds = 0.3
    r = ask(app, (tmp_path / "token").read_text().strip(), "anthropic")
    assert r.status_code == 200
    ev, data = events(r.text)[-1]
    assert ev == "error" and "upstream stalled" in data and "overloaded" in data
    assert audit_rows(cfg)[-1]["status"] == 504


def test_the_only_provider_stalling_ends_in_a_retryable_504(tmp_path, monkeypatch):
    cfg, app = make(tmp_path, monkeypatch, lambda req: httpx.Response(200, stream=Silent()))
    cfg.providers["b"].stall_seconds = 0.2
    monkeypatch.setattr(app_mod, "retry_delay", lambda headers, attempt: 0.01)
    monkeypatch.setattr(app_mod, "RETRY_WAIT_S", 0.7)
    monkeypatch.setattr(app_mod, "KEEPALIVE_S", 30)
    r = ask(app, (tmp_path / "token").read_text().strip(), "openai")
    assert r.status_code == 504 and "upstream stalled" in r.text and "overloaded" in r.text
    assert 2 <= len(audit_rows(cfg)) <= 5


def test_a_client_that_leaves_mid_stream_closes_the_upstream_and_is_logged(tmp_path, monkeypatch):
    Silent.closed = False
    cfg, app = make(tmp_path, monkeypatch, lambda req: httpx.Response(200, stream=Silent(OPENAI_SSE.split(b"\n\n")[0] + b"\n\n")))
    cfg.providers["b"].stall_seconds = 0  # no stall detection: only the client's leaving ends it
    token = (tmp_path / "token").read_text().strip()

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            t = asyncio.create_task(c.post("/v1/chat/completions", headers={"Authorization": f"Bearer {token}"},
                                           json={"model": "other", "stream": True, "messages": [{"role": "user", "content": "hi"}]}))
            await asyncio.sleep(0.5)
            t.cancel()
            await asyncio.sleep(0.2)

    asyncio.run(go())
    assert Silent.closed
    rows = audit_rows(cfg)
    assert rows and rows[-1]["status"] == 499 and rows[-1]["error"] == "client disconnected"
