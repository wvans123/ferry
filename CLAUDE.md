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
| Feishu bot (`feishu.py`, `/feishu/event`, admin page block) | after 0.44.2 | owner: Bark and the phone page are enough; the bot only added chatting with it |
| backup ("fallback") model for a rate-limited or stalled provider, and the client switching to it (`fallback`, `fallback_for`, cross-API `reroute()` for a cooling model) | after 0.44.2 | owner: another model answering mid-conversation causes API differences; only same-named pooled models (share = true) take over |
| Playwright MCP browser (`@playwright/mcp`) | 0.27 | replaced by agent-browser: a CLI the agent calls with bash plus a skill, no tool definitions, compact snapshots |
| redaction (placeholders, word list, stream restoring) | 0.26 | off by default, never worked with Claude's own API, owner did not use it; /report keeps a small filter of its own |
| server-side web access (`web = server`, FERRY_WEB) | 0.26 | web tools run on the work PC since 0.11; nobody used the server path. Brought back in 0.30 at the owner's request in another form: search and public pages on the server (only the address goes up), intranet/private addresses still on the PC |
| web_download tool | 0.24 | the agent downloads with curl like Cursor; commands get ferry's CA bundle and proxy |
| web_render (Electron) and `ferry install-electron` | 0.24 | hardly needed, 100 MB download |
| phone console `/m`, status reports, phone approvals | 0.24 | only showed titles; Bark notifications are enough. Phone approvals came back in 0.43 at the owner's request in another form: the Bark push links to a signed one-item page with the full command or question (remote.py, remote.mjs); a per-session console with a small status and commands (steer, pause the goal, a new task) followed, also asked for (#59, console.mjs) |
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
3. Test locally only what changed: before pushing run `python scripts/affected.py --base origin/main --run`. It picks the
   module's unit tests (`client/lib/x.mjs` -> `client/test/x*.test.mjs`, `server/ferry_server/x.py` ->
   `server/tests/test_x*.py`) and the self-test steps whose code changed (`python selftest/run.py --only F66,F67`;
   `--list` shows which step holds which F; one step takes seconds). A shared core file (listed at the top of the
   script: ferry.mjs, sync.mjs, config.mjs, app.py, server config.py, store.py, package files, scripts/, workflows)
   or a code file with no test of its own runs all unit tests of its side. Without `--run` it only prints the plan.
   That local run is what counts: on a feature PR CI runs the same command on Linux, nothing else, and nobody
   waits for it. Push to main after the merge runs everything on Linux and Windows (self-test included) as the safety
   net; if it is red, fix it before the next release. Do not sit waiting for CI: open the PR, go on with other work or end
   the turn, and read the result when it is done (fix it if it is red). A unit test that waits on real timers (retry
   back-off, cool-downs) shortens them, like the others in test_pool.py.
4. A user-visible behaviour that needs the whole stack (client, server, fake model) gets an end-to-end check in
   selftest/run.py with the next free F number, listed in GOAL.md. Checks of text alone (what the system prompt
   says, a tool description) are unit tests, not F checks.
