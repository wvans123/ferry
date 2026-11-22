"""Account-owned project resources, immutable revisions and bounded staged uploads."""
from __future__ import annotations

import base64
import hashlib
import json
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

MAX_PART = 512 * 1024
MAX_BUNDLE = 32 * 1024 * 1024
MAX_FILE = 4 * 1024 * 1024
MAX_FILES = 512
ID = re.compile(r"^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$")
RESERVED = re.compile(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)", re.I)
EXCLUDED = {".git", "node_modules", "__pycache__", ".ds_store", ".env", "credentials.json", "secrets.json",
            ".ssh", ".aws", ".npmrc", ".netrc", "id_rsa", "id_ed25519"}


def safe_path(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 240:
        raise ValueError("invalid resource path")
    parts = value.split("/")
    if any(p in ("", ".", "..") or p.endswith((" ", ".")) or RESERVED.match(p)
           or any(ord(c) < 32 or c in '\\:*?"<>|' for c in p) for p in parts):
        raise ValueError("resource paths must be portable relative paths")
    if any(p.lower() in EXCLUDED or p.lower().startswith(".env.") or p.lower().endswith((".pem", ".key")) for p in parts):
        raise ValueError("excluded credential or generated file")
    return value


def kind_of(path: str) -> str:
    safe_path(path)
    if re.fullmatch(r"\.(ferry|claude)/skills/[^/]+", path):
        return "skill"
    if re.fullmatch(r"\.(ferry|claude)/agents/[^/]+\.md", path):
        return "agent"
    if path == ".ferry/hooks.json":
        return "hooks"
    if path.split("/")[-1] in ("AGENTS.md", "CLAUDE.md"):
        return "rule"
    raise ValueError("choose a project skill, agent, AGENTS.md, CLAUDE.md or .ferry/hooks.json")


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def resource(value: dict) -> dict:
    path = safe_path(value["path"])
    kind = kind_of(path)
    files = value["files"]
    if not isinstance(files, list) or not files or len(files) > MAX_FILES:
        raise ValueError("a resource needs 1–512 files")
    clean = []
    names = set()
    for f in files:
        name = safe_path(f["path"])
        if (kind == "skill" and not name.startswith(path + "/")) or (kind != "skill" and name != path):
            raise ValueError("file is outside the selected resource")
        if name.casefold() in names:
            raise ValueError("duplicate or case-conflicting file path")
        names.add(name.casefold())
        data = base64.b64decode(f["data"], validate=True)
        if len(data) > MAX_FILE:
            raise ValueError("each file must be at most 4 MiB")
        sha = hashlib.sha256(data).hexdigest()
        if f.get("sha256", sha) != sha:
            raise ValueError("file checksum mismatch")
        clean.append({"path": name, "data": base64.b64encode(data).decode(), "sha256": sha,
                      "executable": bool(f.get("executable", False)), "bytes": len(data)})
    if kind == "skill" and path + "/SKILL.md" not in {f["path"] for f in clean}:
        raise ValueError("a skill needs SKILL.md")
    if kind == "hooks":
        hooks = json.loads(base64.b64decode(clean[0]["data"]).decode("utf-8"))
        if not isinstance(hooks, dict) or any(k not in ("afterEdit", "onDone") for k in hooks):
            raise ValueError("hooks must contain afterEdit/onDone arrays")
        if any(not isinstance(v, list) or any(not isinstance(h, dict) or not isinstance(h.get("run"), str) for h in v)
               for v in hooks.values()):
            raise ValueError("invalid hook command")
    clean.sort(key=lambda f: f["path"])
    meta = [{k: f[k] for k in ("path", "sha256", "executable")} for f in clean]
    return {"path": path, "kind": kind, "files": clean, "hash": digest(meta)}


def index(snapshot: dict) -> list[dict]:
    return [{**r, "files": [{k: v for k, v in f.items() if k != "data"} for f in r["files"]]}
            for r in snapshot.values()]


class Resources:
    def __init__(self, data_dir: Path):
        self.path = data_dir / "resources.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.db() as c:
            c.executescript("""
                CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS revisions(project TEXT, rev INTEGER, at REAL, actor TEXT, snapshot TEXT,
                    PRIMARY KEY(project, rev));
                CREATE TABLE IF NOT EXISTS parts(owner TEXT, upload TEXT, seq INTEGER, data BLOB, at REAL,
                    PRIMARY KEY(owner, upload, seq));
                CREATE TABLE IF NOT EXISTS operations(owner TEXT, op TEXT, project TEXT, rev INTEGER,
                    PRIMARY KEY(owner, op));
                CREATE TABLE IF NOT EXISTS resource_blobs(owner TEXT, sha TEXT, data BLOB,
                    PRIMARY KEY(owner, sha));
            """)
        try:
            self.path.chmod(0o600)
        except OSError:
            pass

    @contextmanager
    def db(self):
        c = sqlite3.connect(self.path, timeout=30)
        c.row_factory = sqlite3.Row
        try:
            with c:
                yield c
        finally:
            c.close()

    def owned(self, c, owner, project):
        row = c.execute("SELECT * FROM projects WHERE id=? AND owner=?", (project, owner)).fetchone()
        if row is None:
            raise HTTPException(404, "project not found for this account")
        return dict(row)

    def projects(self, owner):
        with self.db() as c:
            return [dict(r) for r in c.execute("SELECT id,name FROM projects WHERE owner=? ORDER BY name,id", (owner,))]

    def create(self, owner, name):
        name = str(name).strip()
        if not name or len(name) > 120:
            raise ValueError("project name must be 1–120 characters")
        project = uuid.uuid4().hex
        with self.db() as c:
            c.execute("INSERT INTO projects VALUES(?,?,?)", (project, owner, name))
        return {"id": project, "name": name}

    def read(self, owner, project, revision=None, path=None):
        with self.db() as c:
            p = self.owned(c, owner, project)
            if revision is None:
                row = c.execute("SELECT * FROM revisions WHERE project=? ORDER BY rev DESC LIMIT 1", (project,)).fetchone()
            else:
                row = c.execute("SELECT * FROM revisions WHERE project=? AND rev=?", (project, revision)).fetchone()
                if revision != 0 and row is None:
                    raise HTTPException(404, "revision not found")
            snapshot = json.loads(row["snapshot"]) if row else {}
            result = {"id": project, "name": p["name"], "revision": row["rev"] if row else 0,
                      "resources": index(snapshot)}
            if path is not None:
                selected = snapshot.get(path)
                if selected:
                    for f in selected["files"]:
                        data = c.execute("SELECT data FROM resource_blobs WHERE owner=? AND sha=?",
                                         (owner, f["sha256"])).fetchone()[0]
                        f["data"] = base64.b64encode(data).decode()
                result["resource"] = selected
            return result

    def history(self, owner, project):
        with self.db() as c:
            self.owned(c, owner, project)
            return [dict(r) for r in c.execute("SELECT rev,at,actor FROM revisions WHERE project=? ORDER BY rev DESC", (project,))]

    def part(self, owner, upload, seq, data):
        if not ID.fullmatch(upload) or not 0 <= seq < 8192 or not 0 < len(data) <= MAX_PART:
            raise ValueError("invalid upload part (maximum 512 KiB)")
        with self.db() as c:
            c.execute("BEGIN IMMEDIATE")
            c.execute("DELETE FROM parts WHERE at<?", (time.time() - 86400,))
            total = c.execute("SELECT COALESCE(SUM(length(data)),0) FROM parts WHERE owner=? AND NOT(upload=? AND seq=?)",
                              (owner, upload, seq)).fetchone()[0]
            if total + len(data) > MAX_BUNDLE * 2:
                raise ValueError("staged uploads exceed this account's 64 MiB limit")
            c.execute("INSERT OR REPLACE INTO parts VALUES(?,?,?,?,?)", (owner, upload, seq, data, time.time()))

    def commit(self, owner, actor, project, base, operation, body, upload=None, parts=0):
        if not ID.fullmatch(operation) or (upload and not ID.fullmatch(upload)):
            raise ValueError("invalid operation id")
        with self.db() as c:
            c.execute("BEGIN IMMEDIATE")
            self.owned(c, owner, project)
            done = c.execute("SELECT project,rev FROM operations WHERE owner=? AND op=?", (owner, operation)).fetchone()
            if done:
                if done["project"] != project:
                    raise ValueError("operation belongs to a different project")
                return {"ok": True, "revision": done["rev"]}
            if upload:
                if body or not 1 <= parts <= 8192:
                    raise ValueError("invalid multipart commit")
                rows = c.execute("SELECT seq,data FROM parts WHERE owner=? AND upload=? AND seq<? ORDER BY seq",
                                 (owner, upload, parts)).fetchall()
                if len(rows) != parts or [r["seq"] for r in rows] != list(range(parts)):
                    raise ValueError("upload is incomplete")
                body = b"".join(r["data"] for r in rows)
            if len(body) > MAX_BUNDLE:
                raise ValueError("resource bundle exceeds 32 MiB")
            change = json.loads(body)
            if not isinstance(change, dict) or not isinstance(change.get("put", []), list) or not isinstance(change.get("delete", []), list):
                raise ValueError("expected put and delete arrays")
            puts = [resource(r) for r in change.get("put", [])]
            deletes = [safe_path(p) for p in change.get("delete", [])]
            if not puts and not deletes:
                raise ValueError("choose at least one resource")
            paths = [r["path"] for r in puts] + deletes
            if len(set(p.casefold() for p in paths)) != len(paths):
                raise ValueError("duplicate resource path")
            row = c.execute("SELECT rev,snapshot FROM revisions WHERE project=? ORDER BY rev DESC LIMIT 1", (project,)).fetchone()
            rev = row["rev"] if row else 0
            if base != rev:
                raise HTTPException(409, "Server changed. Fetch the latest revision and review the differences before retrying.")
            snapshot = json.loads(row["snapshot"]) if row else {}
            for path in deletes:
                snapshot.pop(path, None)
            for r in puts:
                for f in r["files"]:
                    c.execute("INSERT OR IGNORE INTO resource_blobs VALUES(?,?,?)",
                              (owner, f["sha256"], base64.b64decode(f.pop("data"))))
                snapshot[r["path"]] = r
            all_paths = [f["path"].casefold() for r in snapshot.values() for f in r["files"]]
            if len(all_paths) > MAX_FILES or len(set(all_paths)) != len(all_paths):
                raise ValueError("project exceeds 512 files or has overlapping resources")
            # A file cannot also be a directory, even on a different operating system.
            names = set(all_paths)
            if any("/".join(p.split("/")[:i]) in names for p in all_paths for i in range(1, len(p.split("/")))):
                raise ValueError("file/directory path conflict")
            spelling = {}
            for r in snapshot.values():
                for f in r["files"]:
                    components = f["path"].split("/")
                    for i in range(1, len(components) + 1):
                        prefix = "/".join(components[:i])
                        previous = spelling.setdefault(prefix.casefold(), prefix)
                        if previous != prefix:
                            raise ValueError("case-conflicting directory or file path")
            text = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
            encoded_bytes = sum(4 * ((f["bytes"] + 2) // 3) for r in snapshot.values() for f in r["files"])
            if len(text.encode()) + encoded_bytes > MAX_BUNDLE:
                raise ValueError("project exceeds 32 MiB")
            c.execute("INSERT INTO revisions VALUES(?,?,?,?,?)", (project, rev + 1, time.time(), actor, text))
            c.execute("INSERT INTO operations VALUES(?,?,?,?)", (owner, operation, project, rev + 1))
            if upload:
                c.execute("DELETE FROM parts WHERE owner=? AND upload=?", (owner, upload))
            return {"ok": True, "revision": rev + 1}


def mount_resources(app, cfg, audit_log, write):
    store = Resources(cfg.data_dir)
    app.state.resources = store

    @app.exception_handler(ResourceError)
    async def bad_resource(request, exc):
        return JSONResponse({"error": {"message": str(exc)}}, status_code=400)

    def checked(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except (ValueError, KeyError, TypeError, UnicodeError, AttributeError) as e:
            raise ResourceError(str(e)) from e

    @app.get("/v1/ferry/resources/projects")
    async def projects(request: Request):
        return {"projects": store.projects(request.state.user)}

    @app.post("/v1/ferry/resources/projects")
    async def create(request: Request):
        b = checked(json.loads, await request.body())
        if not isinstance(b, dict):
            raise ResourceError("expected a project name object")
        return checked(store.create, request.state.user, b.get("name", ""))

    @app.get("/v1/ferry/resources/projects/{project}")
    async def read(project: str, request: Request, revision: int | None = None, path: str | None = None):
        return store.read(request.state.user, project, revision, path)

    @app.get("/v1/ferry/resources/projects/{project}/history")
    async def history(project: str, request: Request):
        return {"history": store.history(request.state.user, project)}

    @app.post("/v1/ferry/resources/upload/{upload}/{seq}")
    async def part(upload: str, seq: int, request: Request):
        checked(store.part, request.state.user, upload, seq, await request.body())
        return {"ok": True}

    @app.post("/v1/ferry/resources/commit")
    async def commit(request: Request, project: str, base: int, operation: str, upload: str | None = None, parts: int = 0):
        body = await request.body()
        if len(body) > MAX_PART:
            raise HTTPException(413, "split resource uploads into parts of at most 512 KiB")
        result = checked(store.commit, request.state.user, request.state.device_name, project, base, operation,
                         body, upload, parts)
        write(audit_log, event="resource_commit", user=request.state.user, device=request.state.device_name,
              project=project, revision=result["revision"])
        return result


class ResourceError(Exception):
    pass
