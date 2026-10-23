"""SQLite storage: session cache (incremental sync), tool schemas, upload parts, placeholder mappings.

The client is the source of truth for every conversation. Everything here is a cache the server can lose:
on a mismatch the client re-uploads in full.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from pathlib import Path


def sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


class BaseMismatch(Exception):
    def __init__(self, count: int, hash_: str):
        self.count, self.hash = count, hash_


class Store:
    def __init__(self, path: Path, ttl_days: int = 7):
        self.ttl = ttl_days * 86400
        self.lock = threading.Lock()
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.executescript(
            """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS conv (id TEXT PRIMARY KEY, count INTEGER, hash TEXT, touched REAL);
            CREATE TABLE IF NOT EXISTS msg (conv TEXT, idx INTEGER, body TEXT, PRIMARY KEY (conv, idx));
            CREATE TABLE IF NOT EXISTS tools (hash TEXT PRIMARY KEY, body TEXT, touched REAL);
            CREATE TABLE IF NOT EXISTS part (upload TEXT, seq INTEGER, data BLOB, touched REAL,
                                             PRIMARY KEY (upload, seq));
            """
        )
        cols = [r[1] for r in self.db.execute("PRAGMA table_info(mapping)").fetchall()]
        if cols and "owner" not in cols:  # v0.1 table had no owner column; its data is not reusable
            self.db.execute("DROP TABLE mapping")
        self.db.execute("CREATE TABLE IF NOT EXISTS mapping (owner TEXT, placeholder TEXT, original TEXT, kind TEXT, "
                        "PRIMARY KEY (owner, placeholder))")

    # ---------- uploads ----------
    def put_part(self, upload: str, seq: int, data: bytes) -> None:
        with self.lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO part VALUES (?,?,?,?)", (upload, seq, data, time.time()))

    def take_upload(self, upload: str, parts: int) -> bytes:
        with self.lock, self.db:
            rows = self.db.execute("SELECT seq, data FROM part WHERE upload=? ORDER BY seq", (upload,)).fetchall()
            if [r[0] for r in rows] != list(range(parts)):
                raise ValueError(f"upload {upload}: expected {parts} parts, got {len(rows)}")
            self.db.execute("DELETE FROM part WHERE upload=?", (upload,))
        return b"".join(r[1] for r in rows)

    # ---------- sessions ----------
    def state(self, conv: str) -> tuple[int, str]:
        row = self.db.execute("SELECT count, hash FROM conv WHERE id=?", (conv,)).fetchone()
        return (row[0], row[1]) if row else (0, "")

    def commit(self, conv: str, base: int, base_hash: str, append: list[str], tools: str | None) -> tuple[int, str]:
        now = time.time()
        with self.lock, self.db:
            count, h = self.state(conv)
            if base == 0:
                count, h = 0, ""
                self.db.execute("DELETE FROM msg WHERE conv=?", (conv,))
            elif base != count or base_hash != h:
                raise BaseMismatch(count, h)
            for i, s in enumerate(append):
                h = sha(h + s)
                self.db.execute("INSERT OR REPLACE INTO msg VALUES (?,?,?)", (conv, count + i, s))
            count += len(append)
            self.db.execute("INSERT OR REPLACE INTO conv VALUES (?,?,?,?)", (conv, count, h, now))
            if tools is not None:
                self.db.execute("INSERT OR REPLACE INTO tools VALUES (?,?,?)", (sha(tools), tools, now))
            self.db.execute("DELETE FROM msg WHERE conv IN (SELECT id FROM conv WHERE touched < ?)", (now - self.ttl,))
            self.db.execute("DELETE FROM conv WHERE touched < ?", (now - self.ttl,))
            self.db.execute("DELETE FROM part WHERE touched < ?", (now - 3600,))
        return count, h

    def load(self, conv: str, count: int, want_hash: str, tools_hash: str | None) -> tuple[list, list | None]:
        with self.lock:
            have_count, have_hash = self.state(conv)
            rows = self.db.execute(
                "SELECT body FROM msg WHERE conv=? AND idx < ? ORDER BY idx", (conv, count)).fetchall()
            trow = (self.db.execute("SELECT body FROM tools WHERE hash=?", (tools_hash,)).fetchone()
                    if tools_hash else None)
        if have_count != count or have_hash != want_hash or len(rows) != count:
            raise KeyError("session not found on server")
        if tools_hash and not trow:
            raise KeyError("tools not found on server")
        return [json.loads(r[0]) for r in rows], (json.loads(trow[0]) if trow else None)

    def drop_sessions(self) -> None:  # test hook
        with self.lock, self.db:
            self.db.execute("DELETE FROM conv")
            self.db.execute("DELETE FROM msg")

    # ---------- placeholder mappings ----------
    # Mappings are per user: a user can only get back originals that they themselves sent.
    def put_mapping(self, owner: str, placeholder: str, original: str, kind: str) -> None:
        with self.lock, self.db:
            self.db.execute("INSERT OR IGNORE INTO mapping VALUES (?,?,?,?)", (owner, placeholder, original, kind))

    def get_mapping(self, owner: str, placeholder: str) -> str | None:
        row = self.db.execute("SELECT original FROM mapping WHERE owner=? AND placeholder=?",
                              (owner, placeholder)).fetchone()
        return row[0] if row else None
