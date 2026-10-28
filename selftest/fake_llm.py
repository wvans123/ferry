"""A fake OpenAI-compatible model for end-to-end tests. Logs every request body it receives.

usage: python fake_llm.py <log file> <mode> [port]
  basic   turn 1: read "<first placeholder in the user message>/notes.txt"; turn 2: echo the file back
  edit    read "<placeholder>/notes.txt", replace its ticket number, then report (a three-round task)
  bash    turn 1: run "echo ferry-approved-$((6*7))"; turn 2: echo the command output back
  long:N  read data/f00.txt ... data/f{N-1}.txt one per turn, then answer "READ N FILES"
  agent   client agent features, chosen by a keyword in the user message:
          MEMTEST-SAVE / MEMTEST-RECALL (memory), TASKTEST (subagent), BIGTEST (long output), TODOTEST (task list)
Always answers context-summarization requests with a fixed summary.
Strict like some real providers: rejects "store" and "max_completion_tokens" with HTTP 400.
Streams text in 3-character pieces and tool arguments in two pieces.
"""
import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG, MODE = sys.argv[1], sys.argv[2]
PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 9100
state = {"next_file": 0}
REJECT = ("store", "max_completion_tokens")


def text_of(m):
    c = m.get("content")
    if isinstance(c, list):
        return " ".join(p.get("text", "") for p in c if isinstance(p, dict))
    return c or ""


def decide(msgs):
    if msgs and text_of(msgs[-1]) == "Reply with OK":  # ferry doctor's model check
        return ("text", "OK")
    if msgs and "context summarization assistant" in text_of(msgs[0]):
        return ("text", "## Goal\nRead files in data/.\n## Progress\nSome files read.")
    if MODE == "basic":
        tool_msgs = [m for m in msgs if m.get("role") == "tool"]
        if not tool_msgs:
            user = [text_of(m) for m in msgs if m.get("role") == "user"][-1]
            ph = re.search(r"\[FERRY-[A-Z2-7]{8}\]", user)
            return ("tool", "read", {"path": (ph.group(0) if ph else "NOPLACEHOLDER") + "/notes.txt"})
        return ("text", "FILE SAYS: " + text_of(tool_msgs[-1])[:400])
    if MODE == "edit":  # a realistic three-round task: read, edit, then report
        tool_msgs = [m for m in msgs if m.get("role") == "tool"]
        user = [text_of(m) for m in msgs if m.get("role") == "user"][-1]
        ph = re.search(r"\[FERRY-[A-Z2-7]{8}\]", user)
        path = (ph.group(0) if ph else "NOPLACEHOLDER") + "/notes.txt"
        if len(tool_msgs) == 0:
            return ("tool", "read", {"path": path})
        if len(tool_msgs) == 1:
            ticket = re.findall(r"\[FERRY-[A-Z2-7]{8}\]", text_of(tool_msgs[0]))[-1]
            return ("tool", "edit", {"path": path, "edits": [{"oldText": f"ticket {ticket}", "newText": "ticket EMP-99999"}]})
        return ("text", "Done: the ticket number in notes.txt is now EMP-99999.")
    if MODE == "bash":
        tool_msgs = [m for m in msgs if m.get("role") == "tool"]
        if not tool_msgs:
            return ("tool", "bash", {"command": "echo ferry-approved-$((6*7))"})
        return ("text", "COMMAND SAYS: " + text_of(tool_msgs[-1])[:200])
    if MODE == "agent":
        return decide_agent(msgs)
    n = int(MODE.split(":")[1])
    i = state["next_file"]
    if i < n:
        state["next_file"] += 1
        return ("tool", "read", {"path": f"data/f{i:02d}.txt"})
    return ("text", f"READ {n} FILES")


def decide_goal(msgs):
    """A /goal run: write note1..3 over several turns (stopping after each), then report the goal achieved."""
    calls = [tc["function"]["name"] for m in msgs if m.get("role") == "assistant" for tc in (m.get("tool_calls") or [])]
    last = msgs[-1]
    if "goal_update" in calls:
        return ("text", "GOAL REPORT: all three notes written and checked")
    writes = calls.count("write")
    if last.get("role") == "tool":
        return ("text", f"wrote note{writes}")  # end the turn; Ferry should send the agent on
    if writes < 3:
        return ("tool", "write", {"path": f"goal-note{writes + 1}.txt", "content": f"note {writes + 1}\n"})
    return ("tool", "goal_update", {"status": "achieved", "summary": "three notes written", "evidence": "goal-note1..3.txt exist"})


