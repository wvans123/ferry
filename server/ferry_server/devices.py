"""Devices: one token per computer that logs in, so a lost or retired computer can be locked out alone.

The tokens from the configuration (zero-config: the `token` file; ferry-server.toml: [[users]]) keep working and
show up as the "main token". Added devices live in <home>/devices.json with only a hash of their token: the token
itself is shown once, when the device is added. Each device belongs to a user; with one user (zero-config) that is
"local", so every device shares that user's conversations, memory and limits.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

PREFIX = "fd_"  # device tokens start with this, so they are easy to tell from the main token
MAIN = "main"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@dataclass
class Device:
    id: str
    name: str
    user: str
    hash: str
    created: float = field(default_factory=time.time)
    last_seen: float = 0.0
    last_ip: str = ""


class Devices:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self.items: dict[str, Device] = {}
        self.main_seen: dict[str, tuple[float, str]] = {}  # user -> (last seen, ip) for the main token(s)
        self._saved = 0.0
        self._dirty = False
        if path.exists():
            try:
                for d in json.loads(path.read_text(encoding="utf-8")).get("devices", []):
                    dev = Device(**{k: d[k] for k in Device.__dataclass_fields__ if k in d})
                    self.items[dev.id] = dev
            except (ValueError, TypeError, KeyError) as e:
                raise SystemExit(f"{path} cannot be read ({e}); fix or remove it") from e

    def _write(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"devices": [asdict(d) for d in self.items.values()]}, ensure_ascii=False, indent=1),
                       encoding="utf-8")
        try:
            tmp.chmod(0o600)
        except OSError:
            pass
        tmp.replace(self.path)
        self._saved = time.time()
        self._dirty = False

    def add(self, name: str, user: str) -> tuple[Device, str]:
        name = " ".join(str(name or "").split())[:40] or "新设备"
        token = PREFIX + secrets.token_urlsafe(32)
        with self.lock:
            dev_id = secrets.token_hex(4)
            while dev_id in self.items or dev_id == MAIN:
                dev_id = secrets.token_hex(4)
            dev = Device(id=dev_id, name=name, user=user, hash=_hash(token))
            self.items[dev.id] = dev
            self._write()
        return dev, token

    def remove(self, dev_id: str) -> bool:
        with self.lock:
            if self.items.pop(dev_id, None) is None:
                return False
            self._write()
            return True

    def find(self, token: str) -> Device | None:
        """The device this token belongs to. Every stored hash is compared, in constant time."""
        if not token.startswith(PREFIX):
            return None
        given = _hash(token)
        found = None
        for d in list(self.items.values()):
            if hmac.compare_digest(given, d.hash):
                found = d
        return found

    def touch(self, dev: Device | None, user: str, ip: str) -> None:
        """Remember when a device was last seen; written to disk at most once a minute."""
        now = time.time()
        if dev is None:
            self.main_seen[user] = (now, ip)
            return
        dev.last_seen, dev.last_ip = now, ip
        self._dirty = True
        if now - self._saved > 60:
            with self.lock:
                if self._dirty:
                    self._write()

    def flush(self) -> None:
        with self.lock:
            if self._dirty:
                self._write()

    def listing(self, users: list[str]) -> list[dict]:
        rows = []
        for u in users:
            seen, ip = self.main_seen.get(u, (0.0, ""))
            rows.append({"id": MAIN, "name": "主令牌", "user": u, "main": True, "created": 0, "last_seen": seen, "last_ip": ip})
        for d in sorted(self.items.values(), key=lambda d: d.created):
            rows.append({"id": d.id, "name": d.name, "user": d.user, "main": False, "created": d.created,
                         "last_seen": d.last_seen, "last_ip": d.last_ip})
        return rows
