"""Ready-made model providers: the address, where to get a key, and a few suggested models.

Model names change often, so the admin page always reads the provider's own model list when a provider is added;
`models` here only decides which ones are ticked by default. Every provider speaks the OpenAI chat completions
format. `base_url` either is a base (".../v1", "/chat/completions" is appended) or already ends with
"/chat/completions" (used as is), for providers whose paths are irregular.
"""
from __future__ import annotations

# (model name, context window in tokens, max output tokens[, extras]); extras: vision (takes images) and
# price (USD per million tokens: input, output, cache_read, cache_write), from the providers' price pages.
Model = tuple

CLAUDE = {"vision": True}
OPUS_55 = {**CLAUDE, "price": {"input": 4, "output": 20, "cache_read": 0.2, "cache_write": 5}}
SONNET_55 = {**CLAUDE, "price": {"input": 2, "output": 10, "cache_read": 0.1, "cache_write": 2.5}}
HAIKU_55 = {**CLAUDE, "price": {"input": 0.1, "output": 0.5, "cache_read": 0.01, "cache_write": 0.125}}

PRESETS: list[dict] = [
    {
        "id": "deepseek", "name": "DeepSeek", "group": "国内",
        "base_url": "https://api.deepseek.com",
        "key_hint": "platform.deepseek.com → API Keys", "key_url": "https://platform.deepseek.com/api_keys",
        "models": [("deepseek-flash", 1_000_000, 32_000, {"vision": True}), ("deepseek-v4-pro", 128_000, 8_192)],
        "drop_params": ["store"], "rename_params": {"max_completion_tokens": "max_tokens"},
    },
    {
        "id": "kimi", "name": "Kimi（月之暗面开放平台）", "group": "国内",
        "base_url": "https://api.moonshot.cn/v1",
        "key_hint": "platform.moonshot.cn → API Key 管理", "key_url": "https://platform.moonshot.cn/console/api-keys",
        "models": [], "drop_params": ["store"], "rename_params": {"max_completion_tokens": "max_tokens"},
    },
    {
        "id": "kimi-coding", "name": "Kimi 编程套餐", "group": "编程套餐",
        "base_url": "https://api.kimi.com/coding/v1",
        "key_hint": "Kimi Code 编程套餐页获取 API Key（和开放平台的 Key 不通用）", "key_url": "",
        "models": [("k3", 262_144, 32_768), ("kimi-for-coding", 262_144, 32_768)],
        "drop_params": ["store"], "rename_params": {"max_completion_tokens": "max_tokens"},
    },
    {
        "id": "zhipu", "name": "智谱 GLM（开放平台）", "group": "国内",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "key_hint": "bigmodel.cn → 个人中心 → API Keys", "key_url": "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
        "models": [], "drop_params": ["store"], "rename_params": {"max_completion_tokens": "max_tokens"},
    },
    {
        "id": "zhipu-coding", "name": "智谱 GLM 编程套餐", "group": "编程套餐",
        "base_url": "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
        "key_hint": "bigmodel.cn → GLM Coding Plan → API Key（套餐 Key 和普通 Key 不通用）",
        "key_url": "",
        "models": [("glm-5.3", 200_000, 32_768), ("glm-5.2", 200_000, 32_768), ("glm-4.7", 200_000, 32_768)],
        "drop_params": ["store"], "rename_params": {"max_completion_tokens": "max_tokens"},
    },
    {
        "id": "qwen", "name": "通义千问（阿里云百炼）", "group": "国内",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "key_hint": "阿里云百炼控制台 → API-KEY", "key_url": "https://bailian.console.aliyun.com/?apiKey=1",
        "models": [], "drop_params": ["store"], "rename_params": {"max_completion_tokens": "max_tokens"},
    },
    {
        "id": "volcengine", "name": "火山方舟（豆包）", "group": "国内",
        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "key_hint": "火山方舟控制台 → API Key 管理；模型名一般是推理接入点 ID 或模型 ID",
        "key_url": "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
        "models": [], "drop_params": ["store"], "rename_params": {"max_completion_tokens": "max_tokens"},
    },
    {
        "id": "volcengine-coding", "name": "火山方舟编程套餐", "group": "编程套餐",
        "base_url": "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions",
        "key_hint": "火山方舟 Coding Plan 页面获取 API Key", "key_url": "",
        "models": [("ark-code-latest", 256_000, 32_768)],
        "drop_params": ["store"], "rename_params": {"max_completion_tokens": "max_tokens"},
    },
    {
        "id": "siliconflow", "name": "硅基流动", "group": "国内",
        "base_url": "https://api.siliconflow.cn/v1",
        "key_hint": "cloud.siliconflow.cn → API 密钥", "key_url": "https://cloud.siliconflow.cn/account/ak",
        "models": [], "drop_params": ["store"], "rename_params": {"max_completion_tokens": "max_tokens"},
    },
    {
        "id": "claude", "name": "Claude（Anthropic）", "group": "海外",
        "base_url": "https://api.anthropic.com", "api": "anthropic",  # native Messages API: prompt caching, thinking
        "key_hint": "console.anthropic.com → API Keys。不服务中国大陆和香港，服务端要在支持的地区",
        "key_url": "https://console.anthropic.com/settings/keys",
        "models": [("claude-opus-5-5", 1_000_000, 64_000, OPUS_55), ("claude-sonnet-5-5", 1_000_000, 64_000, SONNET_55),
                   ("claude-haiku-5-5", 1_000_000, 64_000, HAIKU_55)],
        "drop_params": ["temperature", "top_p"], "rename_params": {},
    },
    {
        "id": "openai", "name": "OpenAI", "group": "海外",
        "base_url": "https://api.openai.com/v1",
        "key_hint": "platform.openai.com → API keys。不服务中国大陆和香港，服务端要在支持的地区",
        "key_url": "https://platform.openai.com/api-keys",
        "models": [("gpt-6.1-sol", 400_000, 64_000, {"vision": True, "price": {"input": 2, "output": 10, "cache_read": 0.1}}),
                   ("gpt-6-astra", 400_000, 64_000, {"vision": True, "price": {"input": 10, "output": 50, "cache_read": 1}}),
                   ("gpt-6.1-terra", 400_000, 64_000, {"vision": True, "price": {"input": 1, "output": 5, "cache_read": 0.05}})],
        "drop_params": [], "rename_params": {},
    },
    {
        "id": "openrouter", "name": "OpenRouter", "group": "海外",
        "base_url": "https://openrouter.ai/api/v1",
        "key_hint": "openrouter.ai → Keys", "key_url": "https://openrouter.ai/settings/keys",
        "models": [], "drop_params": ["store"], "rename_params": {"max_completion_tokens": "max_tokens"},
    },
    {
        "id": "ollama", "name": "本机 Ollama", "group": "本机和自定义",
        "base_url": "http://127.0.0.1:11434/v1", "no_key": True,
        "key_hint": "不需要 Key；先在这台电脑上装好 Ollama 并下载模型", "key_url": "https://ollama.com",
        "models": [], "drop_params": ["store"], "rename_params": {"max_completion_tokens": "max_tokens"},
    },
    {
        "id": "custom", "name": "自定义（OpenAI 兼容接口）", "group": "本机和自定义",
        "base_url": "", "custom": True,
        "key_hint": "任何 OpenAI 兼容的接口：你自己的中转、公司内部网关等", "key_url": "",
        "models": [], "drop_params": ["store"], "rename_params": {"max_completion_tokens": "max_tokens"},
    },
]

BY_ID = {p["id"]: p for p in PRESETS}


def public() -> list[dict]:
    """What the admin page needs to show the catalog."""
    return [{**{k: v for k, v in p.items() if k != "models"},
             "models": [{"model": m[0], "context_window": m[1], "max_tokens": m[2], **(m[3] if len(m) > 3 else {})}
                        for m in p["models"]]}
            for p in PRESETS]


def model_extras(model: str) -> dict:
    """vision and price of a model name any preset knows, else {}."""
    for p in PRESETS:
        for m in p["models"]:
            if m[0] == model and len(m) > 3:
                return dict(m[3])
    return {}


def chat_url(base_url: str) -> str:
    base = base_url.rstrip("/")
    return base if base.endswith("/chat/completions") else f"{base}/chat/completions"


def models_url(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")]
    return f"{base}/models"


def anthropic_url(base_url: str) -> str:
    """The Messages API address for a base such as https://api.anthropic.com (or one ending in /v1)."""
    base = base_url.rstrip("/")
    if base.endswith("/v1/messages"):
        return base
    return f"{base}/messages" if base.endswith("/v1") else f"{base}/v1/messages"
