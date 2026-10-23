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
    # where conversations live on the server: "disk" (SQLite file, kept session_ttl_days), "memory" (RAM only,
    # gone on restart) or "none" (forgotten after every model call; the client uploads the full context each turn)
    session_store: str = "disk"
    # the server picks the model: clients ask for "auto"; summaries can go to a cheaper model
    default_model: str = ""
    summary_model: str = ""
    expose_models: bool = False  # true: clients may also pick a model by name
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
        session_store=s.get("session_store", "disk"),
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
    r = raw.get("routing", {})
    cfg.default_model, cfg.summary_model = r.get("default", ""), r.get("summary", "")
    cfg.expose_models = bool(r.get("expose", False))
    finish(cfg)
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    return cfg


def finish(cfg: Config) -> None:
    """Check the routing and storage settings and fill in defaults."""
    if cfg.session_store not in ("disk", "memory", "none"):
        raise SystemExit(f'session_store must be "disk", "memory" or "none", not {cfg.session_store!r}')
    cfg.default_model = cfg.default_model or next(iter(cfg.models))
    for what, mid in (("default", cfg.default_model), ("summary", cfg.summary_model)):
        if mid and mid not in cfg.models:
            raise SystemExit(f"routing {what} = {mid!r} is not one of the models: {', '.join(cfg.models)}")
    if "auto" in cfg.models:
        raise SystemExit('"auto" is reserved for the model the server picks; rename [models.auto]')


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


# Zero-config models: one per API key found in the environment, all through OpenAI-compatible endpoints.
# (id, key variable, default base URL, default model, context window, max output, params to drop, params to rename)
# Context windows are kept at 200K tokens for Claude and OpenAI even where the model takes more: the agent then
# summarises old history before a request reaches the ~1 MB size limit, and every turn costs less.
PROVIDERS = [
    ("claude", "ANTHROPIC_API_KEY", "https://api.anthropic.com/v1", "claude-sonnet-5-5", 200_000, 32_000,
     ["store", "temperature", "top_p"], {}),
    ("openai", "OPENAI_API_KEY", "https://api.openai.com/v1", "gpt-6.1-sol", 200_000, 32_000, [], {}),
    ("deepseek", "DEEPSEEK_API_KEY", "https://api.deepseek.com/v1", "deepseek-chat", 128_000, 8_192,
     ["store"], {"max_completion_tokens": "max_tokens"}),
]
KEY_VARS = ", ".join(p[1] for p in PROVIDERS)


def zero_config_models() -> dict[str, ModelConfig]:
    """FERRY_<ID>_MODEL / FERRY_<ID>_BASE_URL override a provider's defaults (e.g. FERRY_CLAUDE_MODEL=claude-opus-5-5);
    FERRY_MODEL picks the default model (the first one listed). With no key at all, DeepSeek is listed as not ready."""
    found = {}
    for pid, key_env, base, model, ctx, max_out, drop, rename in PROVIDERS:
        if not os.environ.get(key_env) and pid != "deepseek":
            continue
        up = pid.upper()
        legacy_base = os.environ.get("FERRY_UPSTREAM_BASE_URL") if pid == "deepseek" else None
        legacy_model = os.environ.get("FERRY_UPSTREAM_MODEL") if pid == "deepseek" else None
        found[pid] = ModelConfig(
            id=pid,
            base_url=os.environ.get(f"FERRY_{up}_BASE_URL") or legacy_base or base,
            model=os.environ.get(f"FERRY_{up}_MODEL") or legacy_model or model,
            api_key_env=key_env,
            context_window=int(os.environ.get("FERRY_CONTEXT_WINDOW") or ctx),
            max_tokens=max_out,
            drop_params=list(drop),
            rename_params=dict(rename),
        )
    if len(found) > 1 and not os.environ.get("DEEPSEEK_API_KEY"):
        found.pop("deepseek")  # only shown as a hint when nothing else is configured
    first = os.environ.get("FERRY_MODEL")
    if first in found:
        found = {first: found[first], **{k: v for k, v in found.items() if k != first}}
    return found


def load_default() -> Config:
    """Zero-config mode: one local user, one model per API key in the environment, secrets generated on first run.

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
    models = zero_config_models()
    cfg = Config(
        host="127.0.0.1",
        port=int(os.environ.get("FERRY_PORT", 8787)),
        data_dir=home / "data",
        rules_dir=home / "rules",
        dictionary=dictionary,
        secret=secret,
        users={token: "local"},
        models=models,
        max_upstream_bytes=int(os.environ.get("FERRY_MAX_UPSTREAM_BYTES", 900_000)),
        home=home,
        # on this computer the conversation is already in the client's own session files: keep no second copy
        session_store=os.environ.get("FERRY_SESSION_STORE", "memory"),
        summary_model=os.environ.get("FERRY_SUMMARY_MODEL", "") if os.environ.get("FERRY_SUMMARY_MODEL") in models else "",
        expose_models=os.environ.get("FERRY_EXPOSE_MODELS", "") in ("1", "true", "yes"),
    )
    finish(cfg)
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    return cfg