def decide_agent(msgs):
    system = text_of(msgs[0]) if msgs else ""
    system += " ".join(text_of(m) for m in msgs if m.get("role") in ("system", "developer"))
    last_user = max([i for i, m in enumerate(msgs) if m.get("role") == "user"], default=0)
    tools = [m for m in msgs[last_user:] if m.get("role") == "tool"]  # this request's tool results
    first = text_of(msgs[last_user]) if msgs else ""  # the latest user message picks the scenario
    if any("GOALTEST" in text_of(m) for m in msgs if m.get("role") == "user"):
        return decide_goal(msgs)
    if "<ferry_subagent>" in system:  # a subagent's own conversation
        if "SUBRUN" in first:  # a general subagent that runs a command (needs the user's approval)
            if not tools:
                return ("tool", "bash", {"command": "echo sub-approved-$((6*7))"})
            return ("text", "WORKER REPORT: " + text_of(tools[-1])[:60])
        if not tools:
            return ("tool", "ls", {"path": "data"})
        if len(tools) == 1:
            return ("tool", "read", {"path": "data/f03.txt", "limit": 2})
        return ("text", "EXPLORE REPORT: data has files; f03 starts with " + text_of(tools[-1])[:24])
    if "MEMTEST-SAVE" in first:
        if not tools:
            return ("tool", "memory", {"action": "save", "scope": "project", "name": "test-db",
                                       "description": "integration tests use the real database",
                                       "content": "Integration tests must hit the real database, never mocks."})
        return ("text", "SAVED: " + text_of(tools[-1]))
    if "MEMTEST-RECALL" in first:
        return ("text", "INDEX HAS test-db" if "[test-db](test-db.md)" in system else "NO MEMORY")
    if "SUBBGTEST" in first:
        if not tools:
            return ("tool", "task", {"agent": "explore", "description": "look around", "background": True,
                                     "prompt": "List the data folder and read the start of f03.txt."})
        return ("text", "BG: " + text_of(tools[-1])[:120])
    if "TASKTEST" in first:
        if not tools:
            return ("tool", "task", {"agent": "explore", "description": "look at the data folder",
                                     "prompt": "List the data folder and read the start of f03.txt."})
        return ("text", "MAIN GOT: " + text_of(tools[-1])[:300])
    if "BROWSERTEST" in first:
        if not tools:
            return ("tool", "mcp__browser__browser_navigate", {"url": "http://127.0.0.1:9100/page.html"})
        if len(tools) == 1:
            return ("tool", "mcp__browser__browser_snapshot", {})
        return ("text", "BROWSER: " + ("pelican-42" if "pelican-42" in text_of(tools[-1]) else text_of(tools[-1])[:200]))
    if "PASTTEST" in first:  # the user asks about another conversation
        if not tools:
            return ("tool", "past_conversations", {"action": "search", "query": "DIYCMD"})
        if len(tools) == 1:
            return ("tool", "past_conversations", {"action": "read", "conversation": "1"})
        return ("text", "PAST: " + ("found greet Wesley" if "DIYCMD greet Wesley" in text_of(tools[-1]) else text_of(tools[-1])[:300]))
    if "MCPTEST" in first:  # a project's own MCP server
        if not tools:
            return ("tool", "mcp__notes__notes_lookup", {"key": "build"})
        return ("text", "MCP: " + text_of(tools[-1])[:160])
    if "DIYCMD greet" in first:  # a user's own slash command, expanded by the client
        return ("text", "DIY: " + first.split("DIYCMD greet", 1)[1].strip()[:40])
    if "GATETEST" in first:
        if not tools:
            return ("tool", "web_fetch", {"url": "http://127.0.0.1:9100/gated"})
        return ("text", "GATE: " + text_of(tools[-1])[:160])
    if "IMGTEST" in first:  # the agent reads a picture file; a vision model gets the picture itself
        if not tools:
            return ("tool", "read", {"path": "pic.png"})
        return ("text", "IMG: " + ("picture received" if "[an image]" in text_of(tools[-1]) else "no picture: " + text_of(tools[-1])[:80]))
    if "WEBTEST" in first:
        if not tools:
            return ("tool", "web_search", {"query": "ferry"})
        if len(tools) == 1:
            url = re.search(r"https?://\S+", text_of(tools[0]))
            return ("tool", "web_fetch", {"url": url.group(0) if url else "none"})
        return ("text", "WEB: " + text_of(tools[-1]).replace("\n", " ")[:200])
    if "PERMTEST" in first:  # a command that is not read-only, so it needs permission
        if not tools:
            return ("tool", "bash", {"command": "touch perm-ok.txt && echo touched"})
        return ("text", "PERM: " + text_of(tools[-1])[:80])
    if "EDITTEST" in first:
        if not tools:
            return ("tool", "write", {"path": "made-by-agent.txt", "content": "hello\n"})
        return ("text", "EDIT: " + text_of(tools[-1])[:400].replace("\n", " | "))
    if "JOBTEST" in first:
        if not tools:
            return ("tool", "job_start", {"command": "for i in 1 2 3; do echo tick-$i; sleep 0.4; done; echo ticker-done", "name": "ticker"})
        if len(tools) == 1:
            return ("tool", "job_output", {"id": 1})
        return ("text", "JOB: " + text_of(tools[-1]).replace("\n", " | ")[:200])
    if "GENTEST" in first:
        if not tools:
            return ("tool", "task", {"agent": "general", "description": "run a check command",
                                     "prompt": "SUBRUN: run the check command and report its output."})
        return ("text", "MAIN GOT: " + text_of(tools[-1])[:300])
    if "BIGTEST" in first:
        if not tools:
            return ("tool", "bash", {"command": "for i in $(seq 1 3000); do echo \"output line $i\"; done"})
        t = text_of(tools[-1])
        return ("text", f"BIG: saved={'Full text saved to' in t} size={len(t)} last={'output line 3000' in t}")
    if "TODOTEST" in first:
        if not tools:
            return ("tool", "todo", {"todos": [{"content": "step one", "status": "completed"},
                                               {"content": "step two", "status": "in_progress"}]})
        return ("text", "TODO: " + text_of(tools[-1]).replace("\n", " | "))
    return ("text", "OK")


