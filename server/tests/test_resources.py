"""Resource sync acceptance cases through authenticated APIs, including local admin edits."""
import asyncio
import base64
import hashlib
import json
import socket
import subprocess
import threading
import time
import uuid
from pathlib import Path

import httpx
import pytest
import uvicorn
from fastapi import HTTPException

from ferry_server.app import create_app
from ferry_server.config import load_default
from ferry_server.resources import MAX_PART, Resources, resource


def make(tmp_path, monkeypatch):
    monkeypatch.setenv("FERRY_SERVER_HOME", str(tmp_path))
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test")
    cfg = load_default()
    cfg.users = {"token-a": "Alice", "token-b": "Bob", "token-c": "A/lice"}
    return cfg, create_app(cfg)


def bundle(path=".ferry/skills/research", text="hello", file="SKILL.md"):
    name = path + "/" + file if "/skills/" in path else path
    return {"path": path, "files": [{"path": name, "data": base64.b64encode(text.encode()).decode()}]}


def commit_url(project, base=0, op=None):
    return f"/v1/ferry/resources/commit?project={project}&base={base}&operation={op or uuid.uuid4().hex}"


def test_accounts_devices_admin_history_conflicts_and_restore(tmp_path, monkeypatch):
    cfg, app = make(tmp_path, monkeypatch)
    a, b = {"Authorization": "Bearer token-a"}, {"Authorization": "Bearer token-b"}
    # Use the admin endpoint so the live device registry receives the new device.
    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1") as c:
            # Admin access remains local and CSRF protected.
            assert (await c.get("/admin/api/resources")).status_code == 403
            c.cookies.set("ferry_admin", (tmp_path / "admin-key").read_text().strip())
            admin = {"X-Ferry-Admin": "1"}
            dev = await c.post("/admin/api/devices", headers=admin, json={"name": "laptop", "user": "Alice"})
            assert dev.status_code == 200
            device = {"Authorization": "Bearer " + dev.json()["token"]}
            project = (await c.post("/v1/ferry/resources/projects", headers=a, json={"name": "Project"})).json()["id"]
            assert (await c.get(f"/v1/ferry/resources/projects/{project}", headers=b)).status_code == 404
            op = uuid.uuid4().hex
            url = commit_url(project, op=op)
            change = {"put": [bundle()]}
            first = await c.post(url, headers=a, json=change)
            assert first.json() == {"ok": True, "revision": 1}
            assert (await c.post(url, headers=a, json=change)).json() == first.json()
            assert (await c.post(commit_url(project), headers=a, json=change)).status_code == 409
            assert (await c.get("/v1/ferry/resources/projects", headers=device)).json()["projects"][0]["id"] == project
            q = "?path=.ferry%2Fskills%2Fresearch"
            data = (await c.get(f"/v1/ferry/resources/projects/{project}" + q, headers=device)).json()
            assert base64.b64decode(data["resource"]["files"][0]["data"]) == b"hello"
            assert "data" not in data["resources"][0]["files"][0]
            accounts = (await c.get("/admin/api/resources")).json()["accounts"]
            assert next(x for x in accounts if x["user"] == "Alice")["projects"][0]["id"] == project
            admin_url = f"/admin/api/resources/{project}?user=Alice&base=1&operation={uuid.uuid4().hex}"
            assert (await c.post(admin_url, json={"put": [bundle(text="edited")]}, headers=admin)).json()["revision"] == 2
            assert (await c.post(admin_url.replace("base=1", "base=0").replace(admin_url.split("operation=")[1], uuid.uuid4().hex),
                                 json=change, headers=admin)).status_code == 409
            assert (await c.post(f"/admin/api/resources/{project}?user=Alice&base=2&operation={uuid.uuid4().hex}", json=change)).status_code == 403
            old = (await c.get(f"/v1/ferry/resources/projects/{project}" + q + "&revision=1", headers=a)).json()["resource"]
            assert base64.b64decode(old["files"][0]["data"]) == b"hello"
            sha0 = old["files"][0]["sha256"]
            assert (await c.post(f"/v1/ferry/resources/projects/{project}/blobs", headers=b, json={"shas": [sha0]})).status_code == 404
            b_batch = (await c.post(f"/v1/ferry/resources/projects/{project}/blobs", headers=device, json={"shas": [sha0]})).json()
            assert base64.b64decode(b_batch["blobs"][sha0]) == b"hello"
            b_slice = (await c.post(f"/v1/ferry/resources/projects/{project}/blobs", headers=device, json={"sha": sha0, "offset": 1, "limit": 3})).json()
            assert b_slice["total"] == 5 and base64.b64decode(b_slice["data"]) == b"ell"
            assert (await c.post(commit_url(project, 2), headers=device, json={"put": [old]})).json()["revision"] == 3
            assert (await c.post(commit_url(project, 3), headers=a, json={"delete": [old["path"]]})).json()["revision"] == 4
            assert (await c.get(f"/v1/ferry/resources/projects/{project}", headers=a)).json()["resources"] == []
            history = (await c.get(f"/v1/ferry/resources/projects/{project}/history", headers=a)).json()["history"]
            assert [r["rev"] for r in history] == [4, 3, 2, 1]
            assert history[2]["actor"] == "Server admin"
            assert (await c.get(f"/v1/ferry/resources/projects/{project}?revision=999", headers=a)).status_code == 404
    asyncio.run(go())
    log = (cfg.data_dir / "audit.jsonl").read_text()
    assert '"resource_commit"' in log and '"hello"' not in log and '"edited"' not in log


