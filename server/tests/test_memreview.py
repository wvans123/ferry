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


def test_digest_uses_the_summary_model_and_returns_a_clean_card(tmp_path, monkeypatch):
    seen = []
    text = json.dumps({"goal": "fix the build", "category": "code", "outcome": "great",
                       "feedback": [{"after": "a patch", "type": "accepted", "quote": "works"}, {"after": "x", "type": "maybe"}, "bad"],
                       "corrections": ["use pnpm", "", 3] + [f"c{i}" for i in range(10)], "friction": ["misunderstood"],
                       "failures": [{"symptom": "npm failed", "cause": "lockfile", "fix": "pnpm i"}]})
    cfg, app, token = setup(tmp_path, monkeypatch, seen, {"text": text})
    d = post(app, token, {"kind": "digest", "today": "2026-11-06", "transcript": "[User]: use pnpm"}).json()
    c = d["card"]
    assert d["model"] == "cheap" and c["outcome"] == "unknown" and c["category"] == "code"
    assert c["feedback"] == [{"after": "a patch", "type": "accepted", "quote": "works"}, {"after": "x", "type": "unknown", "quote": ""}]
    assert c["corrections"][:2] == ["use pnpm", "3"] and len(c["corrections"]) == 8
    assert c["failures"] == [{"symptom": "npm failed", "cause": "lockfile", "fix": "pnpm i"}]
    prompt = seen[0]["messages"][-1]["content"]
    assert "<transcript>\n[User]: use pnpm" in prompt and '"continue"' in prompt and "copied exactly" in prompt
    assert "<memories_in_full>" not in prompt and "tools" not in seen[0]
    assert post(app, token, {"kind": "digest", "transcript": ""}).status_code == 400


def test_distill_uses_the_conversation_model_and_checks_items(tmp_path, monkeypatch):
    seen = []
    ev = [{"session": "aaaa1111", "date": "2026-11-01", "quote": "path first"}]
    text = json.dumps({"items": [
        {"kind": "memory", "op": "add", "target": "user", "name": "Path First", "content": "Give the path first.", "evidence": ev},
        {"kind": "memory", "target": "global", "name": "x", "content": "y"},
        {"kind": "rule", "op": "update", "target": "project-agents", "name": "r", "content": "Run tests.", "evidence": ev},
        {"kind": "skill", "target": "skill:Release Notes", "name": "ignored", "content": "steps", "description": "when"},
        {"kind": "habit", "content": "say the goal first"},
        {"kind": "secret", "content": "z"},
    ] + [{"kind": "skill", "target": f"skill:s{i}", "content": "x"} for i in range(3)],
        "recurrence": [{"item": "path-first", "seen_again": "yes", "evidence": "x"}, {"item": ""}]})
    _, app, token = setup(tmp_path, monkeypatch, seen, {"text": text})
    body = {"kind": "distill", "model": "deepseek", "today": "2026-11-06", "project": "ferry",
            "cards": [{"session": "aaaa1111", "date": "2026-11-01", "project": "ferry", "new": True, "card": {"goal": "g", "corrections": ["path first"]}},
                      {"session": "bbbb2222", "date": "2026-09-01", "project": "web", "new": False, "card": {"goal": "old"}}],
            "agents": {"user": "Reply in Chinese.", "project": ""}, "skills": ["office"], "accepted": [{"name": "path-first"}],
            "never": ["rule:user-agents:no-emoji"], "memories": [{"scope": "user", "name": "lang", "content": "Chinese"}]}
    d = post(app, token, body).json()
    assert d["model"] == "deepseek" and [b["model"] for b in seen] == ["deepseek-flash"]   # not the summary model
    assert [(i["kind"], i["target"], i["name"]) for i in d["items"]] == [
        ("memory", "user", "path-first"), ("rule", "project-agents", "r"), ("skill", "skill:release-notes", "release-notes"),
        ("habit", "", ""), ("skill", "skill:s0", "s0")]                                     # at most 2 skills
    assert d["items"][0]["evidence"] == ev and d["recurrence"] == [{"item": "path-first", "seen_again": False, "evidence": "x"}]
    prompt = seen[0]["messages"][-1]["content"]
    assert "[NEW] session=aaaa1111 date=2026-11-01 project=ferry" in prompt and "[old] session=bbbb2222" in prompt
    assert "Reply in Chinese." in prompt and "no-emoji" in prompt and 'The current project is "ferry"' in prompt
    assert "at least 3 different sessions" in prompt and "Zero items is a good answer" in prompt
    assert post(app, token, {"kind": "distill", "cards": []}).status_code == 400


def test_global_index_puts_the_newest_first(tmp_path):
    for i in range(205):
        globalmem.save(tmp_path, "w", f"old-{i}", f"note {i}", "x")
    globalmem.save(tmp_path, "w", "old-3", "changed", "y")
    idx = globalmem.index(tmp_path, "w").splitlines()
    assert idx[0] == "- [old-3](old-3.md): changed" and idx[1].startswith("- [old-204]")
    assert idx[-1].startswith("(index cut at 200 lines") and sum("[old-3]" in x for x in idx) == 1
