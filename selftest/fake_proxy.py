"""A minimal company-style HTTP proxy for tests: supports CONNECT tunnels and absolute-URI requests.
Logs one line per tunnel/request: "<METHOD> <target>".

usage: python fake_proxy.py <log file> [port]
"""
import socket
import sys
import threading
from urllib.parse import urlsplit

LOG = sys.argv[1]
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8899
lock = threading.Lock()


def log(line: str) -> None:
    with lock, open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def pipe(a: socket.socket, b: socket.socket) -> None:
    try:
        while data := a.recv(65536):
            b.sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def handle(client: socket.socket) -> None:
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = client.recv(65536)
        if not chunk:
            client.close()
            return
        buf += chunk
    head, rest = buf.split(b"\r\n\r\n", 1)
    lines = head.decode("latin-1").split("\r\n")
    method, target, version = lines[0].split(" ", 2)
    log(f"{method} {target}")
    if method == "CONNECT":
        host, port = target.rsplit(":", 1)
        upstream = socket.create_connection((host, int(port)))
        client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        if rest:
            upstream.sendall(rest)
    else:
        u = urlsplit(target)
        upstream = socket.create_connection((u.hostname, u.port or 80))
        path = (u.path or "/") + (f"?{u.query}" if u.query else "")
        headers = [l for l in lines[1:] if not l.lower().startswith("proxy-")]
        upstream.sendall(f"{method} {path} {version}\r\n".encode() + "\r\n".join(headers).encode("latin-1")
                         + b"\r\n\r\n" + rest)
    threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
    pipe(upstream, client)


srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", PORT))
srv.listen(64)
while True:
    conn, _ = srv.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
