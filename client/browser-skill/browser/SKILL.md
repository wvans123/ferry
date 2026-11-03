---
name: browser
description: Drive a real web browser on this computer (Edge or Chrome) with the agent-browser command - pages built by JavaScript, sites that need a login, clicking, filling forms, screenshots. Use it when web_fetch reads a page almost empty or the task needs interaction; for plain pages and files web_fetch and curl are faster.
---
# Browser (agent-browser)

`agent-browser` is a command on the PATH. Each call is one action; the browser stays open between calls (one
window, shown to the user), with a profile of its own, so sites stay logged in from one conversation to the next.

The loop:

```bash
agent-browser open https://example.com      # go to a page (waits for it to load)
agent-browser snapshot -i                   # interactive elements, each with a ref: - button "Sign in" [ref=e3]
agent-browser click @e3                     # act on a ref
agent-browser fill @e5 "text"               # clear a field and type
agent-browser snapshot -i                   # look again: refs change whenever the page changes
```

Reading:
- `agent-browser get text body` (or a CSS selector instead of body): the visible text, after scripts ran.
- `agent-browser get title`, `get url`, `get value @e5`, `get attr @e7 href` (element first, then the attribute).
- `agent-browser snapshot -c` the whole page as a compact tree; `-s "#main"` limits it to part of the page.
- `agent-browser screenshot shot.png` saves a picture into the project folder; read it to look at the page.

More: `select @e4 "Option"`, `check @e6`, `is checked @e6`, `press Enter`, `scroll down 600`, `wait 2000`,
`wait "#results"`, `back`, `tab list` (ids like t1), `tab new <url>`, `tab t1`. Quote CSS selectors: `#` starts a
comment in bash. Join steps with `&&` when you do not need to look in between.
Full reference, matched to the installed version: `agent-browser skills get core --full`.

Rules:
- Take a new snapshot before using refs after anything that changes the page; an old ref fails instead of hitting
  the wrong element.
- A login page: ask the user to log in in the browser window, then continue (`agent-browser wait` for an element of
  the page behind the login). Never type passwords you were not given in this conversation.
- A company gateway's confirmation page ("are you sure you want to visit…"): tell the user; do not click through it.
- Do not open sites on the user's blocked list. Downloading a file you already have the address of: use curl.
