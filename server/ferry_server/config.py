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
    redact: bool = True  # false: send content to the model as is (the word list is ignored)
    # the server picks the model: clients ask for "auto"; summaries can go to a cheaper model
    default_model: str = ""
    summary_model: str = ""
    expose_models: bool = False  # true: clients may also pick a model by name
    home: Path | None = None     # set in zero-config mode
    models_file: Path | None = None  # zero-config: models.toml, re-read whenever it changes
    models_mtime: float = 0.0
    settings_file: Path | None = None  # zero-config: server.toml, written by the admin page
    public_url: str = ""               # how clients reach this server, e.g. https://ferry.example.com (display only)
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
        redact=bool(s.get("redact", True)),
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


def _toml_value(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, list):
        return "[" + ", ".join(_toml_value(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{ " + ", ".join(f"{k} = {_toml_value(x)}" for k, x in v.items()) + " }"
    return '"' + str(v).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _model_block(m: ModelConfig, commented: bool = False, note: str = "") -> str:
    lines = [f"# {note}"] if note else []
    body = [f"[models.{m.id}]", f"base_url = {_toml_value(m.base_url)}", f"api_key_env = {_toml_value(m.api_key_env)}",
            f"model = {_toml_value(m.model)}", f"context_window = {m.context_window}", f"max_tokens = {m.max_tokens}"]
    if m.drop_params:
        body.append(f"drop_params = {_toml_value(m.drop_params)}")
    if m.rename_params:
        body.append(f"rename_params = {_toml_value(m.rename_params)}")
    lines += [("# " if commented else "") + b for b in body]
    return "\n".join(lines)


def models_template(found: dict[str, ModelConfig]) -> str:
    """The first models.toml: every provider with a key is active, the others are there to uncomment."""
    default = next(iter(found))
    out = ["# Ferry 模型清单。改完保存，下一次请求就生效，不用重启服务端。",
           "# 每个 [models.名字] 是一个模型；客户端里 /model 列出的就是这些名字（expose = true 时）。",
           "# api_key_env 是放 Key 的环境变量名；Key 本身不要写在这个文件里。",
           "# base_url 可以是任何 OpenAI 兼容接口：官方 API、你自己的中转、本机的模型服务都行。",
           "",
           "[routing]",
           f'default = "{default}"   # 客户端用 auto 时由服务端选这个',
           'summary = ""            # 上下文太长要写摘要时用哪个模型（填便宜的省钱），空 = 同 default',
           "expose = true           # true：客户端可以用 /model 自己挑；false：只能用 auto，完全由服务端决定",
           ""]
    for m in found.values():
        out += [_model_block(m), ""]
    by_id = {p[0]: p for p in PROVIDERS}
    for pid, key_env, base, model, ctx, max_out, drop, rename in PROVIDERS:
        if pid in found:
            continue
        m = ModelConfig(id=pid, base_url=base, model=model, api_key_env=key_env, context_window=ctx,
                        max_tokens=max_out, drop_params=list(drop), rename_params=dict(rename))
        out += [_model_block(m, True, f"需要 {key_env}，去掉下面几行开头的 # 即可启用"), ""]
    ds = found.get("deepseek") or ModelConfig(id="deepseek", **{k: v for k, v in zip(
        ("base_url", "model", "context_window", "max_tokens"), (by_id["deepseek"][2], "deepseek-chat", 128_000, 8_192))})
    think = ModelConfig(id="deepseek-think", base_url=ds.base_url, model="deepseek-reasoner", api_key_env="DEEPSEEK_API_KEY",
                        context_window=128_000, max_tokens=32_000, drop_params=["store"],
                        rename_params={"max_completion_tokens": "max_tokens"})
    out += [_model_block(think, True, "DeepSeek 思考模式：难题更好，但更慢；连续调用很多工具的任务如果报错，换回 deepseek"), ""]
    custom = ModelConfig(id="my-relay", base_url="http://127.0.0.1:3000/v1", model="模型名", api_key_env="MY_RELAY_KEY",
                         context_window=128_000, max_tokens=8_192)
    out += [_model_block(custom, True, "自定义：任何 OpenAI 兼容的接口（比如你自己的 API 中转）"), ""]
    return "\n".join(out)


def apply_models_file(cfg: Config, path: Path) -> None:
    """Read models.toml into cfg (models + routing). Raises SystemExit with a readable message if it is wrong."""
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as e:
        raise SystemExit(f"{path}: {e}") from None
    models = {mid: ModelConfig(id=mid, **m) for mid, m in raw.get("models", {}).items()}
    if not models:
        raise SystemExit(f"{path}: no [models.*] left; keep at least one")
    r = raw.get("routing", {})
    trial = Config(models=models, default_model=os.environ.get("FERRY_MODEL") or r.get("default", ""),
                   summary_model=os.environ.get("FERRY_SUMMARY_MODEL") or r.get("summary", ""),
                   expose_models=bool(r.get("expose", False)) or os.environ.get("FERRY_EXPOSE_MODELS", "") in ("1", "true"),
                   session_store=cfg.session_store)
    if trial.default_model not in models:
        trial.default_model = ""
    finish(trial)
    cfg.models, cfg.default_model = trial.models, trial.default_model
    cfg.summary_model, cfg.expose_models = trial.summary_model, trial.expose_models


def refresh_models(cfg: Config) -> str:
    """Re-read models.toml if it changed since last time. Returns an error message, or "" when all is well."""
    f = cfg.models_file
    if not f:
        return ""
    try:
        mtime = f.stat().st_mtime
    except OSError:
        return ""
    if mtime == cfg.models_mtime:
        return ""
    cfg.models_mtime = mtime
    try:
        apply_models_file(cfg, f)
        return ""
    except SystemExit as e:  # keep serving with the previous list
        return str(e)


def load_default() -> Config:
    """Zero-config mode: one local user, secrets generated on first run, models from <home>/models.toml
    (written on the first run with one model per API key found in the environment).

    Everything lives in ~/.ferry-server (override with FERRY_SERVER_HOME, e.g. D:\\ferry\\server).
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
    settings_file = home / "server.toml"
    saved = {}
    if settings_file.exists():
        try:
            saved = tomllib.loads(settings_file.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as e:
            print(f"{settings_file} ignored: {e}", flush=True)
    env = os.environ.get
    models_file = home / "models.toml"
    if not models_file.exists():
        models_file.write_text(models_template(zero_config_models()), encoding="utf-8")
    cfg = Config(
        host="127.0.0.1",
        port=int(os.environ.get("FERRY_PORT", 8787)),
        data_dir=home / "data",
        rules_dir=home / "rules",
        dictionary=dictionary,
        secret=secret,
        users={token: "local"},
        max_upstream_bytes=int(env("FERRY_MAX_UPSTREAM_BYTES") or saved.get("max_upstream_bytes", 900_000)),
        home=home,
        # on this computer the conversation is already in the client's own session files: keep no second copy
        session_store=env("FERRY_SESSION_STORE") or saved.get("session_store", "memory"),
        redact=(env("FERRY_REDACT").lower() not in ("0", "false", "off", "no")) if env("FERRY_REDACT")
        else bool(saved.get("redact", True)),
        models_file=models_file,
        settings_file=settings_file,
        public_url=saved.get("public_url", ""),
    )
    apply_models_file(cfg, models_file)
    cfg.models_mtime = models_file.stat().st_mtime
    finish(cfg)
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    return cfg


def save_settings(cfg: Config) -> None:
    """Write the settings the admin page can change to <home>/server.toml (environment variables still win)."""
    if not cfg.settings_file:
        return
    cfg.settings_file.write_text(
        "# Ferry server settings, written by the admin page. Environment variables with the same meaning win.\n"
        f'public_url = "{cfg.public_url}"\n'
        f'session_store = "{cfg.session_store}"\n'
        f"redact = {'true' if cfg.redact else 'false'}\n"
        f"max_upstream_bytes = {int(cfg.max_upstream_bytes)}\n", encoding="utf-8")
