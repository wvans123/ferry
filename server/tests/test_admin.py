import asyncio

import httpx

from ferry_server.app import create_app
from ferry_server.config import load_default


def make(tmp_path, monkeypatch):
    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "FERRY_SESSION_STORE", "FERRY_REDACT", "FERRY_TOKEN", "FERRY_SECRET"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "d")
    monkeypatch.setenv("FERRY_SERVER_HOME", str(tmp_path))
    cfg = load_default()
    return cfg, create_app(cfg)


def run(coro):
    return asyncio.run(coro)


def client(app, host="127.0.0.1"):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(host, 5555)), base_url="http://127.0.0.1:8787")


def test_admin_is_local_and_keyed(tmp_path, monkeypatch):
    cfg, app = make(tmp_path, monkeypatch)
    key = (tmp_path / "admin-key").read_text().strip()

    async def go():
        async with client(app) as c:
            assert (await c.get("/admin")).status_code == 403                      # no key yet
            assert (await c.get("/admin?key=wrong")).status_code == 403
            r = await c.get(f"/admin?key={key}")
            assert r.status_code == 303 and "ferry_admin" in r.headers["set-cookie"]
            c.cookies.set("ferry_admin", key)
            assert (await c.get("/admin")).status_code == 200
            st = (await c.get("/admin/api/status")).json()
            assert st["models"][0]["id"] == "deepseek" and st["token"]
            # changing needs the header a foreign page cannot send
            assert (await c.put("/admin/api/settings", json={"redact": False})).status_code == 403
            r = await c.put("/admin/api/settings", json={"redact": False, "public_url": "https://f.example.com/",
                                                         "session_store": "disk"}, headers={"X-Ferry-Admin": "1"})
            assert r.status_code == 200 and r.json()["redact"] is False and r.json()["public_url"] == "https://f.example.com"
            assert cfg.session_store == "disk" and "session_store = \"disk\"" in (tmp_path / "server.toml").read_text()
            # through a tunnel the request also comes from 127.0.0.1 but carries Cloudflare headers
            assert (await c.get("/admin/api/status", headers={"cf-connecting-ip": "1.2.3.4"})).status_code == 403
            # a broken models.toml is refused and the old one kept
            bad = await c.put("/admin/api/models", json={"text": "[models.x]\nnope"}, headers={"X-Ferry-Admin": "1"})
            assert bad.status_code == 400 and list(cfg.models) == ["deepseek"]
            good = (tmp_path / "models.toml").read_text().replace('default = "deepseek"', 'default = "deepseek"\n')
            assert (await c.put("/admin/api/models", json={"text": good}, headers={"X-Ferry-Admin": "1"})).status_code == 200
            t = (await c.get("/admin/api/traffic?minutes=60")).json()
            assert len(t["series"]) == 61 and t["totals"]["chats"] == 0
        async with client(app, host="10.0.0.5") as other:
            other.cookies.set("ferry_admin", key)
            assert (await other.get("/admin/api/status")).status_code == 403     # not this computer

    run(go())
    # settings survive a restart
    cfg2 = load_default()
    assert cfg2.redact is False and cfg2.public_url == "https://f.example.com" and cfg2.session_store == "disk"


