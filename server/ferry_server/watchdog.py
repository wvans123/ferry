"""The server notices a run on a work computer that went quiet, and tells the phone itself.

While the agent works, the client says so every few minutes (POST /v1/ferry/alive) and once more when the run ends.
A run that has said nothing for stall_minutes most likely cannot reach this server any more: the company gateway wants
a confirmation, the computer went to sleep or lost the network, or ferry quit. The client's own phone notice would go
through that same blocked path, so the server sends one (Bark), and one more when the run is heard from again.
State lives in memory: a restart forgets it, and the next beat starts watching again.
"""
from __future__ import annotations

import asyncio
import json
import os
import time

from fastapi import FastAPI, Request

from . import notify
from .config import Config

FORGET_S = 2 * 86400  # a run that never came back is dropped after this
CAUSES = "可能是公司网关要确认、电脑睡眠或断网、ferry 退出了。"


class Watchdog:
    def __init__(self, cfg: Config, clock=time.time):
        self.cfg, self.clock = cfg, clock
        self.runs: dict[tuple[str, str, str], dict] = {}  # (user, device id, run id) -> what we know about the run

    def after(self) -> float:
        """Seconds of silence that make a stall; 0 = off (also while no Bark address is set)."""
        if not self.cfg.bark_url:
            return 0
        test = os.environ.get("FERRY_TEST_STALL_SECONDS")
        return float(test) if test else max(0, self.cfg.stall_minutes) * 60

    def heard(self, user: str, device_id: str, device: str, run_id: str, project: str = "",
              end: bool = False, console: str = "") -> list[tuple[str, str, tuple[str, str]]]:
        """A beat (or the end) of a run. Returns the notices to send: one when the run was stalled. Each notice is
        (title, body, (user, console session id)), the last for the link to the run's phone console."""
        key = (user, device_id, run_id)
        run = self.runs.pop(key, None)
        if not self.after():
            self.runs.clear()
            return []
        now = self.clock()
        if not end:
            self.runs[key] = {"user": user, "device": device if device_id != "main" else user,
                              "project": project or (run or {}).get("project", ""), "heard": now, "stalled": False,
                              "console": console or (run or {}).get("console", "")}
        if run and run["stalled"]:
            return [("Ferry 又连上了", f"{where(run)}：停了约 {round((now - run['heard']) / 60)} 分钟，现在又有消息了。",
                     (user, console or run.get("console", "")))]
        return []

    def tick(self) -> list[tuple[str, str, tuple[str, str]]]:
        """Runs silent for longer than after(): one notice per computer for the runs that stalled since the last tick."""
        after = self.after()
        if not after:
            return []
        now = self.clock()
        for key in [k for k, r in self.runs.items() if now - r["heard"] > FORGET_S]:
            del self.runs[key]
        fresh: dict[tuple[str, str], list[dict]] = {}
        for r in self.runs.values():
            if not r["stalled"] and now - r["heard"] >= after:
                r["stalled"] = True
                fresh.setdefault((r["user"], r["device"]), []).append(r)
        out = []
        for runs in fresh.values():
            since = time.strftime("%H:%M", time.localtime(min(r["heard"] for r in runs)))
            out.append(("Ferry 停了", f"{where(*runs)}：{since} 之后就没有消息了。{CAUSES}",
                        (runs[0]["user"], next((r["console"] for r in runs if r.get("console")), ""))))
        return out


def where(*runs: dict) -> str:
    projects = sorted({r["project"] for r in runs if r["project"]})
    return " · ".join([runs[0]["device"], *projects[:3]])


def mount(app: FastAPI, cfg: Config, audit, console_link=lambda user, sid: "") -> None:
    """POST /v1/ferry/alive {id, project, end, console}; the check loop starts with the first beat."""
    dog = Watchdog(cfg)
    loop: dict[str, asyncio.Task] = {}

    def send(notices: list[tuple[str, str, tuple[str, str]]], **row) -> None:
        for title, body, (user, sid) in notices:
            audit(event="watchdog", notice=title, **row)
            asyncio.create_task(notify.send(cfg, title, body, "stall", link=console_link(user, sid)))

    async def check():
        every = float(os.environ.get("FERRY_TEST_WATCHDOG_TICK") or 60)
        while True:
            await asyncio.sleep(every)
            send(dog.tick())

    @app.post("/v1/ferry/alive")
    async def alive(request: Request):
        b = json.loads(await request.body() or b"{}")
        if "task" not in loop:
            loop["task"] = asyncio.create_task(check())
        user = request.state.user or ""
        notices = dog.heard(user, getattr(request.state, "device_id", "main"), getattr(request.state, "device_name", ""),
                            str(b.get("id") or "")[:80], str(b.get("project") or "")[:60], bool(b.get("end")),
                            str(b.get("console") or "")[:40])
        send(notices, user=user)
        return {"ok": True, "watching": bool(dog.after())}
