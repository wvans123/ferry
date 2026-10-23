"""A fake OpenAI-compatible model for end-to-end tests. Logs every request body it receives.

usage: python fake_llm.py <log file> <mode> [port]
  basic   turn 1: read "<first placeholder in the user message>/notes.txt"; turn 2: echo the file back
  edit    read "<placeholder>/notes.txt", replace its ticket number, then report (a three-round task)
  bash    turn 1: run "echo ferry-approved-$((6*7))"; turn 2: echo the command output back
  long:N  read data/f00.txt ... data/f{N-1}.txt one per turn, then answer "READ N FILES"
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
    n = int(MODE.split(":")[1])
    i = state["next_file"]
    if i < n:
        state["next_file"] += 1
        return ("tool", "read", {"path": f"data/f{i:02d}.txt"})
    return ("text", f"READ {n} FILES")


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
