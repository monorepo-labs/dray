"""Seeds a dray-serve home for ImageRetryTests (#1347): a bot whose chat holds a
reply per picture, each a markdown image by absolute path. Even ones sit under
`browser/recordings/`, which `/file` serves; odd ones outside it, read through
`read_file` over the socket.

    python3 scripts/image_retry_seed.py            # prints the token
    DRAY_HOME=/private/tmp/dray-img dray-serve --port <server port> &
    python3 scripts/late_turns_proxy.py <port> <server port> /private/tmp/dray-img 0 &

Under /private/tmp, not /tmp: the server canonicalizes paths, and a bot's path
that differs from its chat's cwd by that symlink matches no bot.
"""
import json, os, shutil, struct, sys, uuid, zlib
from datetime import datetime, timedelta, timezone

ROOT = sys.argv[1] if len(sys.argv) > 1 else "/private/tmp/dray-img"
TOKEN = "1347" * 16
now = datetime.now(timezone.utc)
stamp = lambda d: d.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def png(path, rgb, w=480, h=300):
    """A solid picture with a dark band, so a drawn one reads at a glance."""
    row = lambda y: b"\0" + bytes((20, 20, 20) if h // 3 < y < h // 2 else rgb) * w
    raw = b"".join(row(y) for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


shutil.rmtree(ROOT, ignore_errors=True)
os.makedirs(f"{ROOT}/sessions")
open(f"{ROOT}/serve-token", "w").write(TOKEN)
os.chmod(f"{ROOT}/serve-token", 0o600)

bid, sid = str(uuid.uuid4()), str(uuid.uuid4())
bot_path = f"{ROOT}/bots/{bid}"
os.makedirs(bot_path + "/memory")
open(bot_path + "/AGENTS.md", "w").write("# Ops\n")
json.dump([{"id": bid, "name": "Ops", "path": bot_path, "created": stamp(now - timedelta(days=2)),
            "avatar": {"shape": "cloud", "hue": 185.0}}], open(f"{ROOT}/bots.json", "w"))

colors = [(230, 80, 70), (70, 160, 230), (90, 200, 120), (240, 190, 60), (170, 100, 220), (240, 130, 190)]
at = now - timedelta(hours=1)
seq, lines = 0, []
for i, rgb in enumerate(colors, 1):
    where = f"{ROOT}/browser/recordings/{sid}" if i % 2 == 0 else f"{ROOT}-pics"
    pic = f"{where}/shot-{i}.png"
    png(pic, rgb)
    for p in [{"type": "user_message", "text": f"Screenshot {i}?", "images": [], "issues": [], "baseline": None,
               "queued": False, "from": None, "cwd": None},
              {"type": "assistant_text", "block": {"messageId": f"msg_{i}", "index": 0},
               "text": f"Here is screenshot {i}.\n\n![shot {i}]({pic})"},
              {"type": "turn_completed", "status": "success", "stopReason": "end_turn",
               "finalText": f"Here is screenshot {i}.\n\n![shot {i}]({pic})"}]:
        lines.append({"id": str(uuid.uuid4()), "sessionId": sid, "harness": "claude_code", "seq": seq,
                      "ts": stamp(at + timedelta(seconds=seq)), "turnId": None, "subagent": None, "payload": p})
        seq += 1
with open(f"{ROOT}/sessions/{sid}.jsonl", "w") as f:
    f.writelines(json.dumps(l) + "\n" for l in lines)

proj = f"{ROOT}/proj"
os.makedirs(proj)
item = lambda s, cwd, title: {
    "sessionId": s, "harness": "claude_code", "cwd": cwd, "projectPath": cwd, "branch": "main",
    "worktreeName": None, "worktreeRemoved": False, "title": title, "titleLocked": True, "model": "haiku",
    "effort": "low", "permissionMode": "auto", "fast": False, "status": "idle", "forkFrom": None,
    "threadId": None, "issues": [], "parentSessionId": None, "created": stamp(at),
    "modified": stamp(at + timedelta(seconds=seq)), "archived": False, "pinned": False, "hidden": False,
    "aside": False, "continueOff": False}
# A visible session beside the bot, so the list stays rather than opening the bot's page.
json.dump([item(sid, bot_path, "Ops"), item(str(uuid.uuid4()), proj, "Unrelated task")],
          open(f"{ROOT}/sessions/index.json", "w"))
print(TOKEN)
