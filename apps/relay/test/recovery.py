#!/usr/bin/env python3
"""Reads a scenario's logs back and says how long each drop took to heal.

    recovery.py EVENTS PROBE_LOG [CLIENT_LOG]

For every `restored` (or `reset`, or `relay up`) line in EVENTS: the first
probe `ok` after it, and the first `connected` in CLIENT_LOG after it, as
seconds after the stamp. Lines are `HH:MM:SS.mmm …`, all from one day.
"""

import sys


def secs(stamp):
    h, m, s = stamp.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def lines(path):
    out = []
    for line in open(path):
        parts = line.split(maxsplit=1)
        if len(parts) == 2 and parts[0].count(":") == 2:
            out.append((secs(parts[0]), parts[1].strip()))
    return out


def first_after(entries, t, word):
    for at, text in entries:
        if at >= t and text.startswith(word):
            return at - t
    return None


def fails_before(entries, t, start):
    return sum(1 for at, text in entries if start <= at < t and text.startswith("fail"))


def main():
    events = lines(sys.argv[1])
    probe = lines(sys.argv[2])
    client = lines(sys.argv[3]) if len(sys.argv) > 3 else []
    start = None
    for at, text in events:
        if " start" in text or text.startswith("relay down"):
            start = at
        if not any(k in text for k in ("restored", "reset", "relay up")):
            continue
        ok = first_after(probe, at, "ok")
        con = first_after(client, at, "connected") if client else None
        fails = fails_before(probe, at + (ok or 0), start if start is not None else at)
        fmt = lambda v: "never" if v is None else f"{v:.1f}s"
        print(f"{text:<28} probe ok after {fmt(ok):>7}   client connected after {fmt(con):>7}   probe fails {fails}")
        start = None


if __name__ == "__main__":
    main()
