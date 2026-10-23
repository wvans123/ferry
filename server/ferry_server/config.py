"""Load ferry-server.toml. Secrets (API keys, user tokens) are read from environment variables, never from the file."""
from __future__ import annotations

import os
import secrets
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_RULES = """- Reply in the same language the user writes in.
- Before editing a file, read it first; keep edits minimal.
- Placeholders such as [FERRY-...] (eight capital letters or digits after the dash) stand for confidential values. \
Use them exactly as given; never guess what they hide.
"""

DEFAULT_DICTIONARY = """# Ferry 脱敏词表：命中的内容发给模型前换成 [FERRY-XXXXXXXX]，模型返回时再换回原文。
# 在 terms 里加上你的敏感词（公司名、项目代号、主机名……），改完重启 ferry-server 生效。
terms = []

[[patterns]]
name = "private-ipv4"
regex = '\\b(?:10(?:\\.\\d{1,3}){3}|172\\.(?:1[6-9]|2\\d|3[01])(?:\\.\\d{1,3}){2}|192\\.168(?:\\.\\d{1,3}){2})\\b'

[[patterns]]
name = "email"
regex = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}'
"""


@dataclass
class ModelConfig:
    id: str
    base_url: str
    model: str
    api_key_env: str = ""
    context_window: int = 128000
    max_tokens: int = 8192
    drop_params: list[str] = field(default_factory=list)
    rename_params: dict[str, str] = field(default_factory=dict)
    extra_params: dict = field(default_factory=dict)

    @property
    def api_key(self) -> str:
        return os.environ.get(self.api_key_env, "") if self.api_key_env else ""


@dataclass
class Config:
    host: str = "127.0.0.1"
    port: int = 8787
    max_body_bytes: int = 1_000_000
    data_dir: Path = Path("data")
    rules_dir: Path = Path("rules")
    dictionary: Path | None = None
    secret: str = ""
    session_ttl_days: int = 7
    max_upstream_bytes: int = 0  # 0 = no cap; otherwise old tool outputs are dropped to stay under it
    home: Path | None = None     # set in zero-config mode
    users: dict[str, str] = field(default_factory=dict)  # token -> user name
    models: dict[str, ModelConfig] = field(default_factory=dict)


def load(path: str | os.PathLike) -> Config:
    path = Path(path).resolve()
    raw = tomllib.loads(path.read_text(encoding="utf-8"))
    base = path.parent
    s = raw.get("server", {})

    def rel(p: str | None) -> Path | None:
        return None if not p else (base / p).resolve()

    cfg = Config(
        host=s.get("host", "127.0.0.1"),
        port=int(s.get("port", 8787)),
        max_body_bytes=int(s.get("max_body_bytes", 1_000_000)),
        data_dir=rel(s.get("data_dir", "data")),
        rules_dir=rel(s.get("rules_dir", "rules")),
        dictionary=rel(s.get("dictionary")),
        secret=os.environ.get(s.get("secret_env", "FERRY_SECRET"), ""),
        session_ttl_days=int(s.get("session_ttl_days", 7)),
        max_upstream_bytes=int(s.get("max_upstream_bytes", 0)),
    )
    if len(cfg.secret) < 16:
        raise SystemExit(f"environment variable {s.get('secret_env', 'FERRY_SECRET')} must be set to at least 16 characters")
    for u in raw.get("users", []):
        token = os.environ.get(u["token_env"], "")
        if len(token) < 16:
            raise SystemExit(f"environment variable {u['token_env']} (token for user {u['name']}) "
                             f"must be set to at least 16 characters")
        if token in cfg.users:
            raise SystemExit(f"user {u['name']} has the same token as user {cfg.users[token]}")
        cfg.users[token] = u["name"]
    if not cfg.users:
        raise SystemExit("no [[users]] configured")
    for mid, m in raw.get("models", {}).items():
        cfg.models[mid] = ModelConfig(id=mid, **m)
    if not cfg.models:
        raise SystemExit("no [models.*] configured")
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    return cfg


def server_home() -> Path:
    return Path(os.environ.get("FERRY_SERVER_HOME") or Path.home() / ".ferry-server")


def _persistent_secret(path: Path) -> str:
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    value = secrets.token_urlsafe(32)
    path.write_text(value, encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return value


def load_default() -> Config:
    """Zero-config mode: one local user, DeepSeek via DEEPSEEK_API_KEY, secrets generated on first run.

    Everything lives in ~/.ferry-server (override with FERRY_SERVER_HOME); nothing needs to be edited to start.
    """
    home = server_home()
    (home / "rules").mkdir(parents=True, exist_ok=True)
    rules = home / "rules" / "_global.md"
    if not rules.exists():
        rules.write_text(DEFAULT_RULES, encoding="utf-8")
    dictionary = home / "dictionary.toml"
    if not dictionary.exists():
        dictionary.write_text(DEFAULT_DICTIONARY, encoding="utf-8")
    secret = os.environ.get("FERRY_SECRET") or _persistent_secret(home / "secret")
    token = os.environ.get("FERRY_TOKEN") or _persistent_secret(home / "token")
    model = ModelConfig(
        id="main",
        base_url=os.environ.get("FERRY_UPSTREAM_BASE_URL", "https://api.deepseek.com/v1"),
        model=os.environ.get("FERRY_UPSTREAM_MODEL", "deepseek-chat"),
        api_key_env="DEEPSEEK_API_KEY",
        context_window=128000,
        max_tokens=8192,
        drop_params=["store"],
        rename_params={"max_completion_tokens": "max_tokens"},
    )
    cfg = Config(
        host="127.0.0.1",
        port=int(os.environ.get("FERRY_PORT", 8787)),
        data_dir=home / "data",
        rules_dir=home / "rules",
        dictionary=dictionary,
        secret=secret,
        users={token: "local"},
        models={"main": model},
        max_upstream_bytes=int(os.environ.get("FERRY_MAX_UPSTREAM_BYTES", 900_000)),
        home=home,
    )
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    return cfg
