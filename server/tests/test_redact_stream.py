import asyncio
import json
from collections import Counter
from pathlib import Path

import pytest

from ferry_server.redact import PH_RE, Redactor, StreamUnmasker
from ferry_server.store import Store
from ferry_server.stream import restore_sse

DICT = '''
terms = ["Project Titan", "internal-host-01"]
[[patterns]]
name = "email"
regex = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}'
'''


@pytest.fixture
def red(tmp_path: Path) -> Redactor:
    d = tmp_path / "dict.toml"
    d.write_text(DICT, encoding="utf-8")
    return Redactor(d, "secret", Store(tmp_path / "t.db"))


def test_mask_roundtrip_and_deterministic(red):
    hits = Counter()
    text = "Read Project Titan/notes.txt and mail bob@corp.example about internal-host-01"
    masked = red.mask(text, hits, "u1")
    for s in ("Project Titan", "bob@corp.example", "internal-host-01"):
        assert s not in masked
    assert hits == {"term": 2, "email": 1}
    assert red.mask(text, Counter(), "u1") == masked    # same input, same placeholders
    assert red.mask(masked, Counter(), "u1") == masked  # placeholders are never re-masked
    assert red.unmask(masked, "u1") == text


def test_case_insensitive_terms_keep_original_spelling(red):
    masked = red.mask("project titan", Counter(), "u1")
    assert "titan" not in masked
    assert red.unmask(masked, "u1") == "project titan"


def test_unknown_placeholder_left_alone(red):
    assert red.unmask("see [FERRY-AAAAAAAA]", "u1") == "see [FERRY-AAAAAAAA]"


def test_other_user_cannot_restore(red):
    masked = red.mask("Project Titan", Counter(), "u1")
    assert red.unmask(masked, "u2") == masked           # u2 never sent it, so u2 gets the placeholder back
    assert red.unmask(masked, "u1") == "Project Titan"


@pytest.mark.parametrize("size", [1, 2, 3, 5, 7, 16])
def test_stream_unmasker_any_split(red, size):
    original = "path: Project Titan/a.txt, host internal-host-01 [not a placeholder] end ["
    masked = red.mask(original, Counter(), "u1")
    u = StreamUnmasker(red, "u1")
    out = "".join(u.feed(masked[i:i + size]) for i in range(0, len(masked), size)) + u.flush()
    assert out == original


def test_stream_unmasker_releases_early(red):
    u = StreamUnmasker(red, "u1")
    assert u.feed("hello wor") == "hello wor"           # nothing held without a '['
    assert u.feed("ld [FER") == "ld "                   # only the possible prefix is held
    assert u.feed("x") == "[FERx"                       # not a placeholder after all


def sse_lines(chunks):
    async def gen():
        for c in chunks:
            yield "data: " + json.dumps(c)
            yield ""
        yield "data: [DONE]"
    return gen()


def run(agen):
    async def collect():
        return [b async for b in agen]
    return asyncio.run(collect())


def parse(out):
    return [json.loads(b.decode()[6:]) for b in out if not b.startswith(b"data: [DONE]")]


def test_restore_sse_text_and_tool_args(red):
    ph = red.mask("Project Titan", Counter(), "u1")
    args = json.dumps({"path": f"{ph}/notes.txt"})
    text = f"Opening {ph} now"
    chunks = [{"id": "1", "choices": [{"index": 0, "delta": {"role": "assistant", "content": text[i:i + 3]}}]}
              for i in range(0, len(text), 3)]
    chunks.append({"id": "1", "choices": [{"index": 0, "delta": {"tool_calls": [
        {"index": 0, "id": "c1", "type": "function", "function": {"name": "read", "arguments": args[:10]}}]}}]})
    chunks.append({"id": "1", "choices": [{"index": 0, "delta": {"tool_calls": [
        {"index": 0, "function": {"arguments": args[10:]}}]}}]})
    chunks.append({"id": "1", "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
                   "usage": {"prompt_tokens": 5}})
    usage = {}
    out = parse(run(restore_sse(sse_lines(chunks), red, usage, "u1")))
    content = "".join(c["choices"][0]["delta"].get("content", "") for c in out if c.get("choices"))
    arg_text = "".join(tc["function"].get("arguments", "") for c in out if c.get("choices")
                       for tc in c["choices"][0]["delta"].get("tool_calls", []))
    assert content == "Opening Project Titan now"
    assert json.loads(arg_text) == {"path": "Project Titan/notes.txt"}
    text_chunks = [c for c in out if c.get("choices") and c["choices"][0]["delta"].get("content")]
    assert len(text_chunks) >= 3                         # still streamed in pieces, not one blob
    assert out[-1]["choices"][0]["finish_reason"] == "tool_calls"   # finish comes after the restored args
    assert usage == {"prompt_tokens": 5}
    assert not any(PH_RE.search(json.dumps(c)) for c in out)
