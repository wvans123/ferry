# Ferry: notes for Claude sessions

This file is the project's memory. Every Claude session (cloud, desktop, local) reads it at start, so
anything a later session must know goes here, not only in a chat. Keep it short and current; history
lives in git log and docs/AGENT-GOAL.md.

## What Ferry is

A Claude-Code-style coding agent for locked-down Windows work PCs. `client/` (Node 22, built on the pi
agent engine via its public extension API, never forked) runs on the work PC; `server/` (Python FastAPI)
holds the API keys, rebuilds the full conversation from small incremental uploads (every request from
the PC stays under 1 MB) and calls the model. Start with README.md, then docs/DESIGN.md (protocol and
code map).

## The owner and their setup

- Speaks Chinese; answer in Chinese. User-facing docs are plain Chinese: short sentences, no AI tone
  (no "不是…而是…", no slogans, no em dashes, little bold). Code, comments and commit messages in English.
- Work PC: Windows, company proxy that inspects HTTPS, a gateway that sometimes asks for a confirmation
  page. Ferry server: their Mac (also a Windows desktop, D:\ferry\server), reached through Cloudflare Tunnel.
- Real work done with Ferry: telecom standards (3GPP specs and contributions: download, read, Word with
  tracked changes), research, documents, code.
- Taste: fewer parts. Do it the way Cursor / Claude Code do it before inventing a new tool or setting.
  Features that do not pay for themselves get deleted.

## Removed on purpose (do not bring back without asking)

| Removed | Version | Why |
|---|---|---|
| Playwright MCP browser (`@playwright/mcp`) | 0.27 | replaced by agent-browser: a CLI the agent calls with bash plus a skill, no tool definitions, compact snapshots |
| redaction (placeholders, word list, stream restoring) | 0.26 | off by default, never worked with Claude's own API, owner did not use it; /report keeps a small filter of its own |
| server-side web access (`web = server`, FERRY_WEB) | 0.26 | web tools run on the work PC since 0.11; nobody used the server path. (0.29/0.30 search on the server is different: only the query or the page's text goes there, pages are still fetched on the PC) |
| web_download tool | 0.24 | the agent downloads with curl like Cursor; commands get ferry's CA bundle and proxy |
| web_render (Electron) and `ferry install-electron` | 0.24 | hardly needed, 100 MB download |
| phone console `/m`, status reports, phone approvals | 0.24 | only showed titles; Bark notifications are enough |
| guessing vision support from the model name | 0.24 | every model takes pictures unless `vision = false` |
| gateway check on a 10-minute timer | 0.22.4 | the page opens only when a request is blocked, or on `ferry check` |
| auto permission mode (judge model) | 0.20, server part 0.25 | reason not recorded; Paperclip members use acceptEdits instead |

## How a change ships

Every feature is a module (docs/MODULES.md): one file per side, one line to plug it in, its own settings, tests,
F check and docs section. Add or remove a feature by adding or removing its module. Prefer a command-line tool plus a
skill file (the agent calls it with bash) over a new tool definition.


1. One module per change; test that module, then run everything before a release:
   `pytest server/tests`, `node --test "client/test/*.test.mjs"`, `python selftest/run.py`
   (end-to-end with a fake model, fake proxy and fake gateway; no keys needed; takes several minutes).
2. A user-visible behaviour gets an end-to-end check in selftest/run.py with the next free F number,
   listed in GOAL.md.
3. Release = bump the version in package.json, package-lock.json, server/pyproject.toml and
   server/ferry_server/__init__.py. CI on main tests on Linux and Windows and publishes the offline
   Windows package; `ferry update` picks it up.
4. Commit title `Ferry x.y.z: what changed for the user`, body as short bullets. Update GOAL.md
   ("最近一次结果") and add a `## vX.Y` table to docs/AGENT-GOAL.md (问题 / 改了什么 / 自测).
5. User docs: README.md is the short entry page; details go in docs/USAGE.md (users) and
   docs/SERVER.md (server). Do not let README grow back into a manual.

6. Before a release that changes how the agent works, the owner runs `python evals/run.py` on their Windows PC
   (real DeepSeek) and pushes the result file in evals/results/; compare it with the previous one. Keep
   `python evals/run.py --verify` passing when tasks change.

Work comes from real problems: `/report` in ferry turns one into a GitHub issue (posted by the owner's Ferry
server, label-free, title starts with `[report]`). Take one issue per branch / PR. A real failure that can be
reproduced with made-up content becomes a new task in evals/tasks/.

Branches: main for Ferry itself; DSH / Codex / Claude Code integrations on `integrations`
(docs/ROADMAP.md).

## Where earlier context is

- git log (detailed commit bodies) and docs/AGENT-GOAL.md (every version: problem, change, test).
- docs/ROADMAP.md: plan and what is still missing.
- Earlier conversations were Claude Cowork cloud sessions; the commit trailers link to them.