def anthropic_problems(body, headers):
    """What a strict Messages API would reject in this request."""
    problems = []
    if headers.get("x-api-key") != "x":
        problems.append("wrong x-api-key")
    if not str(body.get("model", "")).startswith("claude-"):
        problems.append(f"model {body.get('model')!r}")
    if "ferry" in body:
        problems.append("ferry field leaked")
    every = body.get("messages", [])
    # mid-conversation system messages: only empty ones that set the thinking effort (pi sends them for Claude)
    if any(m.get("role") == "system" and (m.get("content") or not (m.get("output_config") or {}).get("effort")) for m in every):
        problems.append("system message that is not an effort marker")
    msgs = [m for m in every if m.get("role") != "system"]
    if not msgs or msgs[0].get("role") != "user":
        problems.append("first message is not a user message")
    if any(m.get("role") not in ("user", "assistant") for m in msgs):
        problems.append("role other than user/assistant/system")
    if any(a.get("role") == b.get("role") for a, b in zip(msgs, msgs[1:])):
        problems.append("roles do not alternate")
    marks = json.dumps(body).count('"cache_control"')
    if marks > 4:
        problems.append(f"{marks} cache_control markers")
    return problems


def anthropic_to_openai(body):
    """The Anthropic request as OpenAI-style messages, so the same decide() drives both."""
    system = body.get("system")
    text = system if isinstance(system, str) else " ".join(b.get("text", "") for b in (system or []))
    out = [{"role": "system", "content": text}]
    for m in body.get("messages", []):
        if m["role"] == "system":  # an effort marker
            continue
        blocks = m["content"] if isinstance(m["content"], list) else [{"type": "text", "text": m["content"]}]
        if m["role"] == "assistant":
            calls = [{"id": b["id"], "type": "function", "function": {"name": b["name"], "arguments": json.dumps(b.get("input", {}))}}
                     for b in blocks if b.get("type") == "tool_use"]
            out.append({"role": "assistant", "content": " ".join(b.get("text", "") for b in blocks if b.get("type") == "text"),
                        **({"tool_calls": calls} if calls else {})})
            continue
        texts = []
        for b in blocks:
            if b.get("type") == "tool_result":
                c = b.get("content")
                c = c if isinstance(c, str) else " ".join(x.get("text", "") if x.get("type") == "text" else "[an image]"
                                                          for x in (c or []) if isinstance(x, dict))
                out.append({"role": "tool", "tool_call_id": b.get("tool_use_id"), "content": c})
            elif b.get("type") == "text":
                texts.append(b["text"])
            elif b.get("type") == "image":
                texts.append("[an image]")
        if texts:
            out.append({"role": "user", "content": " ".join(texts)})
    return out