def test_staged_uploads_are_bounded_atomic_owned_and_retryable(tmp_path, monkeypatch):
    _, app = make(tmp_path, monkeypatch)
    a = {"Authorization": "Bearer token-a"}
    b = {"Authorization": "Bearer token-b"}
    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1") as c:
            p = (await c.post("/v1/ferry/resources/projects", headers=a, json={"name": "P"})).json()["id"]
            for bad in [[], {"put": [None]}, {"put": [{}]}, {"put": "invalid"}, {"put": [{"path": "AGENTS.md", "files": [None]}]}]:
                assert (await c.post(commit_url(p), headers=a, json=bad)).status_code == 400
            assert (await c.post("/v1/ferry/resources/projects", headers=a, json=[])).status_code == 400
            body = json.dumps({"put": [bundle(text="a" * (600 * 1024))]}).encode()
            assert (await c.post(commit_url(p), headers=a, content=body)).status_code == 413
            upload = uuid.uuid4().hex
            assert (await c.post(f"/v1/ferry/resources/upload/{upload}/0", headers=a, content=b"x" * (MAX_PART + 1))).status_code == 400
            for seq, start in enumerate(range(0, len(body), MAX_PART)):
                part = body[start:start + MAX_PART]
                assert (await c.post(f"/v1/ferry/resources/upload/{upload}/{seq}", headers=a, content=part)).status_code == 200
            url = commit_url(p) + f"&upload={upload}&parts=2"
            assert (await c.post(url, headers=b)).status_code == 404
            assert (await c.post(url.replace("parts=2", "parts=3"), headers=a)).status_code == 400
            assert (await c.get(f"/v1/ferry/resources/projects/{p}", headers=a)).json()["revision"] == 0
            result = await c.post(url, headers=a)
            assert result.json()["revision"] == 1
            assert (await c.post(url, headers=a)).json() == result.json()
    asyncio.run(go())


@pytest.mark.parametrize("path", ["../AGENTS.md", "/AGENTS.md", "C:/AGENTS.md", ".ferry/skills/CON", ".ferry/skills/a/../b", "foo\\AGENTS.md"])
def test_portable_resource_paths(path):
    with pytest.raises(ValueError):
        resource(bundle(path))


