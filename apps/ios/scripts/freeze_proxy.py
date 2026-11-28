#!/usr/bin/env python3
"""Stands in front of a dray-serve for StaleSocketTests, to make a socket go
half-dead the way one does after a night in the background:

- `GET /freeze` closes every upstream socket, so the server drops the client,
  but keeps the client's side open, reading and discarding: the phone hears no
  close, and no pong. New connections pass as before. Runs the optional
  `<on freeze>` shell command, which is how the test makes a turn start while
  the app is away;
- `GET /slow?ms=n` holds every frame the server sends for n ms, so a
  transcript's read is out long enough to see; `ms=0` stops.

    freeze_proxy.py <listen port> <server port> <control port> [on freeze]
"""
import asyncio, subprocess, sys

LISTEN, UPSTREAM, CONTROL = map(int, sys.argv[1:4])
ON_FREEZE = sys.argv[4] if len(sys.argv) > 4 else None
pairs = []
slow = 0.0


async def pump(r, w, pair, held):
    try:
        while data := await r.read(65536):
            if pair["dead"]:
                continue
            if held and slow:
                await asyncio.sleep(slow)
            w.write(data)
            await w.drain()
    except Exception:
        pass
    if not pair["dead"]:
        w.close()


async def client(cr, cw):
    ur, uw = await asyncio.open_connection("127.0.0.1", UPSTREAM)
    pair = {"dead": False, "up": uw}
    pairs.append(pair)
    await asyncio.gather(pump(cr, uw, pair, False), pump(ur, cw, pair, True))


async def control(r, w):
    global slow
    line = (await r.readline()).decode()
    if "/freeze" in line:
        for p in pairs:
            p["dead"] = True
            p["up"].close()
        if ON_FREEZE:
            subprocess.Popen(ON_FREEZE, shell=True)
    elif "/slow" in line:
        slow = int(line.split("ms=")[1].split()[0]) / 1000
    w.write(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nok\n")
    await w.drain()
    w.close()
    print(line.strip(), flush=True)


async def main():
    await asyncio.start_server(client, "127.0.0.1", LISTEN)
    await asyncio.start_server(control, "127.0.0.1", CONTROL)
    print("listening", LISTEN, "->", UPSTREAM, flush=True)
    await asyncio.Event().wait()


asyncio.run(main())