class H(BaseHTTPRequestHandler):
    def anthropic(self, body, raw):
        problems = anthropic_problems(body, self.headers)
        if problems:
            return self.send_json(400, {"type": "error", "error": {"type": "invalid_request_error", "message": "; ".join(problems)}})
        kind, *rest = decide(anthropic_to_openai(body))
        size = len(raw) // 4
        marked = '"cache_control"' in json.dumps(body.get("messages", []))
        usage = {"input_tokens": 10, "cache_read_input_tokens": size - 60 if marked else 0,
                 "cache_creation_input_tokens": 50 if marked else size - 10, "output_tokens": 0}
        events = [("message_start", {"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant",
                                                                           "model": body["model"], "content": [], "stop_reason": None,
                                                                           "usage": usage}})]
        if kind == "text":
            text = rest[0]
            events.append(("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}))
            for i in range(0, len(text), 3):
                events.append(("content_block_delta", {"type": "content_block_delta", "index": 0,
                                                       "delta": {"type": "text_delta", "text": text[i:i + 3]}}))
            stop = "end_turn"
        else:
            name, args = rest
            a = json.dumps(args)
            events.append(("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {
                "type": "tool_use", "id": f"toolu_{name}_{len(body['messages'])}", "name": name, "input": {}}}))
            for part in (a[:12], a[12:]):
                events.append(("content_block_delta", {"type": "content_block_delta", "index": 0,
                                                       "delta": {"type": "input_json_delta", "partial_json": part}}))
            stop = "tool_use"
        events += [("content_block_stop", {"type": "content_block_stop", "index": 0}),
                   ("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop}, "usage": {"output_tokens": 7}}),
                   ("message_stop", {"type": "message_stop"})]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for ev, data in events:
            self.wfile.write(f"event: {ev}\ndata: {json.dumps(data)}\n\n".encode())

    def log_message(self, *a):
        pass

    def send_json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_html(self, text):
        data = text.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # the provider's model list, for the admin page's "fetch models"
        if self.path.startswith("/search"):  # a Bing-like results page, for web_search
            return self.send_html('<ol><li class="b_algo"><h2><a href="http://127.0.0.1:9100/page.html">Ferry test page</a>'
                                  '</h2><div class="b_caption"><p>A page about ferries.</p></div></li></ol>')
        if self.path == "/gated":  # a site the company gateway wants confirmed first
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:9100/proxycontrolwarn?url=gated")
            self.end_headers()
            return
        if self.path == "/page.html":
            return self.send_html("<html><head><title>Ferry page</title><script>var x=1;</script></head><body>"
                                  "<h1>Ferry</h1><p>The secret word is <b>pelican-42</b>.</p>"
                                  "<a href='/next'>next</a></body></html>")
        if self.path.rstrip("/").endswith("/models"):
            return self.send_json(200, {"object": "list", "data": [{"id": "fake-small"}, {"id": "fake-large"}]})
        self.send_json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        body = json.loads(raw)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(body, ensure_ascii=False) + "\n")
        if self.path.endswith("/v1/messages"):
            return self.anthropic(body, raw)
        bad = [k for k in REJECT if k in body]
        if bad:
            return self.send_json(400, {"error": {"message": f"unsupported parameter: {bad[0]}"}})
        kind, *rest = decide(body.get("messages", []))
        base = {"id": "x1", "object": "chat.completion.chunk", "created": int(time.time()), "model": "fake"}
        usage = {"prompt_tokens": len(raw) // 4, "completion_tokens": 5, "total_tokens": len(raw) // 4 + 5}
        if kind == "text":
            text = rest[0]
            deltas = [{"role": "assistant", "content": ""}] + [{"content": text[i:i + 3]} for i in range(0, len(text), 3)]
            finish, message = "stop", {"role": "assistant", "content": text}
        else:
            name, args = rest
            a = json.dumps(args)
            call_id = f"call_{name}_{state['next_file']}"
            deltas = [
                {"role": "assistant", "tool_calls": [{"index": 0, "id": call_id, "type": "function",
                                                      "function": {"name": name, "arguments": a[:12]}}]},
                {"tool_calls": [{"index": 0, "function": {"arguments": a[12:]}}]},
            ]
            finish = "tool_calls"
            message = {"role": "assistant", "content": None,
                       "tool_calls": [{"id": call_id, "type": "function", "function": {"name": name, "arguments": a}}]}
        if not body.get("stream"):
            return self.send_json(200, {**base, "object": "chat.completion", "usage": usage,
                                        "choices": [{"index": 0, "message": message, "finish_reason": finish}]})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for d in deltas:
            self.wfile.write(f"data: {json.dumps({**base, 'choices': [{'index': 0, 'delta': d, 'finish_reason': None}]})}\n\n".encode())
        last = {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}], "usage": usage}
        self.wfile.write(f"data: {json.dumps(last)}\n\ndata: [DONE]\n\n".encode())


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
