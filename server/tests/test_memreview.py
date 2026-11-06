import asyncio
import json

import httpx

import ferry_server.app as app_mod
from ferry_server import globalmem, memreview
from ferry_server.config import ModelConfig, load_default

REAL = httpx.AsyncClient


def setup(tmp_path, monkeypatch, seen, answer):
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "FERRY_TOKEN", "FERRY_SECRET"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "k")
    monkeypatch.setenv("FERRY_SERVER_HOME", str(tmp_path))

    def handler(req: httpx.Request):
        body = json.loads(req.content)
        seen.append(body)
        if body["model"] == "cheap-model" and answer.get("cheap_down"):
            return httpx.Response(503, json={"error": "down"})
        return httpx.Response(200, json={"choices": [{"message": {"content": answer["text"]}, "finish_reason": "stop"}],
                                         "usage": {"prompt_tokens": 1000, "completion_tokens": 100}})

    monkeypatch.setattr(app_mod.httpx, "AsyncClient", lambda **kw: REAL(transport=httpx.MockTransport(handler), **kw))
    cfg = load_default()
    cfg.models["deepseek"].price = {"input": 0.3, "output": 1.0}
    cfg.models["cheap"] = ModelConfig(id="cheap", base_url="http://x.example/v1", model="cheap-model", no_key=True,
                                      price={"input": 0.1, "output": 0.2})
    return cfg, app_mod.create_app(cfg), (tmp_path / "token").read_text().strip()


def post(app, token, body):
    async def go():
        async with REAL(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            return await c.post("/v1/ferry/memory-review", headers={"Authorization": f"Bearer {token}"}, json=body)
    return asyncio.run(go())


def test_propose_asks_the_summary_model_without_tools_and_returns_checked_candidates(tmp_path, monkeypatch):
    seen = []
    text = "```json\n" + json.dumps({"candidates": [
        {"action": "add", "scope": "project", "name": "Uses PNPM.md", "description": "package\nmanager", "content": "Use pnpm.\nWhy: x",
         "reason": "you said so"},
        {"action": "weird", "scope": "global", "name": "tea", "content": "likes tea"},
        {"action": "add", "scope": "user", "name": "", "content": "no name"},
        {"action": "update", "scope": "user", "name": "a", "content": "1"}, {"name": "b", "content": "2"}, {"name": "c", "content": "3"},
    ]}) + "\n```"
    cfg, app, token = setup(tmp_path, monkeypatch, seen, {"text": text})
    r = post(app, token, {"kind": "propose", "today": "2026-11-06", "transcript": "[User]: always use pnpm here",
                          "indexes": {"user": "- [lang](lang.md): reply in Chinese", "project": ""},
                          "memories": [{"scope": "user", "name": "lang", "description": "reply in Chinese", "content": "Reply in Chinese."}]})
    d = r.json()
    assert r.status_code == 200 and d["model"] == "cheap"
    assert d["candidates"][0] == {"action": "add", "scope": "project", "name": "uses-pnpm", "description": "package manager",
                                  "content": "Use pnpm.\nWhy: x", "reason": "you said so"}
    assert d["candidates"][1]["action"] == "add" and d["candidates"][1]["scope"] == "project"   # unknown values fall back
    assert len(d["candidates"]) == 3                                                            # at most three, nameless dropped
    prompt = seen[0]["messages"][-1]["content"]
    assert "always use pnpm here" in prompt and "reply in Chinese" in prompt and "Today is 2026-11-06" in prompt
    assert "Propose at most three memories" in prompt and "assistant's own guesses" in prompt and "AGENTS.md" in prompt
    assert "tools" not in seen[0]
    log = [json.loads(x) for x in (cfg.data_dir / "audit.jsonl").read_text().splitlines()]
    rows = [x for x in log if x.get("purpose") == "memory"]
    assert rows and rows[0]["status"] == 200 and "pnpm" not in json.dumps(rows)                # the content is not logged
    assert not (cfg.data_dir / "memory").exists()                                              # nothing is kept


def test_tidy_returns_valid_operations_and_falls_back_to_the_conversation_model(tmp_path, monkeypatch):
    seen = []
    text = json.dumps({"operations": [
        {"op": "merge", "scope": "project", "sources": ["a", "b"], "name": "ab", "content": "A and B", "reason": "same"},
        {"op": "merge", "scope": "project", "sources": ["a"], "name": "a", "content": "x"},
        {"op": "rewrite", "scope": "user", "name": "c", "content": ""},
        {"op": "delete", "scope": "project", "name": "old", "reason": "stale"},
        {"op": "drop-table", "scope": "project", "name": "x"},
    ]})
    _, app, token = setup(tmp_path, monkeypatch, seen, {"text": text, "cheap_down": True})
    d = post(app, token, {"kind": "tidy", "memories": [{"scope": "project", "name": "a", "content": "A"},
                                                       {"scope": "project", "name": "b", "content": "B"}]}).json()
    assert [(o["op"], o["name"]) for o in d["operations"]] == [("merge", "ab"), ("delete", "old")]
    assert d["model"] == "deepseek" and [b["model"] for b in seen] == ["cheap-model", "deepseek-flash"]
    assert "<transcript>" not in seen[0]["messages"][-1]["content"] and 'name="b"' in seen[0]["messages"][-1]["content"]


def test_bad_requests_and_a_non_json_answer(tmp_path, monkeypatch):
    _, app, token = setup(tmp_path, monkeypatch, [], {"text": "I think nothing is worth keeping."})
    assert post(app, token, {"kind": "other"}).status_code == 400
    assert post(app, token, {"kind": "propose", "transcript": " "}).status_code == 400
    assert post(app, token, {"kind": "propose", "transcript": "[User]: hi"}).json()["candidates"] == []
    assert memreview.candidates({"candidates": "nope"}) == [] and memreview.operations({}) == []


def test_global_index_puts_the_newest_first(tmp_path):
    for i in range(205):
        globalmem.save(tmp_path, "w", f"old-{i}", f"note {i}", "x")
    globalmem.save(tmp_path, "w", "old-3", "changed", "y")
    idx = globalmem.index(tmp_path, "w").splitlines()
    assert idx[0] == "- [old-3](old-3.md): changed" and idx[1].startswith("- [old-204]")
    assert idx[-1].startswith("(index cut at 200 lines") and sum("[old-3]" in x for x in idx) == 1
