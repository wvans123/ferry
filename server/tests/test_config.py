from ferry_server.config import zero_config_models

KEYS = ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "FERRY_MODEL", "FERRY_CLAUDE_MODEL",
        "FERRY_UPSTREAM_BASE_URL", "FERRY_UPSTREAM_MODEL", "FERRY_CONTEXT_WINDOW")


def env(monkeypatch, **kv):
    for k in KEYS:
        monkeypatch.delenv(k, raising=False)
    for k, v in kv.items():
        monkeypatch.setenv(k, v)


def test_no_key_does_not_invent_models(monkeypatch):
    env(monkeypatch)
    m = zero_config_models()
    assert m == {}


def test_one_model_per_key_claude_first(monkeypatch):
    env(monkeypatch, ANTHROPIC_API_KEY="a", OPENAI_API_KEY="o", DEEPSEEK_API_KEY="d")
    m = zero_config_models()
    assert list(m) == ["claude", "openai", "deepseek"]
    assert m["claude"].base_url == "https://api.anthropic.com" and "temperature" in m["claude"].drop_params
    assert m["claude"].api == "anthropic" and m["claude"].vision and m["claude"].price["cache_read"] == 0.2
    assert m["deepseek"].rename_params == {"max_completion_tokens": "max_tokens"}


def test_only_claude_hides_deepseek_hint(monkeypatch):
    env(monkeypatch, ANTHROPIC_API_KEY="a")
    assert list(zero_config_models()) == ["claude"]


def test_overrides(monkeypatch):
    env(monkeypatch, ANTHROPIC_API_KEY="a", DEEPSEEK_API_KEY="d", FERRY_MODEL="deepseek",
        FERRY_CLAUDE_MODEL="claude-opus-5-5", FERRY_CONTEXT_WINDOW="100000")
    m = zero_config_models()
    assert list(m)[0] == "deepseek" and m["claude"].model == "claude-opus-5-5"
    assert m["claude"].context_window == 100000


def test_routing_checks(tmp_path, monkeypatch):
    import pytest
    from ferry_server.config import load

    monkeypatch.setenv("FERRY_SECRET", "s" * 20)
    monkeypatch.setenv("T1", "t" * 20)
    base = ('[server]\ndata_dir = "d"\n[[users]]\nname = "a"\ntoken_env = "T1"\n'
            '[models.big]\nbase_url = "x"\nmodel = "m"\n[models.small]\nbase_url = "x"\nmodel = "s"\n')
    f = tmp_path / "c.toml"
    f.write_text(base, encoding="utf-8")
    cfg = load(f)
    assert cfg.default_model == "big" and cfg.summary_model == "" and cfg.session_store == "disk"
    f.write_text(base + '[routing]\ndefault = "small"\nsummary = "small"\n', encoding="utf-8")
    assert load(f).default_model == "small"
    f.write_text(base + '[routing]\nsummary = "nope"\n', encoding="utf-8")
    with pytest.raises(SystemExit):
        load(f)
    f.write_text(base.replace('data_dir = "d"', 'data_dir = "d"\nsession_store = "cloud"'), encoding="utf-8")
    with pytest.raises(SystemExit):
        load(f)


def test_models_file_written_then_hot_reloaded(tmp_path, monkeypatch):
    import os
    from ferry_server.config import load_default, refresh_models

    env(monkeypatch, DEEPSEEK_API_KEY="d")
    monkeypatch.setenv("FERRY_SERVER_HOME", str(tmp_path))
    cfg = load_default()
    f = tmp_path / "models.toml"
    assert f.exists() and list(cfg.models) == ["deepseek"] and cfg.expose_models
    text = f.read_text(encoding="utf-8")
    f.write_text(text.replace("# [models.deepseek-think]", "[models.deepseek-think]")
                 .replace('# base_url = "https://api.deepseek.com"\n# api_key_env = "DEEPSEEK_API_KEY"\n# model = "deepseek-reasoner"',
                          'base_url = "https://api.deepseek.com"\napi_key_env = "DEEPSEEK_API_KEY"\nmodel = "deepseek-reasoner"')
                 .replace('default = "deepseek"', 'default = "deepseek-think"'), encoding="utf-8")
    os.utime(f, (cfg.models_mtime + 5, cfg.models_mtime + 5))
    assert refresh_models(cfg) == ""
    assert cfg.default_model == "deepseek-think" and cfg.models["deepseek-think"].model == "deepseek-reasoner"
    f.write_text("this is [ not toml", encoding="utf-8")                 # a broken edit keeps the old list
    os.utime(f, (cfg.models_mtime + 10, cfg.models_mtime + 10))
    assert refresh_models(cfg) and cfg.default_model == "deepseek-think"


def test_old_deepseek_sizes_are_raised_but_chosen_ones_kept():
    from ferry_server.config import parse_models
    raw = {"providers": {"deepseek": {"preset": "deepseek"}},
           "models": {"a": {"provider": "deepseek", "model": "deepseek-flash", "context_window": 128000, "max_tokens": 8192},
                      "b": {"provider": "deepseek", "model": "deepseek-flash", "context_window": 300000, "max_tokens": 16000},
                      "c": {"provider": "deepseek", "model": "deepseek-v4-pro", "context_window": 128000, "max_tokens": 8192}}}
    _, models = parse_models(raw, {})
    assert (models["a"].context_window, models["a"].max_tokens) == (1_000_000, 32_000)
    assert (models["b"].context_window, models["b"].max_tokens) == (300_000, 16_000)
    assert models["c"].context_window == 128_000


def test_stall_seconds_default_and_zero_survive_the_models_file(tmp_path, monkeypatch):
    from ferry_server.config import load_default, render_models_toml
    monkeypatch.setenv("FERRY_SERVER_HOME", str(tmp_path))
    for sec, want in ((None, 300), (0, 0), (45, 45), (300, 300), (120, 120)):
        p = {"id": "x", "base_url": "http://x/v1", "api_key_env": "K", "no_key": True}
        if sec is not None:
            p["stall_seconds"] = sec
        text = render_models_toml([p], [{"id": "m", "provider": "x", "model": "m"}], {"default": "m"})
        (tmp_path / "models.toml").write_text(text, encoding="utf-8")
        assert load_default().providers["x"].stall_seconds == want


def test_old_settings_for_removed_features_load_without_an_error(tmp_path, monkeypatch, capsys):
    """A config written before the Feishu bot and the provider fallback were removed still loads; the keys are ignored."""
    from ferry_server.config import load_default
    for k in KEYS:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("FERRY_SERVER_HOME", str(tmp_path))
    monkeypatch.setenv("KEY_A", "ka")
    (tmp_path / "server.toml").write_text('bark_url = "https://bark.example/x"\nfeishu_on = true\n\n[feishu]\napp_id = "cli_x"\n', encoding="utf-8")
    (tmp_path / "feishu.json").write_text('{"app_id": "cli_x", "owner": "ou_1"}', encoding="utf-8")
    (tmp_path / "models.toml").write_text(
        '[providers.a]\nbase_url = "https://a.example.com/v1"\napi_key_env = "KEY_A"\nfallback = "gpt-b"\n\n'
        '[models.gpt]\nprovider = "a"\nmodel = "gpt-6.1-sol"\n\n[models.gpt-b]\nprovider = "a"\nmodel = "gpt-6.1-sol-b"\n', encoding="utf-8")
    cfg = load_default()
    assert cfg.bark_url == "https://bark.example/x" and list(cfg.models) == ["gpt", "gpt-b"]
    assert not hasattr(cfg.providers["a"], "fallback") and "'fallback' is no longer used" in capsys.readouterr().out
