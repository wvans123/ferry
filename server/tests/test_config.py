from ferry_server.config import zero_config_models

KEYS = ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "FERRY_MODEL", "FERRY_CLAUDE_MODEL",
        "FERRY_UPSTREAM_BASE_URL", "FERRY_UPSTREAM_MODEL", "FERRY_CONTEXT_WINDOW")


def env(monkeypatch, **kv):
    for k in KEYS:
        monkeypatch.delenv(k, raising=False)
    for k, v in kv.items():
        monkeypatch.setenv(k, v)


def test_no_key_lists_deepseek_as_not_ready(monkeypatch):
    env(monkeypatch)
    m = zero_config_models()
    assert list(m) == ["deepseek"] and not m["deepseek"].api_key


def test_one_model_per_key_claude_first(monkeypatch):
    env(monkeypatch, ANTHROPIC_API_KEY="a", OPENAI_API_KEY="o", DEEPSEEK_API_KEY="d")
    m = zero_config_models()
    assert list(m) == ["claude", "openai", "deepseek"]
    assert m["claude"].base_url == "https://api.anthropic.com/v1" and "temperature" in m["claude"].drop_params
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
