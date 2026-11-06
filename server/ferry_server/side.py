"""Side questions about a conversation: the advisor, /btw and the recap.

One endpoint, POST /v1/ferry/side {kind, question, model, ferry: {conv, count, hash}, tail}. The server rebuilds the
conversation from the session cache (the same copy the chat requests use, refered to the same way), turns it into a
short transcript, adds an instruction for the kind, asks one model with no tools, and returns the text. Nothing is
added to the conversation. The usage is logged like any other call (purpose advise / btw / recap).

  advise  a stronger model reviews the work so far (the advisor model, or the most expensive one)
  btw     the conversation's own model answers a side question from what is in the conversation
  recap   the cheapest model says in a sentence or two what the work is and what comes next
"""
from __future__ import annotations

import json
import time

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .config import Config, ModelConfig
from .fit import Refused, complete, tokens_of
from .usage import cost, normalize

KINDS = ("advise", "btw", "recap")
TOOL_RESULT_CHARS = 1200   # a tool result in the transcript: its start and end
TEXT_CHARS = 6000          # a message's text
CALL_CHARS = 400           # the arguments of a tool call

SYSTEM = {
    "advise": ("You are a senior reviewer. An assistant (Ferry) is partway through a task for its user and asks you for a "
               "second opinion. You see the conversation so far as a transcript; you cannot use tools or open files."),
    "btw": ("You answer a side question from the user of an assistant (Ferry). You see the conversation so far as a "
            "transcript. You have no tools."),
    "recap": "You write a very short recap of a working session so the user can pick it up again.",
}

INSTRUCTION = {
    "advise": (
        "Review the work so far the way a stronger, more experienced reviewer would. Say what is wrong or missing in the "
        "approach, the result or the checking, and what to do next. Be concrete and short: the most important point first, "
        "at most about 200 words, plain text. Do not praise or repeat what was done. If the work looks right and complete, "
        "say so in one line and name anything still unchecked. Answer in the language the user writes in."),
    "btw": (
        "This is a side question from the user, asked while the main work goes on or just after it. Answer it directly, in "
        "one response, from what is in the conversation. You have no tools: you cannot read files, run commands or search. "
        "If the question needs that, say so in one line and say what to ask the main agent instead. Do not say \"let me\" "
        "or promise to look anything up; there is no follow-up turn. Keep it short and answer in the user's language."),
    "recap": (
        "The user stepped away and is coming back to this session. Recap it in under 40 words (about 60 Chinese characters "
        "when the user writes Chinese): one or two plain sentences, no markdown, no lists. Say the overall goal and the "
        "current task first, then the one next action. Do not list the steps taken. Use the user's language."),
}
MAX_TOKENS = {"advise": 1500, "btw": 2000, "recap": 300}


def _price(m: ModelConfig) -> float:
    p = m.price or {}
    return float(p.get("input", 0) or 0) + float(p.get("output", 0) or 0)


def _ready(cfg: Config) -> list[ModelConfig]:
    return [m for m in cfg.models.values() if m.ready and m.id != cfg.image_model]


def advisor_model(cfg: Config) -> ModelConfig | None:
    """The advisor setting; empty means the most expensive model with a price. None (the advisor is off) when there is
    none, or when that model is also the default one (a second opinion from the model that did the work is not worth it)."""
    m = cfg.models.get(cfg.advisor_model)
    if m and m.ready:
        return m
    priced = [x for x in _ready(cfg) if _price(x) > 0]
    best = max(priced, key=_price, default=None)
    return best if best and best.id != cfg.default_model else None


def cheap_model(cfg: Config, current: ModelConfig) -> ModelConfig:
    """Who writes the recap: the summary model if one is set, else the cheapest model with a price, else the current one."""
    m = cfg.models.get(cfg.summary_model)
    if m and m.ready:
        return m
    priced = [x for x in _ready(cfg) if _price(x) > 0]
    return min(priced, key=_price, default=current)


def current_model(cfg: Config, asked: str) -> ModelConfig:
    """The conversation's model: what the client names when the server lets clients pick, else the default model."""
    if cfg.expose_models and asked in cfg.models and cfg.models[asked].ready:
        return cfg.models[asked]
    m = cfg.models.get(cfg.default_model)
    return m if m and m.ready else next((x for x in _ready(cfg)), cfg.models[cfg.default_model])


def _clip(text: str, n: int, tail: int = 0) -> str:
    text = text.strip()
    if len(text) <= n:
        return text
    keep = n - tail
    return f"{text[:keep]} ... [{len(text) - n} characters left out] ... {text[-tail:]}" if tail else f"{text[:n]} ..."


def _blocks(content) -> list[dict]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return [b for b in content or [] if isinstance(b, dict)]


def _result_text(content) -> str:
    return "\n".join(b.get("text", "") for b in _blocks(content) if b.get("type") == "text")


