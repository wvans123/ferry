---
name: browser
description: Drive a real web browser on this computer (Edge or Chrome) with the agent-browser command - searching inside a site, clicking through pages, filling forms, pages built by JavaScript, sites that need a login, screenshots. Use it whenever the task means operating a site, and carry the task through to the end; for reading a plain page or downloading a file you have the address of, web_fetch and curl are faster.
---
# Browser (agent-browser)

`agent-browser` is a command on the PATH. Each call is one action; the browser stays open between calls, with a
profile of its own, so sites stay logged in from one conversation to the next. It runs in the background (no window)
unless the user turned windows on (`AGENT_BROWSER_HEADED` is set then).

## Work the task to the end

A browser task is a loop, not one command: look, act, check, and again, until the goal is reached.

```bash
agent-browser open https://example.com      # go to a page (waits for it to load)
agent-browser snapshot -i                   # interactive elements, each with a ref: - button "Search" [ref=e3]
agent-browser fill @e5 "query" && agent-browser press Enter
agent-browser snapshot -i                   # look again: did the page change the way you expected?
agent-browser click @e8                     # the next step; refs change whenever the page changes
```

- Before starting, say to yourself what "done" looks like (the page, value or file you need). Keep going until you
  have it; do not stop after a search or a couple of clicks to report a partial result.
- After every action, check the result (snapshot, `get url`, `get text`). If it did not work, try another way (another
  element, scrolling, waiting, the site's own search) before giving up.
- Stop only when the goal is reached, or when you are stuck: then say exactly where (address, what the page shows)
  and why.
- Stay in the browser for sites you operate. Do not switch to web_fetch or curl of the same pages halfway: they lose
  the login, the form state and anything scripts built.

## Reading

- `agent-browser get text body` (or a CSS selector instead of body): the visible text, after scripts ran.
- `agent-browser get title`, `get url`, `get value @e5`, `get attr @e7 href` (element first, then the attribute).
- `agent-browser snapshot -c` the whole page as a compact tree; `-s "#main"` limits it to part of the page.
- `agent-browser screenshot shot.png` saves a picture into the project folder; read it to look at the page.

More: `select @e4 "Option"`, `check @e6`, `is checked @e6`, `press Enter`, `scroll down 600`, `wait 2000`,
`wait "#results"`, `back`, `tab list` (ids like t1), `tab new <url>`, `tab t1`. Quote CSS selectors: `#` starts a
comment in bash. Join steps with `&&` when you do not need to look in between.
Full reference, matched to the installed version: `agent-browser skills get core --full`.

## Logins and the user's help

- A login page (a sign-in form, a redirect to a single sign-on page, 401 or 403): the user signs in, you never type
  a password. Say in one line what the user should do (sign in to <site> in the window that opens), then run
  `ferry browser login <login page or the page you need>` (give the command a long timeout, up to 10 minutes). It
  opens the same browser and profile as an ordinary window (sites such as Google and Microsoft refuse to sign in
  to a browser a program drives), waits until the user has signed in, and connects agent-browser to that window:
  carry on there with the usual commands. When the window is no longer needed, `ferry browser hide`; the next
  command runs in the background again, still signed in. If it says the window was closed or nobody signed in,
  tell the user and stop that part.
- A bot wall such as YouTube's "Sign in to confirm you're not a bot" is a login case too: run
  `ferry browser login https://accounts.google.com/ServiceLogin?continue=<the page>`, never `agent-browser --headed`
  (a headed window is still under automation and Google refuses the sign-in).
- A site asks for a permission (camera, location, notifications): never grant it yourself. If the task needs it, open
  the window the same way (`ferry browser login <page>`) and let the user answer the browser's question.
- A company gateway's confirmation page ("are you sure you want to visit…"): tell the user; do not click through it.

## What always needs the user

- Commands that touch private data ask the user every time, even with full access: `cookies`, `storage`, `state`,
  `clipboard`, `upload`, `auth`, `connect`, `set credentials`, `network har`, and the `--profile`, `--cdp`,
  `--auto-connect` and `--state` options. Use them only when the task needs them.
- Before a step that cannot be taken back - submitting a form that sends or orders something, posting, sending a
  message, paying, changing account settings, deleting - ask the user with ask_user and wait for the answer, whatever
  the permission mode.
- Do not open sites on the user's blocked list. Downloading a file you already have the address of: use curl.
