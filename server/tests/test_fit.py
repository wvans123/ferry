import asyncio
import base64
import json

import httpx

import ferry_server.app as app_mod
from ferry_server.config import load_default

REAL = httpx.AsyncClient

MODELS = """
[routing]
default = "kiro"
expose = true
image = "pics"

[providers.k]
base_url = "https://kiro.example.com/v1"
api_key_env = "KEY_K"

[providers.r]
base_url = "https://resp.example.com/v1"
api_key_env = "KEY_R"
api = "openai-responses"

[models.kiro]
provider = "k"
model = "claude-opus-5.5"
context_window = 200000

[models.resp]
provider = "r"
model = "gpt-6.1-sol"
context_window = 400000

[models.pics]
provider = "k"
model = "gpt-image-2"
"""


def make(tmp_path, monkeypatch, handler):
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "FERRY_SESSION_STORE", "FERRY_TOKEN", "FERRY_SECRET"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("KEY_K", "kk")
    monkeypatch.setenv("KEY_R", "kr")
    monkeypatch.setenv("FERRY_SERVER_HOME", str(tmp_path))
    (tmp_path / "models.toml").write_text(MODELS, encoding="utf-8")
    monkeypatch.setattr(app_mod.httpx, "AsyncClient", lambda **kw: REAL(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(app_mod, "retry_delay", lambda headers, attempt: 0.01)
    cfg = load_default()
    return cfg, app_mod.create_app(cfg), {"Authorization": f"Bearer {(tmp_path / 'token').read_text().strip()}"}


def chat_answer(text="ok"):
    return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": text}}],
                                     "usage": {"prompt_tokens": 10, "completion_tokens": 2}})


def post(app, hdr, path, body):
    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            return await c.post(path, headers=hdr, json=body)
    return asyncio.run(go())


def test_a_responses_api_provider_answers_like_chat_completions(tmp_path, monkeypatch):
    seen = []

    def handler(req: httpx.Request):
        seen.append((req.url.path, json.loads(req.content)))
        events = [
            {"type": "response.created", "response": {"id": "resp_1"}},
            {"type": "response.output_text.delta", "delta": "Look"},
            {"type": "response.output_item.added", "output_index": 1, "item": {"type": "function_call", "id": "fc_1", "call_id": "call_9", "name": "read"}},
            {"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": '{"path":'},
            {"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": '"a.txt"}'},
            {"type": "response.completed", "response": {"usage": {"input_tokens": 120, "output_tokens": 7, "total_tokens": 127,
                                                                   "input_tokens_details": {"cached_tokens": 100}}}},
        ]
        return httpx.Response(200, text="".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events),
                              headers={"content-type": "text/event-stream"})

    cfg, app, hdr = make(tmp_path, monkeypatch, handler)
    r = post(app, hdr, "/v1/chat/completions", {"model": "resp", "stream": True, "max_completion_tokens": 100, "messages": [
        {"role": "system", "content": "be brief"}, {"role": "user", "content": "read a.txt"},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "ls", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "call_1", "content": "a.txt"}],
        "tools": [{"type": "function", "function": {"name": "read", "description": "read a file", "parameters": {"type": "object"}}}]})
    path, sent = seen[0]
    assert path == "/v1/responses" and sent["instructions"].startswith("be brief") and sent["max_output_tokens"] == 100
    assert [i.get("type", i.get("role")) for i in sent["input"]] == ["user", "function_call", "function_call_output"]
    assert sent["tools"][0]["name"] == "read" and "messages" not in sent and sent["store"] is False
    chunks = [json.loads(l[6:]) for l in r.text.splitlines() if l.startswith("data: {")]
    text = "".join(c["choices"][0]["delta"].get("content") or "" for c in chunks if c.get("choices"))
    args = "".join(tc["function"].get("arguments", "") for c in chunks if c.get("choices")
                   for tc in c["choices"][0]["delta"].get("tool_calls") or [])
    finish = [c["choices"][0]["finish_reason"] for c in chunks if c.get("choices") and c["choices"][0]["finish_reason"]]
    usage = [c["usage"] for c in chunks if c.get("usage")]
    assert text == "Look" and json.loads(args) == {"path": "a.txt"} and finish == ["tool_calls"]
    assert usage[0]["prompt_tokens"] == 120 and usage[0]["prompt_tokens_details"]["cached_tokens"] == 100


def test_a_relay_that_refuses_big_requests_teaches_the_server_its_real_limit(tmp_path, monkeypatch):
    calls = []

    def handler(req: httpx.Request):
        size = len(req.content)
        calls.append(size)
        return chat_answer() if size < 200_000 else httpx.Response(502, text="")  # kiro: a bare 502 when too big

    cfg, app, hdr = make(tmp_path, monkeypatch, handler)
    small = {"model": "kiro", "messages": [{"role": "user", "content": "word " * 20_000}]}     # ~25k tokens: fine
    big = {"model": "kiro", "messages": [{"role": "user", "content": "word " * 60_000}]}       # ~75k tokens: refused
    assert post(app, hdr, "/v1/chat/completions", small).status_code == 200
    r = post(app, hdr, "/v1/chat/completions", big)
    assert r.status_code == 400 and "context_length_exceeded" in r.text  # the client will summarise, not retry
    tried = len(calls)
    assert tried <= 4  # asked again once at most, not for 45 seconds
    r = post(app, hdr, "/v1/chat/completions", big)
    assert r.status_code == 400 and len(calls) == tried  # known now: not sent again

    async def listed():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            return (await c.get("/v1/ferry/models", headers=hdr)).json()["models"]
    kiro = next(m for m in asyncio.run(listed()) if m["id"] == "kiro")
    assert kiro["contextWindow"] < 75_000  # the client compacts before reaching it


