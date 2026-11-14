#!/usr/bin/env python3
"""Stands in front of a scratch dray-serve for OpenAtBottomTests, to make a chat
change the way it does on a phone:

- every `/file` read is held a few seconds, so pictures and videos land late;
- `GET /late?tag=x` appends a finished turn to every session's log and drops
  every socket, so the app reads the turn on reconnect, as it does coming back
  from the background. The turn is tall, ends "Last line of x.", and names a
  screenshot and a recording the session holds under `browser/recordings/<id>/`,
  where it holds any.

Each appended line is a copy of the log's own newest line of that type, so its
shape is whatever the server wrote.

    late_turns_proxy.py <listen port> <server port> <DRAY_HOME> [delay seconds]

Never point it at a real home: it writes to the logs.
"""
import asyncio, copy, json, os, sys, time, uuid

LISTEN, UPSTREAM, HOME = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
DELAY = float(sys.argv[4]) if len(sys.argv) > 4 else 3
clients = set()


def append_turn(tag):
    for name in sorted(os.listdir(f"{HOME}/sessions")):
        if not name.endswith(".jsonl"):
            continue
        sid, path = name[:-6], f"{HOME}/sessions/{name}"
        events = [json.loads(l) for l in open(path) if l.strip()]
        last = {e["payload"]["type"]: e for e in events if e["subagent"] is None}
        if not {"user_message", "assistant_text", "turn_completed"} <= last.keys():
            continue
        rec = f"{HOME}/browser/recordings/{sid}"
        held = sorted(os.listdir(rec)) if os.path.isdir(rec) else []
        body = "\n\n".join(f"Paragraph {i} of late answer {tag}. " + "It runs long enough to wrap over a few lines on a phone. " * 3
                           for i in range(1, 6))
        for word, ext in [("Screenshot", ".png"), ("Recording", ".mp4")]:
            if hit := next((f for f in held if f.endswith(ext)), None):
                body += f"\n\n{word}: {rec}/{hit}"
        body += f"\n\nLast line of {tag}."
        seq = max(e["seq"] for e in events)
        now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
        with open(path, "a") as log:
            for kind, change in [("user_message", {"text": f"Late prompt {tag}", "images": []}),
                                 ("assistant_text", {"text": body}),
                                 ("turn_completed", {"finalText": body, "status": "success"})]:
                e = copy.deepcopy(last[kind])
                seq += 2
                e.update(id=str(uuid.uuid4()), seq=seq, ts=now)
                e["payload"].update(change)
                log.write(json.dumps(e) + "\n")


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        writer.close()


async def handle(reader, writer):
    try:
        head = await reader.read(65536)
        if head.startswith(b"GET /late?tag="):
            append_turn(head.split(b" ")[1].split(b"=")[1].decode())
            for c in list(clients):
                c.close()
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            await writer.drain()
            writer.close()
            return
        if head.startswith((b"GET /file", b"HEAD /file")):
            await asyncio.sleep(DELAY)
        up_reader, up_writer = await asyncio.open_connection("127.0.0.1", UPSTREAM)
        up_writer.write(head)
        await up_writer.drain()
        clients.add(writer)
        try:
            await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))
        finally:
            clients.discard(writer)
    except ConnectionError:
        writer.close()


async def main():
    async with await asyncio.start_server(handle, "127.0.0.1", LISTEN):
        # Ends on its own, so a forgotten one is never left listening.
        await asyncio.sleep(2 * 3600)


asyncio.run(main())
