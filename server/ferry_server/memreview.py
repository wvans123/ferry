"""Memory review: the summary model proposes what to remember from a finished conversation, or how to tidy memories.

One endpoint, POST /v1/ferry/memory-review {kind, model, today, transcript, indexes, memories}. The client builds a
compact transcript of its previous conversation (from its own session file) and sends it with its memory indexes and
the memories it lets the model change. The server asks one model with no tools and returns JSON; it keeps nothing.
The client shows every proposal and writes only what the user accepts.

  propose  0 to 3 memories worth keeping from the transcript: {candidates: [{action, scope, name, description,
           content, reason}]}
  tidy     merge, rewrite or delete memories: {operations: [{op, scope, sources, name, description, content, reason}]}
"""
from __future__ import annotations

import json
import re
import time

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .config import Config
from .fit import Refused, complete
from .side import cheap_model, current_model
from .usage import cost, normalize

KINDS = ("propose", "tidy")
TRANSCRIPT_CHARS = 80_000
MEMORIES_CHARS = 80_000
SCOPES = ("user", "project")
MAX_CANDIDATES = 3
MAX_OPERATIONS = 10

SYSTEM = ("You look after the long-term memory of a coding and work assistant (Ferry). Memories are short Markdown notes "
          "kept across conversations. You have no tools. You answer with one JSON object and nothing else.")

RULES = (
    "What a memory is for: durable facts about the user or the project, the user's preferences, and corrections or "
    "confirmations of how the assistant should work, that will matter in later conversations.\n"
    "Scopes: user = about the user, in every project (role, preferences, how they want the work done); project = about "
    "this project folder (decisions and their reasons, conventions, where things live, known pitfalls).\n"
    "A rule is written as the rule, then a line \"Why: ...\" (the reason, as the user gave it) and a line "
    "\"How to apply: ...\" (when it applies). Write dates as absolute dates. Keep each memory short.")

INSTRUCTION = {
    "propose": (
        "Above is the transcript of the user's previous conversation, followed by the current memory. Propose at most "
        "three memories worth keeping from it; zero is a good answer when nothing qualifies.\n"
        "- Only durable facts, preferences and corrections. Prefer what the user said or confirmed; never present the "
        "assistant's own guesses or conclusions as the user's view (if you keep one, say it was the assistant's finding).\n"
        "- Skip what the code, the git history or AGENTS.md already record, details tied only to that one task, "
        "secrets, passwords, keys, and personal data about other people.\n"
        "- When an existing memory covers the point, propose action \"update\" with that memory's scope and name and "
        "the full merged content (keep what is still true in the old text). Only memories listed in full can be "
        "updated, and never a pinned one. Do not propose what the memory already says.\n"
        "- name: short lowercase file name with dashes. description: one line for the index, saying when the memory "
        "is useful. reason: one line telling the user why this is worth remembering, quoting what they said if you can.\n"
        "- Write in the language the user writes in.\n"
        'Answer: {"candidates": [{"action": "add" or "update", "scope": "user" or "project", "name": "...", '
        '"description": "...", "content": "...", "reason": "..."}]}'),
    "tidy": (
        "Above are the user's memories. Propose a short list of changes that make them smaller and clearer; an empty "
        "list is a good answer when they are fine.\n"
        "- merge: memories in one scope that cover the same point become one (sources: their names; name: the result, "
        "which may be one of the sources; content: the merged text keeping everything still true).\n"
        "- rewrite: a memory that is vague, too long, or misses its Why: / How to apply: lines.\n"
        "- delete: a memory that is clearly stale, contradicted by a newer one, or tied only to one finished task.\n"
        "- Only touch memories listed in full; pinned ones are not listed and must stay. When unsure, leave it.\n"
        "- reason: one line telling the user why. Write in the language the memories are written in.\n"
        'Answer: {"operations": [{"op": "merge" or "rewrite" or "delete", "scope": "user" or "project", '
        '"sources": ["..."], "name": "...", "description": "...", "content": "...", "reason": "..."}]}'),
}
MAX_TOKENS = {"propose": 2500, "tidy": 6000}


def _clip(text: str, n: int) -> str:
    text = str(text or "")
    return text if len(text) <= n else f"{text[:n]}\n...[cut]"


def _memories_text(memories: list) -> str:
    out, used = [], 0
    for m in memories if isinstance(memories, list) else []:
        if not isinstance(m, dict) or m.get("scope") not in SCOPES:
            continue
        item = (f"<memory scope=\"{m['scope']}\" name=\"{m.get('name', '')}\" updated=\"{m.get('updated', '')}\">\n"
                f"description: {m.get('description', '')}\n{str(m.get('content', '')).strip()}\n</memory>")
        if used + len(item) > MEMORIES_CHARS:
            break
        out.append(item)
        used += len(item)
    return "\n\n".join(out)


