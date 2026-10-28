"""Load ferry-server.toml. Secrets (API keys, user tokens) are read from environment variables, never from the file."""
from __future__ import annotations

import json
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
    provider: str = ""                                  # [providers.<id>] this model belongs to, if any
    name: str = ""                                      # display name (admin page only)
    no_key: bool = False                                # e.g. a local Ollama
    key_value: str = field(default="", repr=False)      # key entered on the admin page (secrets.toml)
    api: str = "openai"                                 # "openai" (chat completions) or "anthropic" (Messages API)
    vision: bool = False                                # takes images (the agent can read picture files)
    # USD per million tokens: input, output, cache_read, cache_write. Used for the cost in /cost and the usage page.
    price: dict = field(default_factory=dict)

    @property
    def api_key(self) -> str:
        """The environment variable wins; otherwise the key saved from the admin page."""
        return (os.environ.get(self.api_key_env, "") if self.api_key_env else "") or self.key_value

    @property
    def ready(self) -> bool:
        return bool(self.api_key) or self.no_key or (not self.provider and not self.api_key_env)


@dataclass
class Provider:
    """One account at one service: an address and a key, shared by its models."""
    id: str
    base_url: str
    name: str = ""
    preset: str = ""
    api_key_env: str = ""
    drop_params: list[str] = field(default_factory=list)
    rename_params: dict[str, str] = field(default_factory=dict)
    no_key: bool = False
    key: str = field(default="", repr=False)
    api: str = "openai"

    @property
    def api_key(self) -> str:
        return (os.environ.get(self.api_key_env, "") if self.api_key_env else "") or self.key


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
    max_concurrent: int = 6      # model calls one user may have running at once; more wait their turn
    bark_url: str = ""           # Bark push address (https://api.day.app/<key>): notifications to an iPhone
    judge_model: str = ""        # model that judges uncertain actions in the client's auto mode ("" = the summary/default model)
    # where conversations live on the server: "disk" (SQLite file, kept session_ttl_days), "memory" (RAM only,
    # gone on restart) or "none" (forgotten after every model call; the client uploads the full context each turn)
    session_store: str = "disk"
    redact: bool = False  # true: replace words from the list and built-in patterns with placeholders before the model
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
    providers: dict[str, Provider] = field(default_factory=dict)
    record_details: bool = False  # keep the last requests' prompts in memory for the admin page
    # web access for the work computer's agent (web_fetch / web_search run here); off unless switched on
    web_enabled: bool = False
    web_allow: list[str] = field(default_factory=list)  # empty: every site; else these sites and their subdomains
    web_engine: str = "bing"  # bing (reachable from mainland China) or duckduckgo
    web_proxy: str = ""       # e.g. http://127.0.0.1:7890 when this computer reaches the internet through a proxy


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
        redact=bool(s.get("redact", False)),
        web_enabled=(os.environ["FERRY_WEB"].lower() in ("1", "true", "on", "yes")) if os.environ.get("FERRY_WEB")
        else bool(s.get("web", False)),
        web_allow=list(s.get("web_allow", [])),
        web_engine=s.get("web_engine", "bing"),
        web_proxy=s.get("web_proxy", ""),
        max_concurrent=int(s.get("max_concurrent", 6)),
        bark_url=os.environ.get("FERRY_BARK_URL") or s.get("bark_url", ""),
        judge_model=s.get("judge_model", ""),
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
# Context windows: what the model takes (GPT-6.1 Sol takes more, but input above 272K tokens costs twice as much).
# The admin page and the client's /context change them.
PROVIDERS = [
    ("claude", "ANTHROPIC_API_KEY", "https://api.anthropic.com", "claude-opus-5-5", 1_000_000, 64_000,
     ["temperature", "top_p"], {}),
    ("openai", "OPENAI_API_KEY", "https://api.openai.com/v1", "gpt-6.1-sol", 400_000, 64_000, [], {}),
    ("deepseek", "DEEPSEEK_API_KEY", "https://api.deepseek.com", "deepseek-flash", 1_000_000, 32_000,
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
            api="anthropic" if pid == "claude" else "openai",
        )
        from .presets import model_extras
        extras = model_extras(found[pid].model)
        found[pid].vision = bool(extras.get("vision"))
        found[pid].price = extras.get("price", {})
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
    if m.api != "openai":
        body.append(f"api = {_toml_value(m.api)}")
    if m.vision:
        body.append("vision = true")
    if m.price:
        body.append(f"price = {_toml_value(m.price)}")
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


def secrets_path(cfg: Config) -> Path | None:
    return (cfg.home / "secrets.toml") if cfg.home else None


def load_secrets(cfg: Config) -> dict[str, str]:
    f = secrets_path(cfg)
    if not f or not f.exists():
        return {}
    try:
        return {k: str(v) for k, v in tomllib.loads(f.read_text(encoding="utf-8")).get("providers", {}).items()}
    except tomllib.TOMLDecodeError:
        return {}


def save_secrets(cfg: Config, keys: dict[str, str]) -> None:
    f = secrets_path(cfg)
    if not f:
        return
    lines = ["# API keys entered on the Ferry admin page. Keep this file private.", "[providers]"]
    lines += [f"{_toml_value(k)} = {_toml_value(v)}" for k, v in sorted(keys.items()) if v]
    f.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        f.chmod(0o600)
    except OSError:
        pass


def parse_models(raw: dict, secrets_: dict[str, str]) -> tuple[dict[str, Provider], dict[str, ModelConfig]]:
    """[providers.*] and [models.*] from models.toml. A model either names a provider or has its own base_url."""
    from .presets import BY_ID
    providers: dict[str, Provider] = {}
    for pid, p in raw.get("providers", {}).items():
        pre = BY_ID.get(p.get("preset", ""), {})
        base = p.get("base_url") or pre.get("base_url", "")
        if not base:
            raise SystemExit(f"provider {pid}: base_url is empty")
        providers[pid] = Provider(
            id=pid, base_url=base, name=p.get("name") or pre.get("name") or pid, preset=p.get("preset", ""),
            api_key_env=p.get("api_key_env", ""), drop_params=list(p.get("drop_params", pre.get("drop_params", []))),
            rename_params=dict(p.get("rename_params", pre.get("rename_params", {}))),
            no_key=bool(p.get("no_key", pre.get("no_key", False))), key=secrets_.get(pid, ""),
            api=p.get("api") or pre.get("api", "openai"))
    models: dict[str, ModelConfig] = {}
    for mid, m in raw.get("models", {}).items():
        m = dict(m)
        pid = m.pop("provider", "")
        if pid:
            prov = providers.get(pid)
            if not prov:
                raise SystemExit(f"model {mid}: provider {pid!r} is not defined")
            m.setdefault("base_url", prov.base_url)
            m.setdefault("api_key_env", prov.api_key_env)
            m.setdefault("drop_params", prov.drop_params)
            m.setdefault("rename_params", prov.rename_params)
            m.setdefault("no_key", prov.no_key)
            m.setdefault("api", prov.api)
            m["key_value"] = prov.key
        try:
            models[mid] = ModelConfig(id=mid, provider=pid, **m)
        except TypeError as e:
            raise SystemExit(f"model {mid}: {e}") from None
        _upgrade_old_sizes(models[mid])
        _fill_price(models[mid])
    return providers, models


def _fill_price(m: ModelConfig) -> None:
    """No price saved (e.g. a relay that spells the name its own way): use the official one, if a preset knows it.
    Change it on the admin page when your provider charges differently."""
    if not m.price:
        from .presets import model_extras
        m.price = dict(model_extras(m.model).get("price", {}))


def _upgrade_old_sizes(m: ModelConfig) -> None:
    """Ferry up to 0.13 wrote DeepSeek Flash with 128K context and 8K output; the model takes 1M and much longer
    answers. Only the exact old defaults are raised, so a size someone chose on purpose stays."""
    if m.model in ("deepseek-flash", "deepseek-v4-flash") and "api.deepseek.com" in m.base_url:
        if m.context_window == 128_000:
            m.context_window = 1_000_000
        if m.max_tokens == 8_192:
            m.max_tokens = 32_000


def apply_models_file(cfg: Config, path: Path) -> None:
    """Read models.toml into cfg (providers, models, routing). Raises SystemExit with a readable message if it is wrong."""
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as e:
        raise SystemExit(f"{path}: {e}") from None
    providers, models = parse_models(raw, load_secrets(cfg))
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
    cfg.models, cfg.providers, cfg.default_model = trial.models, providers, trial.default_model
    cfg.summary_model, cfg.expose_models = trial.summary_model, trial.expose_models


def render_models_toml(providers: list[dict], models: list[dict], routing: dict) -> str:
    """models.toml from the admin page's form (keys are never written here)."""
    out = ["# Ferry 模型清单，由管理页生成。也可以手动改，保存后下一次请求生效。",
           "# 服务商的 Key 保存在同一文件夹的 secrets.toml 里（或环境变量 api_key_env）。", "", "[routing]"]
    out.append(f"default = {_toml_value(routing.get('default', ''))}")
    out.append(f"summary = {_toml_value(routing.get('summary', ''))}")
    out.append(f"expose = {_toml_value(bool(routing.get('expose', True)))}")
    for p in providers:
        out += ["", f"[providers.{_toml_key(p['id'])}]"]
        for k in ("name", "preset", "api", "base_url", "api_key_env", "drop_params", "rename_params", "no_key"):
            if p.get(k) not in (None, "", [], {}, False):
                out.append(f"{k} = {_toml_value(p[k])}")
    for m in models:
        out += ["", f"[models.{_toml_key(m['id'])}]"]
        for k in ("provider", "model", "name", "context_window", "max_tokens", "vision", "price", "base_url",
                  "api_key_env", "drop_params", "rename_params"):
            if m.get(k) not in (None, "", [], {}):
                out.append(f"{k} = {_toml_value(m[k])}")
    return "\n".join(out) + "\n"


def _toml_key(k: str) -> str:
    import re
    return k if re.fullmatch(r"[A-Za-z0-9_-]+", k) else _toml_value(k)


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
        max_upstream_bytes=int(env("FERRY_MAX_UPSTREAM_BYTES") or saved.get("max_upstream_bytes", 0)),
        max_concurrent=int(saved.get("max_concurrent", 6)),
        bark_url=env("FERRY_BARK_URL") or saved.get("bark_url", ""),
        judge_model=saved.get("judge_model", ""),
        home=home,
        # on this computer the conversation is already in the client's own session files: keep no second copy
        session_store=env("FERRY_SESSION_STORE") or saved.get("session_store", "memory"),
        redact=(env("FERRY_REDACT").lower() not in ("0", "false", "off", "no")) if env("FERRY_REDACT")
        else bool(saved.get("redact", False)),
        models_file=models_file,
        settings_file=settings_file,
        public_url=saved.get("public_url", ""),
        record_details=bool(saved.get("record_details", False)),
        web_enabled=(env("FERRY_WEB").lower() in ("1", "true", "on", "yes")) if env("FERRY_WEB") else bool(saved.get("web", False)),
        web_allow=list(saved.get("web_allow", [])),
        web_engine=saved.get("web_engine", "bing"),
        web_proxy=saved.get("web_proxy", ""),
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
        f"max_upstream_bytes = {int(cfg.max_upstream_bytes)}\n"
        f"record_details = {'true' if cfg.record_details else 'false'}\n"
        f"web = {'true' if cfg.web_enabled else 'false'}\n"
        f"web_allow = {json.dumps(cfg.web_allow, ensure_ascii=False)}\n"
        f"web_engine = {json.dumps(cfg.web_engine)}\n"
        f"web_proxy = {json.dumps(cfg.web_proxy)}\n"
        f"max_concurrent = {int(cfg.max_concurrent)}\n"
        f"bark_url = {json.dumps(cfg.bark_url)}\n"
        f"judge_model = {json.dumps(cfg.judge_model)}\n", encoding="utf-8")
