"""A 5.6 MB log: count errors per service and find the worst hour (meant for a script, not for reading the file)."""
import random
import re
from collections import Counter
from pathlib import Path

TITLE = "从几 MB 的日志里统计错误"
PROMPT = ("app.log 是一天的服务日志（UTC 时间）。统计每个服务的 ERROR 级别日志条数，写进 errors.csv"
          "（两列 service,errors，按条数从多到少），再告诉我 ERROR 最多的是哪个小时、那个小时有多少条。")
TIMEOUT = 600
NETWORK = False

SERVICES = ["auth", "billing", "gateway", "search", "storage", "notify"]
MESSAGES = {
    "DEBUG": ["cache lookup key={k}", "pool size={n}"],
    "INFO": ["request ok latency_ms={n}", "retrying after ERROR from upstream, attempt {a}", "user {k} logged in"],
    "WARN": ["slow query {n} ms", "ERROR budget at {a}0%"],
    "ERROR": ["upstream timeout after {n} ms", "db connection reset", "invalid token for user {k}"],
}


def generate() -> tuple[list[str], Counter, Counter]:
    """The log lines, ERROR count per service, ERROR count per hour; the same every time."""
    rnd = random.Random(20261106)
    lines, by_service, by_hour = [], Counter(), Counter()
    t = 0.0
    while t < 86400:
        hour = int(t // 3600)
        service = SERVICES[rnd.randrange(len(SERVICES))]
        x = rnd.random()
        level = "ERROR" if x < 0.012 else "WARN" if x < 0.06 else "DEBUG" if x < 0.3 else "INFO"
        if hour == 14 and service == "gateway" and rnd.random() < 0.25:
            level = "ERROR"
        msg = MESSAGES[level][rnd.randrange(len(MESSAGES[level]))].format(
            k=f"{rnd.randrange(16 ** 6):06x}", n=rnd.randrange(5, 3000), a=rnd.randrange(1, 9))
        stamp = f"2026-10-14T{hour:02d}:{int(t % 3600 // 60):02d}:{int(t % 60):02d}.{int(t * 1000) % 1000:03d}Z"
        lines.append(f"{stamp} {level:<5} [{service}] req={rnd.randrange(16 ** 8):08x} {msg}")
        if level == "ERROR":
            by_service[service] += 1
            by_hour[hour] += 1
        t += rnd.expovariate(0.8)
    return lines, by_service, by_hour


def setup(work: Path) -> None:
    lines, _, _ = generate()
    (work / "app.log").write_text("\n".join(lines) + "\n", encoding="utf-8")


def check(work: Path, answer: str) -> tuple[bool, str]:
    _, by_service, by_hour = generate()
    f = work / "errors.csv"
    if not f.exists():
        return False, "no errors.csv"
    got = {}
    for line in f.read_text(encoding="utf-8-sig").splitlines():
        m = re.match(r"\s*\"?(\w+)\"?\s*[,;\t]\s*\"?([\d,]+)\"?\s*$", line)
        if m and m.group(1) in SERVICES:
            got[m.group(1)] = int(m.group(2).replace(",", ""))
    wrong = [f"{s} {n} (got {got.get(s)})" for s, n in by_service.items() if got.get(s) != n]
    if wrong:
        return False, "errors.csv wrong: " + "; ".join(wrong)
    order = [s for s in got if s in by_service]
    if [got[s] for s in order] != sorted(got.values(), reverse=True):
        return False, "errors.csv counts right but not sorted from most to fewest"
    hour, count = by_hour.most_common(1)[0]
    a = answer.replace(",", "")
    if not re.search(rf"(?<!\d){hour}(?!\d)", a) or not re.search(rf"(?<!\d){count}(?!\d)", a):
        return False, f"errors.csv right; the answer does not give hour {hour} with {count} errors"
    return True, f"errors.csv right; worst hour {hour}:00 with {count} errors"


def solve(work: Path) -> str:
    _, by_service, by_hour = generate()
    (work / "errors.csv").write_text("service,errors\n" + "".join(f"{s},{n}\n" for s, n in by_service.most_common()),
                                     encoding="utf-8")
    hour, count = by_hour.most_common(1)[0]
    return f"The worst hour is {hour}:00-{hour + 1}:00 UTC with {count:,} errors."
