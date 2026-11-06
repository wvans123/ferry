"""Memory review: the summary model proposes what to remember from a finished conversation, or how to tidy memories.

One endpoint, POST /v1/ferry/memory-review {kind, model, today, transcript, indexes, memories}. The client builds a
compact transcript of its previous conversation (from its own session file) and sends it with its memory indexes and
the memories it lets the model change. The server asks one model with no tools and returns JSON; it keeps nothing.
The client shows every proposal and writes only what the user accepts.

  propose  0 to 3 memories worth keeping from the transcript: {candidates: [{action, scope, name, description,
           content, reason}]}
  tidy     merge, rewrite or delete memories: {operations: [{op, scope, sources, name, description, content, reason}]}
  digest   one past conversation as a small card, for /memory distill: {card: {goal, category, outcome, feedback,
           corrections, friction, failures}}
  distill  what recurs across many cards, as memories, AGENTS.md rules, skills or habits, each with evidence quoted
           from the cards (the conversation's own model): {items: [{kind, op, target, name, description, content,
           evidence, reason}], recurrence: [{item, seen_again, evidence}]}
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

KINDS = ("propose", "tidy", "digest", "distill")
TRANSCRIPT_CHARS = 80_000
MEMORIES_CHARS = 80_000
CARDS_CHARS = 450_000
RULES_CHARS = 20_000
SCOPES = ("user", "project")
MAX_CANDIDATES = 3
MAX_OPERATIONS = 10
ITEM_KINDS = ("memory", "rule", "skill", "habit")
MAX_ITEMS = {"memory": 5, "rule": 3, "skill": 2, "habit": 5}
FEEDBACK = ("accepted", "corrected", "new_request", "unknown")
OUTCOMES = ("done", "partly", "failed", "abandoned", "unknown")

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
    "digest": (
        "Above is the transcript of one past conversation between the user and the assistant. Write a short card about "
        "it, so that later many cards can be compared to find what keeps coming up.\n"
        "- goal: one line, what the user wanted. category: one or two words for the kind of task (for example code, "
        "document, 3GPP spec, research, web, data, setup). outcome: done, partly, failed, abandoned or unknown.\n"
        "- feedback: one entry for each point where the assistant delivered something and the user wrote again. after: "
        "one line, what was delivered. type: accepted only when the user explicitly approves (\"good\", \"that works\", "
        "\"exactly\"); corrected when they say it is wrong or ask to change what was delivered; new_request when they move "
        "on to something else without judging it; unknown when there is no explicit signal. \"continue\", \"go on\" or "
        "\"ok\" alone is not acceptance: unknown. quote: the start of the user's next message.\n"
        "- corrections: the user's corrections and instructions about how the assistant should work. Leave out what is "
        "only about this one task's content. At most 8.\n"
        "- friction: what made the work harder, from: misunderstood, ignored_instruction, wrong_approach, "
        "repeated_failure, too_slow, too_long, environment, other.\n"
        "- failures: what went wrong (a failing command, a wrong file, a tool error), its cause and the fix when the "
        "transcript shows them. At most 5.\n"
        "- Quotes (corrections, quote) are the user's words copied exactly from [User] lines: never translate, shorten "
        "inside or paraphrase them. Other fields are short and in the user's language. Empty lists are fine. No secrets, "
        "passwords or keys.\n"
        'Answer: {"goal": "...", "category": "...", "outcome": "...", "feedback": [{"after": "...", "type": "...", '
        '"quote": "..."}], "corrections": ["..."], "friction": ["..."], "failures": [{"symptom": "...", "cause": "...", '
        '"fix": "..."}]}'),
    "distill": (
        "Above are cards, one per past conversation of the user with the assistant ([NEW] since the last distill, [old] "
        "before it; old cards count when you judge whether something recurs), then what the assistant already has: "
        "memories, AGENTS.md rules, skills, and items the user accepted in earlier distills. Find what keeps coming up "
        "across conversations (the same correction given again, the same kind of task done the same way, the same "
        "failure and its fix) and propose changes that stop it from repeating. Zero items is a good answer.\n"
        "Kinds:\n"
        "- memory: a durable fact, preference or correction. target \"user\" (the user, every project) or \"project\" "
        "(the current project). Needs evidence from at least 2 different sessions.\n"
        "- rule: one short rule for AGENTS.md, something the assistant must always or never do. target \"user-agents\" "
        "(every project) or \"project-agents\" (the current project). Needs evidence from at least 3 different sessions.\n"
        "- skill: a procedure done several times the same way and verified to work. target \"skill:<name>\". Needs "
        "evidence from at least 3 different sessions. content is the SKILL.md body: when to use it (the trigger), the "
        "steps, and how to check the result. description: one line saying when to use it.\n"
        "- habit: advice about the user's own way of working (for example: stating the goal up front saves a "
        "correction). It is only shown to the user, never written anywhere.\n"
        "Rules:\n"
        "- Every item carries evidence: [{\"session\": the session id as on its card, \"date\": its date, \"quote\": words "
        "copied exactly from that card}]. Each session counts once. For target \"project\" and \"project-agents\" only "
        "sessions of the current project count.\n"
        "- Skip what the code, the existing rules, memories or skills already say; generic advice any assistant follows; "
        "details tied to one task; anything listed in never_suggest; secrets and personal data about other people.\n"
        "- Prefer updating an existing entry to adding one: op \"update\" with its target and name and the full new "
        "content, keeping what is still true. Only memories listed in full, skills marked ferry-distill, and rules in the "
        "ferry-distill block (by their name) can be updated.\n"
        "- At most 5 memories, 3 rules, 2 skills.\n"
        "- recurrence: for each item accepted in an earlier distill, say whether the problem it targets appeared again "
        "in the [NEW] cards (seen_again, with the session and quote as evidence) or not.\n"
        "- name: short, lowercase, dashes. reason: one line for the user saying what kept happening and how often. "
        "Write content, description, reason and recurrence in the language the user writes in.\n"
        'Answer: {"items": [{"kind": "memory" or "rule" or "skill" or "habit", "op": "add" or "update", "target": "...", '
        '"name": "...", "description": "...", "content": "...", "evidence": [{"session": "...", "date": "...", '
        '"quote": "..."}], "reason": "..."}], "recurrence": [{"item": "...", "seen_again": true, "evidence": "..."}]}'),
}
MAX_TOKENS = {"propose": 2500, "tidy": 6000, "digest": 2000, "distill": 8000}


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


def _cards_text(cards: list) -> str:
    out, used = [], 0
    for c in cards if isinstance(cards, list) else []:
        if not isinstance(c, dict) or not isinstance(c.get("card"), dict):
            continue
        item = (f"{'[NEW]' if c.get('new') else '[old]'} session={_line(c.get('session'), 40)} date={_line(c.get('date'), 10)} "
                f"project={_line(c.get('project'), 80)}\n{json.dumps(c['card'], ensure_ascii=False)}")
        if used + len(item) > CARDS_CHARS:
            break
        out.append(item)
        used += len(item)
    return "\n\n".join(out)


def _distill_parts(b: dict, index: str) -> list[str]:
    agents = b.get("agents") if isinstance(b.get("agents"), dict) else {}
    parts = [f"<cards>\n{_cards_text(b.get('cards')) or '(none)'}\n</cards>"]
    if b.get("old_summary"):
        parts.append(f"<older_cards_in_short>\n{_clip(json.dumps(b['old_summary'], ensure_ascii=False), 20000)}\n</older_cards_in_short>")
    parts.append(f"<memory_index>\n{index or '(no memories yet)'}\n</memory_index>")
    for scope in ("user", "project"):
        parts.append(f"<agents_md scope=\"{scope}\">\n{_clip(agents.get(scope), RULES_CHARS) or '(none)'}\n</agents_md>")
    parts.append(f"<skills>\n{_clip(json.dumps(b.get('skills') or [], ensure_ascii=False), 10000)}\n</skills>")
    parts.append(f"<accepted_before>\n{_clip(json.dumps(b.get('accepted') or [], ensure_ascii=False), 20000)}\n</accepted_before>")
    parts.append(f"<never_suggest>\n{_clip(json.dumps(b.get('never') or [], ensure_ascii=False), 10000)}\n</never_suggest>")
    parts.append(f"The current project is \"{_line(b.get('project'), 80)}\".")
    return parts


def prompt_for(kind: str, b: dict) -> str:
    idx = b.get("indexes") if isinstance(b.get("indexes"), dict) else {}
    index = "\n\n".join(f"{scope} index:\n{str(idx.get(scope) or '(empty)')[:20000]}" for scope in ("user", "project", "global")
                        if scope in idx)
    today = re.sub(r"[^\d-]", "", str(b.get("today") or ""))[:10]
    parts = []
    if kind in ("propose", "digest"):
        parts.append(f"<transcript>\n{_clip(b.get('transcript'), TRANSCRIPT_CHARS)}\n</transcript>")
    if kind == "propose":
        parts.append(f"<memory_index>\n{index or '(no memories yet)'}\n</memory_index>")
    if kind == "distill":
        parts += _distill_parts(b, index)
    if kind != "digest":
        parts.append(f"<memories_in_full>\n{_memories_text(b.get('memories')) or '(none)'}\n</memories_in_full>")
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


def _list(v) -> list:
    return v if isinstance(v, list) else []


def card(d: dict) -> dict:
    return {
        "goal": _line(d.get("goal")), "category": _line(d.get("category"), 40),
        "outcome": d.get("outcome") if d.get("outcome") in OUTCOMES else "unknown",
        "feedback": [{"after": _line(f.get("after"), 200), "type": f.get("type") if f.get("type") in FEEDBACK else "unknown",
                      "quote": _line(f.get("quote"), 300)} for f in _list(d.get("feedback")) if isinstance(f, dict)][:12],
        "corrections": [q for q in (_line(x, 400) for x in _list(d.get("corrections"))) if q][:8],
        "friction": [q for q in (_line(x, 40) for x in _list(d.get("friction"))) if q][:8],
        "failures": [{k: _line(f.get(k), 300) for k in ("symptom", "cause", "fix")}
                     for f in _list(d.get("failures")) if isinstance(f, dict)][:5],
    }


def _target(kind: str, t) -> str:
    t = str(t or "").strip()
    if kind == "memory":
        return t if t in SCOPES else ""
    if kind == "rule":
        return t if t in ("user-agents", "project-agents") else ""
    if kind == "skill":
        name = _name(t[6:]) if t.startswith("skill:") else ""
        return f"skill:{name}" if name else ""
    return t[:60]


def items(d: dict) -> list[dict]:
    out, count = [], {k: 0 for k in ITEM_KINDS}
    for i in _list(d.get("items")):
        if not isinstance(i, dict) or i.get("kind") not in ITEM_KINDS:
            continue
        kind = i["kind"]
        item = {"kind": kind, "op": "update" if i.get("op") == "update" else "add", "target": _target(kind, i.get("target")),
                "name": _name(i.get("name")), "description": _line(i.get("description")),
                "content": str(i.get("content") or "").strip()[:12000], "reason": _line(i.get("reason"), 400),
                "evidence": [{"session": _line(e.get("session"), 40), "date": _line(e.get("date"), 10), "quote": _line(e.get("quote"), 400)}
                             for e in _list(i.get("evidence")) if isinstance(e, dict)][:12]}
        if kind == "skill":
            item["name"] = item["target"][6:]
        if not item["content"] or (kind != "habit" and not (item["target"] and item["name"])) or count[kind] >= MAX_ITEMS[kind]:
            continue
        count[kind] += 1
        out.append(item)
    return out


def recurrence(d: dict) -> list[dict]:
    return [{"item": _line(r.get("item"), 200), "seen_again": r.get("seen_again") is True, "evidence": _line(r.get("evidence"), 400)}
            for r in _list(d.get("recurrence")) if isinstance(r, dict) and r.get("item")][:20]


def mount(app: FastAPI, cfg: Config, client: httpx.AsyncClient, audit) -> None:

    @app.post("/v1/ferry/memory-review")
    async def memory_review(request: Request):
        started = time.time()
        b = json.loads(await request.body() or b"{}")
        kind = str(b.get("kind") or "")
        if kind not in KINDS:
            return JSONResponse({"error": f"kind must be one of {', '.join(KINDS)}"}, 400)
        if kind in ("propose", "digest") and not str(b.get("transcript") or "").strip():
            return JSONResponse({"error": "the transcript is empty"}, 400)
        if kind == "distill" and not _cards_text(b.get("cards")):
            return JSONResponse({"error": "no cards"}, 400)
        cur = current_model(cfg, str(b.get("model") or ""))
        chosen = cur if kind == "distill" else cheap_model(cfg, cur)  # distill needs the stronger model; one call per run
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
            if kind == "digest":
                return {"card": card(d), "model": m.id}
            if kind == "distill":
                return {"items": items(d), "recurrence": recurrence(d), "model": m.id}
            return {"operations": operations(d), "model": m.id}
        audit(event="chat", user=request.state.user, purpose="memory", model=chosen.id, status=502, error=repr(last)[:200])
        return JSONResponse({"error": f"no model answered: {last!r}"[:400]}, 502)
