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


def decide_agent(msgs):
    system = text_of(msgs[0]) if msgs else ""
    system += " ".join(text_of(m) for m in msgs if m.get("role") in ("system", "developer"))
    last_user = max([i for i, m in enumerate(msgs) if m.get("role") == "user"], default=0)
    tools = [m for m in msgs[last_user:] if m.get("role") == "tool"]  # this request's tool results
    first = text_of(msgs[last_user]) if msgs else ""  # the latest user message picks the scenario
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
        return ("text", "EDIT: " + text_of(tools[-1])[:80])
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


class H(BaseHTTPRequestHandler):
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
