import asyncio

import pytest

from ferry_server import web


def test_allow_list():
    assert web.host_allowed("api.github.com", [])
    assert web.host_allowed("api.github.com", ["github.com"])
    assert web.host_allowed("github.com", ["*.github.com"])
    assert not web.host_allowed("evilgithub.com", ["github.com"])
    assert not web.host_allowed("example.org", ["github.com"])


def test_never_this_machine_or_private_networks(monkeypatch):
    monkeypatch.delenv("FERRY_TEST_WEB_LOCAL", raising=False)
    for host in ["127.0.0.1", "localhost", "10.1.2.3", "192.168.1.1", "169.254.169.254"]:
        with pytest.raises(web.WebError):
            asyncio.run(web.check_public(host))
    with pytest.raises(web.WebError):
        asyncio.run(web.fetch("http://127.0.0.1:8787/admin", allow=[]))
    with pytest.raises(web.WebError):
        asyncio.run(web.fetch("file:///etc/passwd", allow=[]))


def test_html_to_text():
    title, text = web.to_text(
        "<html><head><title>T &amp; t</title><style>x{}</style></head><body><nav>menu</nav>"
        "<h2>Install</h2><p>Run <code>npm ci</code> then <a href='/docs'>read the docs</a>.</p>"
        "<pre>line1\n  line2</pre><ul><li>one</li><li>two</li></ul><script>alert(1)</script></body></html>".encode(),
        "text/html; charset=utf-8", "https://example.com/a/")
    assert title == "T & t"
    assert "## Install" in text and "`npm ci`" in text and "[read the docs](https://example.com/docs)" in text
    assert "line1\n  line2" in text and "- one" in text
    assert "alert" not in text and "menu" not in text and "x{}" not in text


def test_gbk_page():
    body = '<html><head><meta charset="gbk"><title>中文</title></head><body><p>你好</p></body></html>'.encode("gbk")
    title, text = web.to_text(body, "text/html", "https://x.cn")
    assert title == "中文" and "你好" in text


def test_bing_results():
    page = ('<li class="b_algo"><h2><a href="https://a.com/x?y=1&amp;z=2">A <strong>title</strong></a></h2>'
            '<div class="b_caption"><p>Snippet <b>here</b></p></div></li>')
    r = web._bing(page)
    assert r == [{"title": "A title", "url": "https://a.com/x?y=1&z=2", "snippet": "Snippet here"}]


def test_bing_redirect_links_are_unwrapped():
    u = "https://www.bing.com/ck/a?!&&p=x&ptn=3&u=a1aHR0cHM6Ly9naXRodWIuY29tL0J1cm50U3VzaGkvcmlwZ3JlcA&ntb=1"
    assert web._bing_target(u) == "https://github.com/BurntSushi/ripgrep"
