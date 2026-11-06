# Ferry: notes for Claude sessions

This file is the project's memory. Every Claude session (cloud, desktop, local) reads it at start, so
anything a later session must know goes here, not only in a chat. Keep it short and current; history
lives in merged PRs and git log.

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
| server-side web access (`web = server`, FERRY_WEB) | 0.26 | web tools run on the work PC since 0.11; nobody used the server path. Brought back in 0.30 at the owner's request in another form: search and public pages on the server (only the address goes up), intranet/private addresses still on the PC |
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


Keep each change small and cheap: tokens go into reading big files and waiting for tests, so do neither more than
the change needs.

1. One issue or one module per change; a PR may also cover several related issues or small fixes. Start a fresh
   branch from the current main (`claude/<short-name>`); never keep adding to an old branch. One branch, one PR; a
   feature PR does not bump the version. Squash-merge it once CI is green and delete the branch.
2. Read only what the module needs: its own files, the one line that plugs it in, docs/MODULES.md. Do not read the
   big shared files whole (selftest/run.py, server/ferry_server/admin.html, app.py, client/bin/ferry.mjs,
   package-lock.json): grep for the spot you change and read that range.
3. Test locally only what changed: the module's unit tests (`pytest server/tests/test_<name>.py`,
   `node --test client/test/<name>.test.mjs`) and its end-to-end checks, `python selftest/run.py --only F66,F67`
   (`--list` shows which step holds which F; one step takes seconds). The full run (all unit tests and the whole
   self-test on Linux and Windows, about 7 minutes) is CI's job on the pull request; do not repeat it locally. Do not
   sit waiting for it either: open the PR, go on with other work or end the turn, and read the result when it is done
   (fix it if it is red).
4. A user-visible behaviour gets an end-to-end check in selftest/run.py with the next free F number, listed in GOAL.md.
5. Releases are batched: features collect on main, and when the owner wants the work PC updated, one small release
   PR runs `python scripts/bump.py x.y.z` (package.json, package-lock.json, server/pyproject.toml,
   server/ferry_server/__init__.py) and nothing else. Merging it publishes: CI skips tests that already passed on the
   PR with the same files (and tests for docs-only changes), builds the offline Windows package and publishes release
   v<version>; `ferry update` picks it up. Only a version with no release yet is published, so merging feature PRs
   publishes nothing.
6. Feature PR title: what changed for the user; its description is a table 问题 / 改了什么 / 自测. Release PR title
   `Ferry x.y.z: the features in it`; its description is the version's record: the feature PRs with links and one
   line each (versions up to 0.30 are in docs/history/). The release PR updates GOAL.md's "最近一次结果" line.
7. User docs: README.md is the short entry page; details go in docs/USAGE.md (users) and
   docs/SERVER.md (server). Do not let README grow back into a manual.
8. Before a release that changes how the agent works, the owner runs `python evals/run.py` on their Windows PC
   (real DeepSeek) and pushes the result file in evals/results/; compare it with the previous one. Keep
   `python evals/run.py --verify` passing when tasks change.

How the owner splits the work: the main session plans and reviews; a task goes to one agent (or one new Sonnet session in the project), not split into many; the main session accepts and merges.

Work comes from real problems: `/report` in ferry turns one into a GitHub issue (posted by the owner's Ferry
server, label-free, title starts with `[report]`). One branch / PR may take several related issues. A real failure that can be
reproduced with made-up content becomes a new task in evals/tasks/.

Branches: main for Ferry itself; DSH / Codex / Claude Code integrations on `integrations`
(docs/ROADMAP.md).

## Where things stand (2026-11-05, end of the cloud session that built 0.25 to 0.31)

- Released: 0.31.0 (server reads public pages, one-window browser login, undici 8.12.3). The long-lived branch
  `claude/lucid-cori-4u8ucg` is retired; new work starts from main (see "How a change ships").
- Web, as it is now: search and public pages are done by the server (DeepSeek's Search/Fetch APIs with the
  server's DeepSeek key when it has one; else a search API, a model's own search, or Bing on the PC). Intranet and
  private addresses, `localSites`, files, and pages the server cannot reach are read on the PC; logins and site
  operation go through agent-browser. Code: server/ferry_server/search.py, client/lib/web.mjs.
- Browser: agent-browser, headless by default; `ferry browser login <url>` opens an ordinary window (Google refuses
  automated sign-in), waits for the sign-in, then connects agent-browser; `--headed` on a sign-in page is blocked (#30); private-data commands always ask.
- Models (0.32): each server provider is its own pi provider, so /model shows `kiro/claude-opus-5.5`; "ferry" holds
  `auto` and pooled models. Same-named models are pooled only between providers with `share = true` (0.29's
  `separate` is gone). Client lookups go through `findFerryModel` / `FERRY_PROVIDERS` in config.mjs.
- pi 1.5.0. Note: pi's Claude effort messages are turned off in sync.mjs modelDef (relays dropped them, #9).
- Not verified on a real machine yet: Google sign-in through `ferry browser login`; the model-native search and
  DeepSeek Fetch paths against the real APIs (unit tests use mocks). evals/run.py has not been run since 0.26.
- Candidate next work is listed in docs/ROADMAP.md ("下一步候选").

## Where earlier context is

- Merged PRs and git log (every version: problem, change, test); docs/history/ for versions up to 0.30.
- docs/AGENT-GOAL.md: the agent's goal list.
- docs/ROADMAP.md: plan and what is still missing.
- Earlier conversations were Claude Cowork cloud sessions; the commit trailers link to them.