def test_providers_keys_prompts_redaction(tmp_path, monkeypatch):
    cfg, app = make(tmp_path, monkeypatch)
    monkeypatch.delenv("DEEPSEEK_API_KEY")
    key = (tmp_path / "admin-key").read_text().strip()
    H = {"X-Ferry-Admin": "1"}

    async def go():
        async with client(app) as c:
            c.cookies.set("ferry_admin", key)
            # an older models.toml entry shows up grouped under its preset
            v = (await c.get("/admin/api/providers")).json()
            assert v["providers"][0]["preset"] == "deepseek" and v["providers"][0]["models"][0]["model"] == "deepseek-flash"
            assert any(p["id"] == "kimi-coding" for p in (await c.get("/admin/api/presets")).json()["presets"])
            # add DeepSeek with a key typed on the page: the key is saved apart, never echoed back
            r = await c.put("/admin/api/providers", headers=H, json={
                "providers": [{"id": "deepseek", "preset": "deepseek", "key": "sk-test-0123456789abcd",
                               "models": [{"model": "deepseek-flash"}, {"model": "deepseek-v4-pro"}]}],
                "routing": {"default": "deepseek-v4-pro", "summary": "deepseek-flash"}})
            assert r.status_code == 200, r.text
            assert "sk-test" not in r.text and r.json()["providers"][0]["key_tail"] == "abcd"
            assert "sk-test-0123456789abcd" in (tmp_path / "secrets.toml").read_text()
            assert "sk-test" not in (tmp_path / "models.toml").read_text()
            assert cfg.default_model == "deepseek-v4-pro" and cfg.models["deepseek-flash"].ready
            assert cfg.models["deepseek-flash"].base_url == "https://api.deepseek.com"
            # saving again without a key keeps the saved one
            r = await c.put("/admin/api/providers", headers=H, json={
                "providers": [{"id": "deepseek", "preset": "deepseek", "models": [{"model": "deepseek-flash"}]}],
                "routing": {}})
            assert r.status_code == 200 and cfg.models["deepseek-flash"].api_key == "sk-test-0123456789abcd"
            # prompts: global, summary and per project
            assert (await c.put("/admin/api/prompts/_global", headers=H, json={"text": "- 用中文回复"})).status_code == 200
            assert (await c.put("/admin/api/prompts/my-app", headers=H, json={"text": "- 这是 Vue 项目"})).status_code == 200
            pr = (await c.get("/admin/api/prompts")).json()
            assert pr["global"].startswith("- 用中文") and any(p["name"] == "my-app" for p in pr["projects"])
            # redaction: structured form, and trying it out
            d = (await c.get("/admin/api/redaction")).json()
            assert {b["name"] for b in d["builtins"] if b["on"]} == {"private-ipv4", "email"}
            d["terms"] = ["Project Titan"]
            for b in d["builtins"]:
                b["on"] = True
            assert (await c.put("/admin/api/redaction", headers=H, json=d)).status_code == 200
            t = (await c.post("/admin/api/redaction/try", headers=H, json={**d, "sample": "Project Titan 在 10.1.2.3，电话 13812345678"})).json()
            assert "Project Titan" not in t["masked"] and "10.1.2.3" not in t["masked"] and "13812345678" not in t["masked"]
            bad = await c.put("/admin/api/redaction", headers=H, json={**d, "custom": [{"name": "x", "regex": "("}]})
            assert bad.status_code == 400

    run(go())


def test_usage_and_cost(tmp_path, monkeypatch):
    import json
    import time

    from ferry_server.usage import cost, normalize

    # both APIs' usage in one shape; cached input is cheaper
    assert normalize({"prompt_tokens": 1000, "completion_tokens": 10, "prompt_tokens_details": {"cached_tokens": 800}}) == \
        {"input": 200, "cache_read": 800, "cache_write": 0, "output": 10}
    a = normalize({"input_tokens": 5, "cache_read_input_tokens": 1_000_000, "cache_creation_input_tokens": 0, "output_tokens": 1000})
    assert cost(a, {"input": 4, "output": 20, "cache_read": 0.2, "cache_write": 5}) == round((5 * 4 + 1e6 * 0.2 + 1000 * 20) / 1e6, 6)
    assert cost(a, {}) is None

    cfg, app = make(tmp_path, monkeypatch)
    key = (tmp_path / "admin-key").read_text().strip()
    log = cfg.data_dir / "audit.jsonl"
    now = time.time()
    rows = [dict(event="chat", ts=now, status=200, project="a", model="claude", tokens={"input": 10, "cache_read": 90, "cache_write": 0, "output": 5}, cost=0.5),
            dict(event="chat", ts=now, status=200, project="b", model="deepseek", tokens={"input": 100, "output": 1}, cost=None),
            dict(event="chat", ts=now, status=500, project="a", model="claude", tokens={}, cost=None)]
    log.write_text("".join(json.dumps(r) + "\n" for r in rows))

    async def go():
        async with client(app) as c:
            c.cookies.set("ferry_admin", key)
            u = (await c.get("/admin/api/usage?days=7")).json()
            assert u["total"]["calls"] == 2 and u["total"]["cost"] == 0.5 and u["total"]["priced"] is False
            assert u["models"][0]["key"] == "claude" and u["models"][0]["cache_read"] == 90
            assert len(u["days"]) == 1

    run(go())


def test_a_browser_landing_on_the_server_is_not_an_error(tmp_path, monkeypatch):
    cfg, app = make(tmp_path, monkeypatch)
    key = (tmp_path / "admin-key").read_text().strip()

    async def go():
        async with client(app) as c:
            assert (await c.get("/favicon.ico")).status_code == 204
            r = await c.get("/")
            assert r.status_code == 200 and "Ferry" in r.text
            assert (await c.get("/v1/ferry/models")).status_code == 401  # the API still needs the token
            c.cookies.set("ferry_admin", key)
            ov = (await c.get("/admin/api/traffic?minutes=60")).json()
            return ov
    ov = run(go())
    assert ov["totals"]["errors"] == 1 and ov["totals"]["requests"] == 1