def prompt_for(kind: str, b: dict) -> str:
    idx = b.get("indexes") if isinstance(b.get("indexes"), dict) else {}
    index = "\n\n".join(f"{scope} index:\n{str(idx.get(scope) or '(empty)')[:20000]}" for scope in ("user", "project", "global")
                        if scope in idx)
    full = _memories_text(b.get("memories"))
    today = re.sub(r"[^\d-]", "", str(b.get("today") or ""))[:10]
    parts = []
    if kind == "propose":
        parts.append(f"<transcript>\n{_clip(b.get('transcript'), TRANSCRIPT_CHARS)}\n</transcript>")
        parts.append(f"<memory_index>\n{index or '(no memories yet)'}\n</memory_index>")
    parts.append(f"<memories_in_full>\n{full or '(none)'}\n</memories_in_full>")
    parts.append(RULES)
    if today:
        parts.append(f"Today is {today}.")
    parts.append(INSTRUCTION[kind])
    return "\n\n".join(parts)


def _json_object(text: str) -> dict:
    """The model's answer as a dict: the outermost {...}, with or without a code fence around it; {} when it is not JSON."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        d = json.loads(text[start:end + 1])
    except ValueError:
        return {}
    return d if isinstance(d, dict) else {}


def _name(s) -> str:
    s = re.sub(r"\.md$", "", str(s or "").strip().lower())
    return re.sub(r"[^\w-]+", "-", s, flags=re.UNICODE).strip("-")[:60]


def _line(s, n: int = 300) -> str:
    return " ".join(str(s or "").split())[:n]


def candidates(d: dict) -> list[dict]:
    out = []
    for c in d.get("candidates") or []:
        if not isinstance(c, dict):
            continue
        item = {"action": "update" if c.get("action") == "update" else "add",
                "scope": c.get("scope") if c.get("scope") in SCOPES else "project", "name": _name(c.get("name")),
                "description": _line(c.get("description")), "content": str(c.get("content") or "").strip()[:8000],
                "reason": _line(c.get("reason"), 400)}
        if item["name"] and item["content"]:
            out.append(item)
    return out[:MAX_CANDIDATES]


def operations(d: dict) -> list[dict]:
    out = []
    for o in d.get("operations") or []:
        if not isinstance(o, dict) or o.get("op") not in ("merge", "rewrite", "delete") or o.get("scope") not in SCOPES:
            continue
        item = {"op": o["op"], "scope": o["scope"], "name": _name(o.get("name")),
                "sources": [n for n in (_name(x) for x in o.get("sources") or []) if n][:10],
                "description": _line(o.get("description")), "content": str(o.get("content") or "").strip()[:8000],
                "reason": _line(o.get("reason"), 400)}
        if not item["name"] or (item["op"] != "delete" and not item["content"]) or (item["op"] == "merge" and len(item["sources"]) < 2):
            continue
        out.append(item)
    return out[:MAX_OPERATIONS]


def mount(app: FastAPI, cfg: Config, client: httpx.AsyncClient, audit) -> None:

    @app.post("/v1/ferry/memory-review")
    async def memory_review(request: Request):
        started = time.time()
        b = json.loads(await request.body() or b"{}")
        kind = str(b.get("kind") or "")
        if kind not in KINDS:
            return JSONResponse({"error": f"kind must be one of {', '.join(KINDS)}"}, 400)
        if kind == "propose" and not str(b.get("transcript") or "").strip():
            return JSONResponse({"error": "the transcript is empty"}, 400)
        cur = current_model(cfg, str(b.get("model") or ""))
        chosen = cheap_model(cfg, cur)
        prompt = prompt_for(kind, b)
        last: Exception | None = None
        for m in ([chosen] if chosen.id == cur.id else [chosen, cur]):  # the summary model, then the conversation's own
            try:
                text, usage = await complete(client, m, SYSTEM, prompt, MAX_TOKENS[kind])
            except (Refused, httpx.HTTPError) as e:
                last = e
                continue
            tokens = normalize(usage)
            audit(event="chat", user=request.state.user, purpose="memory", model=m.id, status=200,
                  ms=int((time.time() - started) * 1000), tokens=tokens, cost=cost(tokens, m.price))
            d = _json_object(text)
            if kind == "propose":
                return {"candidates": candidates(d), "model": m.id}
            return {"operations": operations(d), "model": m.id}
        audit(event="chat", user=request.state.user, purpose="memory", model=chosen.id, status=502, error=repr(last)[:200])
        return JSONResponse({"error": f"no model answered: {last!r}"[:400]}, 502)
