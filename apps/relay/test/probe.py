#!/usr/bin/env python3
"""Opens a fresh connection to a Dray server's public address on a loop, the
way a phone reconnecting does: TLS, WebSocket upgrade, the token's hello, the
server's welcome. Prints one line per try, so an outage reads as a run of
`fail` lines and recovery as the first `ok` after them.

    probe.py wss://r….id.relay.localhost:17443 TOKEN_FILE [--ca ca.pem] [--every 1]

Standard library only, so it runs anywhere python3 does.
"""

import argparse
import base64
import datetime
import json
import os
import socket
import ssl
import sys
import time
from urllib.parse import urlparse


def now():
    return datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]


def frame(text):
    data = text.encode()
    mask = os.urandom(4)
    head = bytearray([0x81])
    if len(data) < 126:
        head.append(0x80 | len(data))
    else:
        head.append(0x80 | 126)
        head += len(data).to_bytes(2, "big")
    return bytes(head) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data))


def read_exact(sock, n):
    out = b""
    while len(out) < n:
        chunk = sock.recv(n - len(out))
        if not chunk:
            raise ConnectionError("closed")
        out += chunk
    return out


def read_text(sock):
    while True:
        b0, b1 = read_exact(sock, 2)
        n = b1 & 0x7F
        if n == 126:
            n = int.from_bytes(read_exact(sock, 2), "big")
        elif n == 127:
            n = int.from_bytes(read_exact(sock, 8), "big")
        payload = read_exact(sock, n)
        if b0 & 0x0F == 1:
            return payload.decode()
        if b0 & 0x0F == 8:
            raise ConnectionError("close frame")


def once(url, token, ctx, timeout):
    u = urlparse(url)
    port = u.port or 443
    t0 = time.monotonic()
    raw = socket.create_connection((u.hostname, port), timeout=timeout)
    sock = ctx.wrap_socket(raw, server_hostname=u.hostname)
    try:
        key = base64.b64encode(os.urandom(16)).decode()
        host = u.hostname if port == 443 else f"{u.hostname}:{port}"
        sock.sendall(
            (
                f"GET / HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ).encode()
        )
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = sock.recv(1)
            if not chunk:
                raise ConnectionError("closed during upgrade")
            head += chunk
        if not head.startswith(b"HTTP/1.1 101"):
            raise ConnectionError(head.split(b"\r\n")[0].decode())
        sock.sendall(frame(json.dumps({"v": 1, "token": token})))
        welcome = json.loads(read_text(sock))
        if welcome.get("v") != 1:
            raise ConnectionError(f"refused: {welcome}")
        return (time.monotonic() - t0) * 1000
    finally:
        sock.close()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("url")
    p.add_argument("token_file")
    p.add_argument("--ca")
    p.add_argument("--every", type=float, default=1.0)
    p.add_argument("--timeout", type=float, default=5.0)
    p.add_argument("--count", type=int, default=0)
    a = p.parse_args()
    url = a.url.replace("https://", "wss://")
    token = open(a.token_file).read().strip()
    ctx = ssl.create_default_context(cafile=a.ca) if a.ca else ssl.create_default_context()
    n = 0
    while a.count == 0 or n < a.count:
        n += 1
        started = time.monotonic()
        try:
            ms = once(url, token, ctx, a.timeout)
            print(f"{now()} ok {ms:.0f}ms", flush=True)
        except Exception as e:  # noqa: BLE001 — every failure is one line
            print(f"{now()} fail {type(e).__name__}: {e}", flush=True)
        time.sleep(max(0.0, a.every - (time.monotonic() - started)))


if __name__ == "__main__":
    sys.exit(main())
