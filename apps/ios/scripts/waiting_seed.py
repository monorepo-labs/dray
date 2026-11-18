"""Seeds a dray-serve home for WaitingOnYouTests (#1181): a bot whose chat runs
400 turns long, with seven hidden tasks idle on the reader, the oldest a week
back. Three reported into the chat: the oldest far up it, answered with a
reply naming a picture on the server's disk; the newest near its end,
answered; one with no reply. The rest never reported, so their rows open the
task. "Bump deps" carries a need line; every other row has none.

    python3 scripts/waiting_seed.py
    DRAY_HOME=/private/tmp/dray-waiting dray-serve --port 47111 &

Under /private/tmp, not /tmp: the server canonicalizes paths, and a bot's path
that differs from its chat's cwd by that symlink matches no bot. No git in the
project, so no PR mark makes a task anything but waiting.
"""
import json, os, shutil, struct, sys, uuid, zlib
from datetime import datetime, timedelta, timezone

ROOT = sys.argv[1] if len(sys.argv) > 1 else "/private/tmp/dray-waiting"
TOKEN = "1181" * 16
now = datetime.now(timezone.utc)
stamp = lambda d: d.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def png(w, h, rgb):
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    rows = b"".join(b"\0" + bytes(rgb) * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def write_log(sid, turns, start):
    with open(f"{ROOT}/sessions/{sid}.jsonl", "w") as f:
        seq = 0
        for i, (prompt, reply, *sender) in enumerate(turns):
            at = start + timedelta(minutes=i)
            # A task's report carries the sender line `attribute` writes.
            frm = sender and {"sessionId": sender[0], "title": sender[1], "machine": None}
            if frm:
                prompt = f'[message from the Dray session "{sender[1]}" ({sender[0]})]\n\n{prompt}'
            said = [{"type": "assistant_text", "block": {"messageId": f"msg_{i}", "index": 0}, "text": reply}] if reply else []
            for p in (
                {"type": "user_message", "text": prompt, "images": [], "issues": [], "baseline": None,
                 "queued": False, "from": frm or None, "cwd": None},
                *said,
                {"type": "turn_completed", "status": "success", "stopReason": "end_turn", "finalText": reply or ""},
            ):
                # Compact, as serde writes it: the server finds lines by byte needles like `"type":"user_message"`.
                f.write(json.dumps({"id": str(uuid.uuid4()), "sessionId": sid, "harness": "claude_code", "seq": seq,
                                    "ts": stamp(at), "turnId": None, "subagent": None, "payload": p},
                                   separators=(",", ":")) + "\n")
                seq += 1


def entry(sid, cwd, title, modified, hidden=False, parent=None):
    return {"sessionId": sid, "harness": "claude_code", "cwd": cwd, "projectPath": cwd, "branch": "main",
            "worktreeName": None, "worktreeRemoved": False, "title": title, "titleLocked": True,
            "model": "haiku", "effort": "low", "permissionMode": "auto", "fast": False, "status": "idle",
            "forkFrom": None, "threadId": None, "issues": [], "parentSessionId": parent,
            "created": stamp(modified - timedelta(days=1)), "modified": stamp(modified), "archived": False,
            "pinned": False, "hidden": hidden, "aside": False, "continueOff": False}


shutil.rmtree(ROOT, ignore_errors=True)
proj = f"{ROOT}/proj"
os.makedirs(proj)
os.makedirs(f"{ROOT}/sessions")
picture = f"{proj}/shot.png"
open(picture, "wb").write(png(240, 140, (250, 204, 21)))

bid = str(uuid.uuid4())
bot_path = f"{ROOT}/bots/{bid}"
os.makedirs(bot_path + "/memory")
open(bot_path + "/AGENTS.md", "w").write("# Ops\n")
bot = {"id": bid, "name": "Ops", "path": bot_path, "created": stamp(now - timedelta(days=30)),
       "avatar": {"shape": "cloud", "hue": 185.0}}

chat = str(uuid.uuid4())
chat_start = now - timedelta(days=8)
index = [entry(chat, bot_path, "Ops", now - timedelta(minutes=10))]

# Oldest first: the first is a week back, its report far up the chat.
tasks = [
    ("Fix login redirect", f"Fixed the redirect. Screenshot of the new flow:\n\n{picture}\n\nShould I open the PR?", 7 * 24 * 60),
    ("Bump deps", "Bumped everything but React 20. That one breaks the build; want me to pin it?", 3 * 24 * 60),
    ("Flaky upload test", "The upload test fails one run in ten. I think it's the clock. Rewrite it with a fake timer?", 24 * 60),
    ("Docs for servers", "Drafted the servers page. Read it at [the draft](https://example.com/draft) first?", 9 * 60),
    ("Trim the bundle", "Cut 140 KB. The rest is Shiki's grammars. Lazy-load them?", 6 * 60),
    ("Rename settings keys", "Renamed the keys. An old build will lose its picks. Ship anyway?", 3 * 60),
    ("Dark mode contrast", "Raised contrast on three tokens. Which palette should lead?", 60),
]
ids = {}
for title, last, minutes_ago in tasks:
    sid = ids[title] = str(uuid.uuid4())
    modified = now - timedelta(minutes=minutes_ago)
    write_log(sid, [(f"{title}.", "Working on it."), ("Go on.", last)], modified - timedelta(minutes=2))
    index.append(entry(sid, proj, title, modified, hidden=True, parent=chat))
# One row carries a need line its bot wrote; the rest have none and must not wait on one.
next(e for e in index if e["sessionId"] == ids["Bump deps"])["need"] = {"text": "Say whether to pin React 20 or wait for a fix.", "at": stamp(now)}

turns = [(f"Check {i}?", f"Chat reply number {i}.") for i in range(400)]
# The oldest report sits near the top, so the server walks back nearly the whole chat for it.
turns[5] = (tasks[0][1], f"The redirect task fixed the login loop and wants to open a PR. Its screenshot:\n\n{picture}\n\nSay yes and it opens one.",
            ids["Fix login redirect"], "Fix login redirect")
turns[200] = (tasks[1][1], None, ids["Bump deps"], "Bump deps")
turns[396] = (tasks[6][1], "Dark mode task raised contrast on three tokens and asks which palette should lead.",
              ids["Dark mode contrast"], "Dark mode contrast")
write_log(chat, turns, chat_start)

open(f"{ROOT}/serve-token", "w").write(TOKEN)
os.chmod(f"{ROOT}/serve-token", 0o600)
json.dump([bot], open(f"{ROOT}/bots.json", "w"))
json.dump(index, open(f"{ROOT}/sessions/index.json", "w"))
print(TOKEN)