def test_a_summary_too_big_for_the_model_is_written_in_parts_by_the_same_model(tmp_path, monkeypatch):
    prompts = []

    def handler(req: httpx.Request):
        b = json.loads(req.content)
        prompts.append(b["messages"][-1]["content"])
        return chat_answer(f"SUMMARY {len(prompts)}")

    cfg, app, hdr = make(tmp_path, monkeypatch, handler)
    cfg.models["kiro"].context_window = 60_000
    history = "\n\n".join(f"[User]: question {i} " + "detail " * 400 + f"\n\n[Assistant]: answer {i}" for i in range(200))
    text = f"<conversation>\n{history}\n</conversation>\n\nThe messages above are a conversation to summarize. Use this format."
    async def summary():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            body = json.dumps({"append": [json.dumps({"role": "system", "content": "You are a context summarization assistant."}),
                                          json.dumps({"role": "user", "content": text})], "tools": None})
            ack = (await c.post("/v1/ferry/commit", params={"conv": "s1", "base": 0, "base_hash": ""}, content=body, headers=hdr)).json()
            return await c.post("/v1/chat/completions", headers=hdr, json={"model": "kiro", "stream": True, "messages": [],
                                "ferry": {"conv": "s1", "count": ack["count"], "hash": ack["hash"], "purpose": "summary"}})

    r = asyncio.run(summary())
    assert r.status_code == 200 and len(prompts) >= 2
    assert "<previous-summary>\nSUMMARY 1" in prompts[1]  # each part updates the summary of the parts before
    text_out = "".join(json.loads(l[6:])["choices"][0]["delta"].get("content") or "" for l in r.text.splitlines()
                       if l.startswith("data: {"))
    assert text_out == f"SUMMARY {len(prompts)}"


def test_image_create_goes_to_the_image_model(tmp_path, monkeypatch):
    png = base64.b64encode(b"\x89PNG fake").decode()

    def handler(req: httpx.Request):
        assert req.url.path == "/v1/images/generations"
        b = json.loads(req.content)
        assert b["model"] == "gpt-image-2" and "response_format" not in b and b["size"] == "1536x1024"
        return httpx.Response(200, json={"data": [{"b64_json": png}]})

    cfg, app, hdr = make(tmp_path, monkeypatch, handler)
    r = post(app, hdr, "/v1/ferry/image", {"prompt": "a ferry at dawn", "size": "1536x1024"})
    assert r.status_code == 200 and r.json()["images"][0]["b64"] == png

    async def listed():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            return (await c.get("/v1/ferry/models", headers=hdr)).json()
    d = asyncio.run(listed())
    assert "image" in d["features"] and "pics" not in [m["id"] for m in d["models"]]


def test_pictures_and_thinking_signatures_do_not_count_as_text():
    from ferry_server.prompt import estimate_tokens
    img = base64.b64encode(b"x" * 1_000_000).decode()  # a 1 MB screenshot in Claude's format
    p = {"system": "be brief", "messages": [
        {"role": "user", "content": [{"type": "text", "text": "what is on this screen?"},
                                     {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": img}}]},
        {"role": "assistant", "content": [{"type": "thinking", "thinking": "hmm", "signature": "S" * 60_000},
                                          {"type": "text", "text": "a terminal"}]},
        {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64," + img}}]}]}
    assert estimate_tokens(p) < 5_000  # two pictures, not 700k tokens of base64


def test_a_refused_summary_is_asked_again_with_a_note_on_the_task(tmp_path, monkeypatch):
    systems = []

    def handler(req: httpx.Request):
        b = json.loads(req.content)
        systems.append(b["messages"][0]["content"])
        if len(systems) == 1:  # the first time the model declines
            return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": ""}, "finish_reason": "content_filter"}]})
        return chat_answer("THE SUMMARY")

    cfg, app, hdr = make(tmp_path, monkeypatch, handler)
    text = "<conversation>\n[User]: hello\n\n[Assistant]: hi\n</conversation>\n\nSummarize."

    async def summary():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            body = json.dumps({"append": [json.dumps({"role": "system", "content": "You are a context summarization assistant."}),
                                          json.dumps({"role": "user", "content": text})], "tools": None})
            ack = (await c.post("/v1/ferry/commit", params={"conv": "s2", "base": 0, "base_hash": ""}, content=body, headers=hdr)).json()
            return await c.post("/v1/chat/completions", headers=hdr, json={"model": "kiro", "stream": True, "messages": [],
                                "ferry": {"conv": "s2", "count": ack["count"], "hash": ack["hash"], "purpose": "summary"}})

    r = asyncio.run(summary())
    out = "".join(json.loads(l[6:])["choices"][0]["delta"].get("content") or "" for l in r.text.splitlines() if l.startswith("data: {"))
    assert out == "THE SUMMARY" and len(systems) == 2 and "expected task" in systems[1]

