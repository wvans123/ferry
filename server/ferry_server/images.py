"""Pictures for the agent's image_create tool.

The model chosen as "生成图片用" (routing.image) draws:
- an image model (gpt-image-*, dall-e-*, or any model behind an OpenAI-style /images/generations): the Images API;
- a model on a Responses-API provider: the Responses API with its image_generation tool (reference pictures can be
  given too).
The answer is the picture itself (base64), which the client saves into the project folder.
"""
from __future__ import annotations

import base64
import re

import httpx

from .config import ModelConfig
from .responses import responses_url

SIZES = {"auto", "1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792", "512x512", "256x256"}


def images_url(base_url: str) -> str:
    base = base_url.rstrip("/")
    for tail in ("/chat/completions", "/responses", "/images/generations"):
        if base.endswith(tail):
            base = base[: -len(tail)]
    return f"{base}/images/generations"


def is_image_model(name: str) -> bool:
    return bool(re.search(r"(^|/)(gpt-image|dall-e|chatgpt-image|imagen|flux|seedream|qwen-image|cogview)", name, re.I))


async def create_image(client: httpx.AsyncClient, m: ModelConfig, prompt: str, size: str, refs: list[str]) -> dict:
    if not prompt.strip():
        raise ValueError("an empty description")
    size = size if size in SIZES else "auto"
    headers = {"Content-Type": "application/json", **({"Authorization": f"Bearer {m.api_key}"} if m.api_key else {})}
    if m.api == "openai-responses" and not is_image_model(m.model):
        content = [{"type": "input_text", "text": prompt}] + [{"type": "input_image", "image_url": u} for u in refs]
        tool = {"type": "image_generation", **({"size": size} if size != "auto" else {})}
        r = await client.post(responses_url(m.base_url), headers=headers, timeout=600, json={
            "model": m.model, "input": [{"role": "user", "content": content}], "tools": [tool],
            "tool_choice": {"type": "image_generation"}, "store": False})
        r.raise_for_status()
        out = [{"b64": item["result"], "mime": "image/png", "revised_prompt": item.get("revised_prompt", "")}
               for item in r.json().get("output") or [] if item.get("type") == "image_generation_call" and item.get("result")]
    else:
        body = {"model": m.model, "prompt": prompt, "n": 1, **({"size": size} if size != "auto" else {})}
        if not re.search(r"gpt-image|chatgpt-image", m.model, re.I):
            body["response_format"] = "b64_json"  # gpt-image models always answer base64 and refuse this field
        r = await client.post(images_url(m.base_url), headers=headers, timeout=600, json=body)
        r.raise_for_status()
        out = []
        for d in r.json().get("data") or []:
            if d.get("b64_json"):
                out.append({"b64": d["b64_json"], "mime": "image/png", "revised_prompt": d.get("revised_prompt", "")})
            elif d.get("url"):  # some services answer with a link: fetch it here, the work computer may not reach it
                img = await client.get(d["url"], timeout=120)
                img.raise_for_status()
                out.append({"b64": base64.b64encode(img.content).decode(), "mime": img.headers.get("content-type", "image/png"),
                            "revised_prompt": d.get("revised_prompt", "")})
    if not out:
        raise ValueError("the model answered without a picture")
    return {"model": m.id, "images": out}