def test_validation_snapshots_dedup_and_concurrent_writers(tmp_path):
    store = Resources(tmp_path)
    p = store.create("user", "project")["id"]
    def save(change, base):
        return store.commit("user", "test", p, base, uuid.uuid4().hex, json.dumps(change).encode())
    skill = bundle()
    assert save({"put": [skill]}, 0)["revision"] == 1
    save({"put": [skill]}, 1)
    with store.db() as c:
        assert c.execute("SELECT count(*) FROM resource_blobs").fetchone()[0] == 1
    bad = bundle(file="../escape")
    with pytest.raises(ValueError): save({"put": [bad]}, 2)
    bad = bundle()
    bad["files"][0]["sha256"] = "wrong"
    with pytest.raises(ValueError): save({"put": [bad]}, 2)
    bad = bundle(file=".env")
    with pytest.raises(ValueError): save({"put": [bad]}, 2)
    duplicate = bundle()
    duplicate["files"].append({**duplicate["files"][0], "path": ".ferry/skills/research/skill.md"})
    with pytest.raises(ValueError): save({"put": [duplicate]}, 2)
    mixed = bundle()
    mixed["files"] += [{"path": ".ferry/skills/research/Refs/a", "data": ""},
                       {"path": ".ferry/skills/research/refs/b", "data": ""}]
    with pytest.raises(ValueError): save({"put": [mixed]}, 2)
    with pytest.raises(ValueError): save({"put": [bundle(".ferry/hooks.json", "[]")]}, 2)
    from concurrent.futures import ThreadPoolExecutor
    def writer(n):
        try: return save({"put": [bundle(text=str(n))]}, 2)["revision"]
        except HTTPException as e: return e.status_code
    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(writer, [1, 2])) == [3, 409]
    assert store.read("user", p)["revision"] == 3
    # Similar account names never share namespaces, and global skill library creation is idempotent and sorted first.
    assert store.projects("u/ser") == []
    g1 = store.create("user", "_global")
    g2 = store.create("user", "全局 Skill 库")
    assert g1 == g2 and g1["name"] == "全局 Skill 库"
    assert store.projects("user")[0]["id"] == g1["id"]
    # Global Skill Library tracks independent per-skill versions and merges non-overlapping skill uploads cleanly.
    gid = g1["id"]
    store.commit("user", "pc1", gid, 0, uuid.uuid4().hex, json.dumps({"put": [bundle(".ferry/skills/a", "v1")]}).encode())
    # pc2 still knows base=0, uploads a different skill 'b': succeeds without a whole-library 409!
    store.commit("user", "pc2", gid, 0, uuid.uuid4().hex, json.dumps({"put": [bundle(".ferry/skills/b", "v1")]}).encode())
    # Updating skill 'a' increments only 'a' to ver=2, leaving 'b' at ver=1.
    store.commit("user", "pc1", gid, 2, uuid.uuid4().hex, json.dumps({"put": [bundle(".ferry/skills/a", "v2")]}).encode())
    res_map = {r["path"]: r for r in store.read("user", gid)["resources"]}
    assert res_map[".ferry/skills/a"]["ver"] == 2
    assert res_map[".ferry/skills/b"]["ver"] == 1
    # Concurrent edit to the SAME skill 'a' from stale base=1 still conflicts with 409.
    with pytest.raises(HTTPException) as exc:
        store.commit("user", "pc2", gid, 1, uuid.uuid4().hex, json.dumps({"put": [bundle(".ferry/skills/a", "stale")]}).encode())
    assert exc.value.status_code == 409
    # Local workspace discovery files (local.md / *.local.json) are rejected from server sync.
    for local_file in ("references/local.md", "local.json", "references/paths.local.json"):
        with pytest.raises(ValueError):
            resource(bundle(".ferry/skills/a", "secret", file=local_file))


