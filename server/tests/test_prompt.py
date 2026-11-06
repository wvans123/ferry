from ferry_server.prompt import SUMMARY_NOTES, TRIM_NOTE, apply_rules, body_size, cap_upstream, summary_rules


def convo(n_tools: int, tool_bytes: int) -> dict:
    msgs = [{"role": "system", "content": "sys"}, {"role": "user", "content": "do it"}]
    for i in range(n_tools):
        msgs.append({"role": "assistant", "content": None, "tool_calls": [
            {"id": f"c{i}", "type": "function", "function": {"name": "read", "arguments": "{}"}}]})
        msgs.append({"role": "tool", "tool_call_id": f"c{i}", "content": "x" * tool_bytes})
    return {"model": "main", "messages": msgs}


def test_no_cap_or_small_request_untouched():
    p = convo(3, 100)
    assert cap_upstream(p, 0) == (0, body_size(p))
    assert cap_upstream(p, 10_000)[0] == 0


def test_trims_oldest_tool_outputs_first_and_stops_under_cap():
    p = convo(10, 10_000)
    trimmed, size = cap_upstream(p, 60_000)
    assert size <= 60_000 and trimmed > 0
    tools = [m for m in p["messages"] if m["role"] == "tool"]
    assert all(t["content"] == TRIM_NOTE for t in tools[:trimmed])        # oldest first
    assert all(t["content"] != TRIM_NOTE for t in tools[trimmed:])        # newer ones kept
    assert p["messages"][1]["content"] == "do it"                         # user message untouched


def test_recent_messages_are_never_trimmed():
    p = convo(3, 50_000)                                                  # 6 newest messages hold all tool outputs
    trimmed, size = cap_upstream(p, 10_000)
    assert trimmed == 0 and size > 10_000                                 # caller then answers 413


def test_rules_appended_to_system_prompt():
    p = {"messages": [{"role": "system", "content": "base"}, {"role": "user", "content": "hi"}]}
    apply_rules(p, "- be brief")
    assert p["messages"][0]["content"].startswith("base") and "<server-rules>" in p["messages"][0]["content"]


def test_every_summary_keeps_the_same_things_and_the_owners_file_comes_after(tmp_path):
    assert summary_rules(None) == SUMMARY_NOTES and summary_rules(tmp_path) == SUMMARY_NOTES
    (tmp_path / "_summary.md").write_text("Keep the 3GPP TS numbers.\n", encoding="utf-8")
    text = summary_rules(tmp_path)
    assert text.startswith(SUMMARY_NOTES) and text.endswith("Keep the 3GPP TS numbers.")
    for word in ("user's own messages", "confidentiality", "next step"):
        assert word in SUMMARY_NOTES
