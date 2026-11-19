"""Seeds one dray-serve home per LoneBotTests case (#1169), all on one token.

    python3 scripts/lone_bot_seed.py
    for c in lone hidden visible two fresh; do   # ports 47101-47105 in this order
      DRAY_HOME=/private/tmp/dray-lone-bot/$c dray-serve --port <port> &
    done

Under /private/tmp, not /tmp: the server canonicalizes paths, and a bot's path
that differs from its chat's cwd by that symlink matches no bot. dray-serve
must know bots; build it from the repo if the installed one is older.
"""
import json, os, shutil, sys, uuid
from datetime import datetime, timedelta, timezone

ROOT = sys.argv[1] if len(sys.argv) > 1 else "/private/tmp/dray-lone-bot"
TOKEN = "1169" * 16
now = datetime.now(timezone.utc)
stamp = lambda d: d.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def bot(home, name, hue):
    bid = str(uuid.uuid4())
    path = f"{home}/bots/{bid}"
    os.makedirs(path + "/memory")
    open(path + "/AGENTS.md", "w").write(f"# {name}\n")
    return {"id": bid, "name": name, "path": path, "created": stamp(now - timedelta(days=2)),
            "avatar": {"shape": "cloud", "hue": hue}}


def session(home, cwd, title, reply, hidden=False, parent=None):
    sid = str(uuid.uuid4())
    at = now - timedelta(minutes=30)
    lines = [
        {"type": "user_message", "text": f"{title}?", "images": [], "issues": [], "baseline": None,
         "queued": False, "from": None, "cwd": None},
        {"type": "assistant_text", "block": {"messageId": "msg_1", "index": 0}, "text": reply},
        {"type": "turn_completed", "status": "success", "stopReason": "end_turn", "finalText": reply},
    ]
    with open(f"{home}/sessions/{sid}.jsonl", "w") as f:
        for seq, p in enumerate(lines):
            f.write(json.dumps({"id": str(uuid.uuid4()), "sessionId": sid, "harness": "claude_code", "seq": seq,
                                "ts": stamp(at + timedelta(seconds=seq)), "turnId": None, "subagent": None,
                                "payload": p}) + "\n")
    return {"sessionId": sid, "harness": "claude_code", "cwd": cwd, "projectPath": cwd, "branch": "main",
            "worktreeName": None, "worktreeRemoved": False, "title": title, "titleLocked": True,
            "model": "haiku", "effort": "low", "permissionMode": "auto", "fast": False, "status": "idle",
            "forkFrom": None, "threadId": None, "issues": [], "parentSessionId": parent,
            "created": stamp(at), "modified": stamp(at + timedelta(seconds=3)), "archived": False,
            "pinned": False, "hidden": hidden, "aside": False, "continueOff": False}


def home(case, bots, sessions):
    h = f"{ROOT}/{case}"
    os.makedirs(f"{h}/sessions", exist_ok=True)
    open(f"{h}/serve-token", "w").write(TOKEN)
    os.chmod(f"{h}/serve-token", 0o600)
    json.dump(bots, open(f"{h}/bots.json", "w"))
    json.dump(sessions, open(f"{h}/sessions/index.json", "w"))


shutil.rmtree(ROOT, ignore_errors=True)
proj = f"{ROOT}/proj"
os.makedirs(proj)

# 1. One bot, its chat, nothing else.
h = f"{ROOT}/lone"; os.makedirs(f"{h}/sessions")
b = bot(h, "Ops", 185.0)
home("lone", [b], [session(h, b["path"], "Ops", "Morning. Nothing on fire.")])

# 2. One bot, its chat, and only hidden tasks under it.
h = f"{ROOT}/hidden"; os.makedirs(f"{h}/sessions")
b = bot(h, "Ops", 185.0)
chat = session(h, b["path"], "Ops", "Two tasks running for you.")
home("hidden", [b], [chat,
                     session(h, proj, "Fix login redirect", "Fixed.", hidden=True, parent=chat["sessionId"]),
                     session(h, proj, "Bump deps", "Bumped.", hidden=True, parent=chat["sessionId"])])

# 3. One bot plus a visible session: the list stays.
h = f"{ROOT}/visible"; os.makedirs(f"{h}/sessions")
b = bot(h, "Ops", 185.0)
home("visible", [b], [session(h, b["path"], "Ops", "Hi."), session(h, proj, "Fix login redirect", "Fixed.")])

# 4. Two bots: the list stays.
h = f"{ROOT}/two"; os.makedirs(f"{h}/sessions")
b1, b2 = bot(h, "Ops", 185.0), bot(h, "Scout", 40.0)
home("two", [b1, b2], [session(h, b1["path"], "Ops", "Hi."), session(h, b2["path"], "Scout", "Hi.")])

# 5. One bot with no chat yet: its own page opens.
h = f"{ROOT}/fresh"; os.makedirs(f"{h}/sessions")
home("fresh", [bot(h, "Ops", 185.0)], [])

print(TOKEN)