5. Releases are batched: features collect on main, and when the owner wants the work PC updated, one small release
   PR runs `python scripts/bump.py x.y.z` (package.json, package-lock.json, server/pyproject.toml,
   server/ferry_server/__init__.py) and nothing else, plus GOAL.md's last-result line. Its CI runs no tests when the
   base commit on main has a green full run (Linux and Windows); if main is red or its run is not finished, it runs
   everything. Merging it publishes: when only those files changed and the commit before is green, tests are
   skipped, then CI builds the offline Windows package and publishes release v<version>; `ferry update` picks it up.
   The release job refuses to publish when main's last full run is not green (re-run the workflow once it is). Only a
   version with no release yet is published, so merging feature PRs publishes nothing. A new pi version arrives the
   same way: update-pi.yml tests it and opens a PR (`claude/pi-<version>`, pi only, with pi's release notes); the owner
   reads the notes and merges.
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

## Where things stand (2026-11-23, release 0.47.1)

- Released: 0.49.0 (global + project Skill sync via `/sync install` / `/sync upload` with scope selector and folder summary; 0.48.0 shipped `/grill`, image step decay, zero-reupload `/resume`, subagent model routing, and Office upgrades). Releases since 0.31: 0.32 to 0.41
  (models per provider, server web search, memory distill, Word tracked changes, eval tasks), 0.42 (gateway wait,
  watchdog), 0.43 (phone approvals and console), 0.44.x (background job watch and `/loop`, delete rule, keep-alive,
  300 s stall default), 0.45 (batch-trimmed old outputs, 200k compact limit, lookup batch nudge, `/goal` retries and
  independent reviewer, removed Feishu bot and cross-model fallback, stall default back to 120 s), 0.46.x (per-model API
  choice for Anthropic / Responses / Chat, pi 1.5.1, SSE error classification, 512 KiB upload cap, trimmed old tool
  images, prompt payload byte stats), 0.47.x (Skill sync). Per-version record: GOAL.md and git log.
- Models: each server provider is its own pi provider, so `/model` shows `kiro/claude-opus-5.5`; `ferry` holds pooled
  models. Each model can pick its upstream API (`anthropic`, `openai`, `openai-responses`); legacy `ferry/<model>`
  session refs resolve to the current canonical provider. Same-named models are pooled only between providers with
  `share = true`. Client lookups go through `findFerryModel` / `FERRY_PROVIDERS` in config.mjs. pi 1.5.1; pi's Claude
  effort messages are turned off in sync.mjs `modelDef` (relays dropped them, #9).
- Web: search and public pages are done by the server (all sources at once, merged by RRF, quoted passages, 10-minute
  cache); intranet and private addresses, `localSites` and files are read on the PC; logins go through agent-browser
  (`ferry browser login <url>`). Code: server/ferry_server/search.py, client/lib/web.mjs. Measure with `evals/search_eval.py`.
- Away from the PC: a request that meets the company gateway waits up to `gatewayWaitMinutes` (gateway.mjs); the
  server watchdog pushes the phone when a run goes quiet for 15 minutes (heartbeat.mjs, watchdog.py); approvals and
  questions can be answered on a phone page, and the per-session phone console steers the run or starts `/goal`
  (remote.mjs, console.mjs). Details in docs/MODULES.md.
- Agent work: `/goal` with agreed completion criteria and an independent `review` subagent, `/grill` and built-in
  `grill` skill for upfront alignment via `ask_user`, background jobs that can be watched, `/loop`, `/memory distill`,
  `/sync` for account-scoped project skills (resources.mjs, resources.py), Word edits as tracked changes with inline
  preview, and `office_read` `outline` / `section` / `pages` navigation. Subagents support `[routing] subagent` model
  selection and a 24-step convergence nudge on `explore` / `research`. Pictures shrink to <=1280 px / ~120 KB base64 and
  become placeholders after `imageSteps` (default 4) assistant replies; old tool outputs and inline tool images are
  batch-omitted past `trimOldOutputs` (80k), keeping the latest 6 tool results. In full access, deleting asks only for a
  whole drive, the home or system folders, Ferry's data folder, the temp folder itself or the project folder itself;
  temporary files go to D:\ferry\temp.
- Server upstream: it keeps the connection alive for Cloudflare (no 524) and, when the upstream accepts a request and
  then says nothing for 120 s (`stall_seconds` per provider), asks the same model once more, then answers 504. Opening
  SSE errors are classified with bounded retry rules; conversation upload chunks default to 128 KiB (capped at 512 KiB,
  shrinking on 403/413/large-body resets) and `/v1/ferry/have` restores stored conversation prefixes and tool lists on
  `/resume`. Upstream calls carry an `x-session-id` header for local gateway session affinity. A 429 cools
  the account down and the request waits on the server; no other model takes over, except same-named models of
  providers with `share = true`. CI: a feature PR runs only the affected tests; the full run (Linux and Windows,
  self-test included) happens on main after the merge.
- Not verified on a real Windows work PC yet: the phone page through the real Cloudflare Tunnel (needs `public_url`);
  the watchdog and gateway wait overnight; Google sign-in through `ferry browser login`; real Windows runs of the newer
  eval tasks (last macOS DeepSeek runs: 0.41.0 8/8, 0.42.0 8/9 in `evals/results/`).
- Candidate next work is listed in docs/ROADMAP.md ("下一步候选").

## Where earlier context is

- Merged PRs and git log (every version: problem, change, test); docs/history/ for versions up to 0.30.
- docs/AGENT-GOAL.md: the agent's goal list.
- docs/ROADMAP.md: plan and what is still missing.
- Earlier conversations were Claude Cowork cloud sessions; the commit trailers link to them.
