from ferry_server.config import Config
from ferry_server.watchdog import Watchdog


class Clock:
    def __init__(self):
        self.now = 1_000_000.0

    def __call__(self):
        return self.now


def dog(monkeypatch, bark="https://api.day.app/KEY", minutes=15):
    monkeypatch.delenv("FERRY_TEST_STALL_SECONDS", raising=False)
    clock = Clock()
    return Watchdog(Config(bark_url=bark, stall_minutes=minutes), clock), clock


def test_a_silent_run_gets_exactly_one_notice(monkeypatch):
    d, clock = dog(monkeypatch)
    assert d.heard("wesley", "d1", "工作电脑", "run1", "specs") == []
    clock.now += 14 * 60
    assert d.tick() == []
    clock.now += 2 * 60
    out = d.tick()
    assert len(out) == 1
    title, body = out[0]
    assert title == "Ferry 停了"
    assert "工作电脑 · specs" in body and "网关要确认" in body and "电脑睡眠或断网" in body and "ferry 退出" in body
    clock.now += 60 * 60
    assert d.tick() == [], "one notice per stall"


def test_beats_keep_a_long_run_quiet(monkeypatch):
    d, clock = dog(monkeypatch)
    d.heard("wesley", "d1", "工作电脑", "run1")
    for _ in range(12):  # an hour-long build, a beat every 5 minutes
        clock.now += 5 * 60
        d.heard("wesley", "d1", "工作电脑", "run1")
        assert d.tick() == []


def test_a_clean_end_stops_watching(monkeypatch):
    d, clock = dog(monkeypatch)
    d.heard("wesley", "d1", "工作电脑", "run1")
    assert d.heard("wesley", "d1", "工作电脑", "run1", end=True) == []
    clock.now += 3600
    assert d.tick() == [] and d.runs == {}


def test_coming_back_after_a_stall_says_so_once(monkeypatch):
    d, clock = dog(monkeypatch)
    d.heard("wesley", "d1", "工作电脑", "run1", "specs")
    clock.now += 40 * 60
    assert len(d.tick()) == 1
    back = d.heard("wesley", "d1", "工作电脑", "run1")
    assert back and back[0][0] == "Ferry 又连上了" and "40 分钟" in back[0][1] and "specs" in back[0][1]
    clock.now += 60
    assert d.heard("wesley", "d1", "工作电脑", "run1") == []
    clock.now += 20 * 60
    assert len(d.tick()) == 1, "a second stall is a new notice"
    assert d.heard("wesley", "d1", "工作电脑", "run1", end=True)[0][0] == "Ferry 又连上了"
    assert d.runs == {}


def test_runs_of_one_computer_share_a_notice_and_users_are_apart(monkeypatch):
    d, clock = dog(monkeypatch)
    d.heard("wesley", "d1", "工作电脑", "a", "specs")
    d.heard("wesley", "d1", "工作电脑", "b", "code")
    d.heard("bob", "main", "主令牌", "a", "specs")
    clock.now += 16 * 60
    out = d.tick()
    assert len(out) == 2
    bodies = sorted(b for _, b in out)
    assert bodies[0].startswith("bob · specs")  # the main token is named by its user
    assert bodies[1].startswith("工作电脑 · code · specs")
    d.heard("bob", "main", "主令牌", "a", end=True)
    assert ("wesley", "d1", "a") in d.runs


def test_off_without_bark_or_with_zero_minutes(monkeypatch):
    for d, clock in (dog(monkeypatch, bark=""), dog(monkeypatch, minutes=0)):
        assert d.heard("wesley", "d1", "工作电脑", "run1") == []
        clock.now += 3600
        assert d.tick() == [] and d.runs == {}


def test_a_run_that_never_comes_back_is_forgotten(monkeypatch):
    d, clock = dog(monkeypatch)
    d.heard("wesley", "d1", "工作电脑", "run1")
    clock.now += 20 * 60
    assert len(d.tick()) == 1
    clock.now += 3 * 86400
    assert d.tick() == [] and d.runs == {}