def test_real_node_client_upload_admin_edit_pull_and_history(tmp_path, monkeypatch):
    """Use the shipping Node transport against a real isolated HTTP server."""
    cfg, app = make(tmp_path / "server", monkeypatch)
    root = tmp_path / "project"
    skill = root / ".ferry/skills/research"
    (skill / "scripts").mkdir(parents=True)
    (skill / "references").mkdir()
    (skill / "SKILL.md").write_text("---\nname: research\ndescription: Research\n---\n调查流程", encoding="utf-8")
    (skill / "scripts/check.py").write_text("print('original')\n", encoding="utf-8")
    (skill / "references/data.bin").write_bytes(bytes(range(256)) * 1600)
    (skill / "references/\ue000.md").write_text("BMP path", encoding="utf-8")
    (skill / "references/\U00010000.md").write_text("Astral path", encoding="utf-8")
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="error"))
    worker = threading.Thread(target=lambda: server.run(sockets=[sock]), daemon=True)
    worker.start()
    try:
        for _ in range(500):
            if server.started:
                break
            time.sleep(.01)
        assert server.started
        url = f"http://127.0.0.1:{port}"
        source = Path(__file__).resolve().parents[2]
        script = """
import { collectResource, createResourceClient, applyPull } from './client/lib/resources.mjs';
const [server, root, mode, project] = process.argv.slice(2);
const c = createResourceClient({server, token:'token-a', chunkBytes:90000});
const path = '.ferry/skills/research';
if (mode === 'upload') {
  const p = await c.api('projects', {name:'互通项目'});
  const resources = [collectResource(root,path).resource];
  const result = await c.upload(p.id,0,resources);
  console.log(JSON.stringify({...result, project:p.id, hash:resources[0].hash}));
} else if (mode === 'fresh_pull') {
  const head = await c.api(`projects/${project}`);
  const meta = head.resources.find((r) => r.path === path);
  const full = await c.hydrateResource(project, meta, null, head.revision);
  applyPull(root,root+'-fresh',[null],[full],{bases:{[path]:full.hash}});
  console.log(JSON.stringify({hash:collectResource(root,path).resource.hash,revision:head.revision}));
} else {
  const head = await c.api(`projects/${project}`);
  const meta = head.resources.find((r) => r.path === path);
  const before = collectResource(root,path).resource;
  const full = await c.hydrateResource(project, meta, before, head.revision);
  applyPull(root,root+'-state',[before],[full],{bases:{[path]:full.hash}});
  console.log(JSON.stringify({hash:collectResource(root,path).resource.hash,revision:head.revision}));
}
"""
        def node(mode, project=""):
            result = subprocess.run(["node", "--input-type=module", "-", url, str(root), mode, project],
                                    input=script, text=True, capture_output=True, cwd=source, timeout=60)
            assert result.returncode == 0, result.stderr
            return json.loads(result.stdout)
        uploaded = node("upload")
        assert uploaded["revision"] == 1
        p = uploaded["project"]
        with httpx.Client(base_url=url) as client:
            client.cookies.set("ferry_admin", (cfg.data_dir.parent / "admin-key").read_text().strip())
            admin = {"X-Ferry-Admin": "1"}
            q = {"user": "Alice", "path": ".ferry/skills/research"}
            original = client.get(f"/admin/api/resources/{p}", params=q).json()["resource"]
            assert original["hash"] == uploaded["hash"]
            edited = json.loads(json.dumps(original))
            f = next(f for f in edited["files"] if f["path"].endswith("check.py"))
            f["data"] = base64.b64encode(b"print('edited')\n").decode()
            f.pop("sha256")
            params = {"user": "Alice", "base": 1, "operation": uuid.uuid4().hex}
            assert client.post(f"/admin/api/resources/{p}", params=params, headers=admin,
                               json={"put": [edited]}).json()["revision"] == 2
            current = client.get(f"/admin/api/resources/{p}", params=q).json()["resource"]
            params["operation"] = uuid.uuid4().hex
            assert client.post(f"/admin/api/resources/{p}", params=params, headers=admin,
                               json={"put": [original]}).status_code == 409
            old = client.get(f"/admin/api/resources/{p}", params={**q, "revision": 1}).json()["resource"]
            assert old["hash"] == original["hash"]
        pulled = node("pull", p)
        assert pulled == {"hash": current["hash"], "revision": 2}
        assert (skill / "scripts/check.py").read_bytes() == b"print('edited')\n"
        assert (skill / "references/data.bin").read_bytes() == bytes(range(256)) * 1600
        # Fresh pull with no local cache slices 409 KB data.bin into bounded <60 KB /blobs requests.
        (skill / "references/data.bin").unlink()
        fresh = node("fresh_pull", p)
        assert fresh == {"hash": current["hash"], "revision": 2}
        assert (skill / "references/data.bin").read_bytes() == bytes(range(256)) * 1600
        rows = [json.loads(line) for line in (cfg.data_dir / "access.jsonl").read_text().splitlines()]
        uploads = [r["bytes"] for r in rows if r.get("path", "").startswith("/v1/ferry/resources/")]
        assert max(uploads) == 90000
        assert len([n for n in uploads if n == 90000]) >= 6
    finally:
        server.should_exit = True
        worker.join(timeout=10)
        sock.close()