def transcript_items(messages: list) -> list[str]:
    """One text item per message, in the labels the summary code uses: [User], [Assistant], [Assistant tool calls],
    [Tool result]. Reads both stored shapes: OpenAI chat messages and Anthropic Messages blocks. System messages,
    thinking and pictures are left out (a picture shows as [image])."""
    out: list[str] = []
    for m in messages:
        role = m.get("role")
        if role in ("system", "developer", "__system__"):
            continue
        if role == "tool":  # OpenAI
            out.append("[Tool result]: " + _clip(_result_text(m.get("content")), TOOL_RESULT_CHARS, 300))
            continue
        text, calls, results = [], [], []
        for b in _blocks(m.get("content")):
            t = b.get("type")
            if t == "text" and b.get("text", "").strip():
                text.append(b["text"])
            elif t in ("image", "image_url"):
                text.append("[image]")
            elif t == "tool_use":  # Anthropic
                calls.append(f"{b.get('name')}({_clip(json.dumps(b.get('input'), ensure_ascii=False), CALL_CHARS)})")
            elif t == "tool_result":
                results.append(_clip(_result_text(b.get("content")), TOOL_RESULT_CHARS, 300))
        for tc in m.get("tool_calls") or []:  # OpenAI
            fn = tc.get("function") or {}
            calls.append(f"{fn.get('name')}({_clip(str(fn.get('arguments') or ''), CALL_CHARS)})")
        label = "[User]" if role == "user" else "[Assistant]"
        if text:
            out.append(f"{label}: {_clip(chr(10).join(text), TEXT_CHARS)}")
        if calls:
            out.append("[Assistant tool calls]: " + "; ".join(calls))
        out += [f"[Tool result]: {r}" for r in results]
    return out


def transcript(messages: list, tail: str, budget: int) -> str:
    """The conversation as text that fits in `budget` tokens: the first request stays, the oldest middle goes first."""
    items = transcript_items(messages)
    if tail.strip():
        items.append("[Assistant]: " + _clip(tail, TEXT_CHARS))
    total = sum(tokens_of(i) for i in items)
    dropped = 0
    while total > budget and len(items) > 2:
        total -= tokens_of(items.pop(1))
        dropped += 1
    if dropped:
        items.insert(1, f"[... {dropped} earlier messages left out ...]")
    return "\n\n".join(items)


def prompt_for(kind: str, convo: str, question: str) -> str:
    ask = question.strip()[:2000]
    if kind == "advise" and ask:
        ask = f"The assistant asks you in particular: {ask}"
    elif kind == "btw":
        ask = f"The user's side question: {ask}"
    elif kind == "recap":
        ask = ""
    body = f"<conversation>\n{convo}\n</conversation>\n\n" if convo.strip() else "(No conversation yet.)\n\n"
    return f"{body}{INSTRUCTION[kind]}" + (f"\n\n{ask}" if ask else "")


def mount(app: FastAPI, cfg: Config, client: httpx.AsyncClient, audit, store, key, limit_of) -> None:
    """store() is the live session store, key(request, id) a user's own session key, limit_of(model) the context size."""

    @app.post("/v1/ferry/side")
    async def side(request: Request):
        started = time.time()
        b = json.loads(await request.body() or b"{}")
        kind = str(b.get("kind") or "")
        if kind not in KINDS:
            return JSONResponse({"error": f"kind must be one of {', '.join(KINDS)}"}, 400)
        question = str(b.get("question") or "")
        if kind == "btw" and not question.strip():
            return JSONResponse({"error": "the question is empty"}, 400)
        cur = current_model(cfg, str(b.get("model") or ""))
        chosen = advisor_model(cfg) if kind == "advise" else cheap_model(cfg, cur) if kind == "recap" else cur
        if chosen is None:
            return JSONResponse({"error": "no advisor model is set on the Ferry server (admin page: 服务商和模型 → 顾问模型)"}, 404)
        messages: list = []
        ref = b.get("ferry")
        if isinstance(ref, dict) and ref.get("conv"):
            try:
                messages, _ = store().load(key(request, str(ref["conv"])), int(ref.get("count") or 0), str(ref.get("hash") or ""), None)
                if cfg.session_store == "none":  # the server keeps nothing between calls
                    store().forget(key(request, str(ref["conv"])))
            except KeyError:
                return JSONResponse({"error": "session not found on the server; the client will resend it"}, 409)
        last: Exception | None = None
        for m in ([chosen] if chosen.id == cur.id else [chosen, cur]):  # the chosen model, then the conversation's own
            convo = transcript(messages, str(b.get("tail") or ""), max(2000, int(limit_of(m) * 0.6) - 4000))
            try:
                text, usage = await complete(client, m, SYSTEM[kind], prompt_for(kind, convo, question), MAX_TOKENS[kind])
            except (Refused, httpx.HTTPError) as e:
                last = e
                continue
            tokens = normalize(usage)
            audit(event="chat", user=request.state.user, purpose=kind, model=m.id, status=200,
                  messages=len(messages), ms=int((time.time() - started) * 1000), tokens=tokens, cost=cost(tokens, m.price))
            return {"text": text.strip(), "model": m.id}
        audit(event="chat", user=request.state.user, purpose=kind, model=chosen.id, status=502, error=repr(last)[:200])
        return JSONResponse({"error": f"no model answered: {last!r}"[:400]}, 502)
