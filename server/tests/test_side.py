import asyncio
import json

import httpx

import ferry_server.app as app_mod
from ferry_server import side
from ferry_server.config import ModelConfig, load_default

REAL = httpx.AsyncClient


def setup(tmp_path, monkeypatch, seen):
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "FERRY_TOKEN", "FERRY_SECRET"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "k")
    monkeypatch.setenv("FERRY_SERVER_HOME", str(tmp_path))

    def handler(req: httpx.Request):
        body = json.loads(req.content)
        seen.append((req.url.host, body))
        return httpx.Response(200, json={"choices": [{"message": {"content": f"ANSWER from {body['model']}"}, "finish_reason": "stop"}],
                                         "usage": {"prompt_tokens": 1000, "completion_tokens": 100}})

    monkeypatch.setattr(app_mod.httpx, "AsyncClient", lambda **kw: REAL(transport=httpx.MockTransport(handler), **kw))
    cfg = load_default()
    cfg.models["deepseek"].price = {"input": 0.3, "output": 1.0}
    for mid, price in (("strong", {"input": 15, "output": 75}), ("cheap", {"input": 0.1, "output": 0.2})):
        cfg.models[mid] = ModelConfig(id=mid, base_url="http://x.example/v1", model=f"{mid}-model", no_key=True, price=price)
    return cfg, app_mod.create_app(cfg), (tmp_path / "token").read_text().strip()


def test_advisor_cheapest_and_off_choices(tmp_path, monkeypatch):
    cfg, _, _ = setup(tmp_path, monkeypatch, [])
    cur = cfg.models["deepseek"]
    assert side.advisor_model(cfg).id == "strong"                      # empty = the most expensive
    assert side.cheap_model(cfg, cur).id == "cheap"                    # cheapest with a price
    cfg.advisor_model = "cheap"
    assert side.advisor_model(cfg).id == "cheap"                       # set on the admin page
    cfg.advisor_model = ""
    cfg.default_model = "strong"
    assert side.advisor_model(cfg) is None                             # the priciest is the one doing the work: off
    cfg.summary_model = "deepseek"
    assert side.cheap_model(cfg, cur).id == "deepseek"                 # a summary model, when set, writes recaps


def test_transcript_reads_both_stored_shapes_and_keeps_the_start():
    openai = [{"role": "system", "content": "rules"}, {"role": "user", "content": "make the deck"},
              {"role": "assistant", "content": None, "tool_calls": [{"function": {"name": "read", "arguments": '{"path":"a.txt"}'}}]},
              {"role": "tool", "content": "x" * 5000}]
    t = side.transcript(openai, "final words", 100000)
    assert "rules" not in t and t.startswith("[User]: make the deck")
    assert "[Assistant tool calls]: read(" in t and "characters left out" in t and t.endswith("[Assistant]: final words")
    claude = [{"role": "__system__", "content": "rules"}, {"role": "user", "content": [{"type": "text", "text": "hello"}]},
              {"role": "assistant", "content": [{"type": "thinking", "thinking": "hmm"}, {"type": "tool_use", "name": "bash", "input": {"command": "ls"}}]},
              {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "1", "content": [{"type": "text", "text": "file.txt"}]}]}]
    t = side.transcript(claude, "", 100000)
    assert "hmm" not in t and "bash(" in t and "[Tool result]: file.txt" in t
    many = [{"role": "user", "content": f"message {i} " + "word " * 200} for i in range(60)]
    short = side.transcript(many, "", 3000)
    assert short.startswith("[User]: message 0") and "earlier messages left out" in short and "message 59" in short


def test_endpoint_rebuilds_the_conversation_and_asks_the_right_model(tmp_path, monkeypatch):
    seen = []
    cfg, app, token = setup(tmp_path, monkeypatch, seen)
    hdr = {"Authorization": f"Bearer {token}"}
    msgs = [json.dumps({"role": "user", "content": "write the patent disclosure"}),
            json.dumps({"role": "assistant", "content": "drafting section 1"})]

    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            assert "advisor" in (await c.get("/v1/ferry/models", headers=hdr)).json()["features"]
            r = await c.post("/v1/ferry/commit", params={"conv": "c1", "base": 0}, headers=hdr, content=json.dumps({"append": msgs}))
            ref = {"conv": "c1", "count": r.json()["count"], "hash": r.json()["hash"]}
            a = (await c.post("/v1/ferry/side", headers=hdr, json={"kind": "advise", "question": "is the claim set enough?", "ferry": ref})).json()
            b = (await c.post("/v1/ferry/side", headers=hdr, json={"kind": "btw", "question": "what is claim 1?", "ferry": ref, "tail": "claim 1 is about X"})).json()
            n = (await c.post("/v1/ferry/side", headers=hdr, json={"kind": "recap", "ferry": ref})).json()
            lost = await c.post("/v1/ferry/side", headers=hdr, json={"kind": "btw", "question": "q", "ferry": {**ref, "hash": "nope"}})
            none = (await c.post("/v1/ferry/side", headers=hdr, json={"kind": "btw", "question": "no conversation"})).json()
            bad = await c.post("/v1/ferry/side", headers=hdr, json={"kind": "other"})
            return a, b, n, lost, none, bad

    a, b, n, lost, none, bad = asyncio.run(go())
    assert a["model"] == "strong" and b["model"] == "deepseek" and n["model"] == "cheap"
    up = {body["model"]: body["messages"][-1]["content"] for _, body in seen}
    assert "write the patent disclosure" in up["strong-model"] and "stronger, more experienced reviewer" in up["strong-model"]
    assert "is the claim set enough?" in up["strong-model"]
    btw = [body["messages"][-1]["content"] for _, body in seen if body["model"] == "deepseek-flash"]
    assert "side question" in btw[0] and "claim 1 is about X" in btw[0] and "what is claim 1?" in btw[0]
    assert "under 40 words" in up["cheap-model"]
    assert all("tools" not in body for _, body in seen)                # no tools in any side call
    assert lost.status_code == 409 and bad.status_code == 400 and none["text"]
    log = [json.loads(x) for x in (cfg.data_dir / "audit.jsonl").read_text().splitlines()]
    side_rows = [r for r in log if r.get("purpose") in ("advise", "btw", "recap")]
    assert {r["purpose"] for r in side_rows} == {"advise", "btw", "recap"} and side_rows[0]["tokens"]["output"] == 100
    assert side_rows[0]["cost"] > 0                                    # priced like a chat call
