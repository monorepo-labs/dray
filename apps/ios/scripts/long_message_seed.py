"""Seeds a dray-serve home for LongMessageTests (#1594): one task whose first prompt is
a pasted wall, well past twenty lines, and whose second is a short one that must not clamp.

    python3 scripts/long_message_seed.py           # prints the token
    DRAY_HOME=/private/tmp/dray-long dray-serve --port <port> &
"""
import json, os, shutil, sys, uuid
from datetime import datetime, timedelta, timezone

ROOT = sys.argv[1] if len(sys.argv) > 1 else "/private/tmp/dray-long"
TOKEN = "1594" * 16
now = datetime.now(timezone.utc)
stamp = lambda d: d.isoformat(timespec="milliseconds").replace("+00:00", "Z")

shutil.rmtree(ROOT, ignore_errors=True)
os.makedirs(f"{ROOT}/sessions")
os.makedirs(f"{ROOT}/proj")
open(f"{ROOT}/serve-token", "w").write(TOKEN)
os.chmod(f"{ROOT}/serve-token", 0o600)

trace = "\n".join(f"  at handler{i} (src/server/route{i}.ts:{10 + i}:{4 + i})" for i in range(40))
prompts = [
    ("Why does this crash on login? Here is the trace:\n\nTypeError: Cannot read properties of undefined (reading 'id')\n" + trace,
     "The session object is undefined when the redirect lands before the cookie is set."),
    ("Thanks, short one now: does the fix cover the logout path too?", "Yes, logout reads the same guard."),
]
sid, at, seq, lines = str(uuid.uuid4()), now - timedelta(hours=1), 0, []
for i, (ask, answer) in enumerate(prompts):
    for p in [{"type": "user_message", "text": ask, "images": [], "issues": [], "baseline": None,
               "queued": False, "from": None, "cwd": None},
              {"type": "assistant_text", "block": {"messageId": f"msg_{i}", "index": 0}, "text": answer},
              {"type": "turn_completed", "status": "success", "stopReason": "end_turn", "finalText": answer}]:
        lines.append({"id": str(uuid.uuid4()), "sessionId": sid, "harness": "claude_code", "seq": seq,
                      "ts": stamp(at + timedelta(seconds=seq)), "turnId": None, "subagent": None, "payload": p})
        seq += 1
with open(f"{ROOT}/sessions/{sid}.jsonl", "w") as f:
    f.writelines(json.dumps(l) + "\n" for l in lines)

proj = f"{ROOT}/proj"
json.dump([{
    "sessionId": sid, "harness": "claude_code", "cwd": proj, "projectPath": proj, "branch": "main",
    "worktreeName": None, "worktreeRemoved": False, "title": "Login crash", "titleLocked": True, "model": "haiku",
    "effort": "low", "permissionMode": "auto", "fast": False, "status": "idle", "forkFrom": None,
    "threadId": None, "issues": [], "parentSessionId": None, "created": stamp(at),
    "modified": stamp(at + timedelta(seconds=seq)), "archived": False, "pinned": False, "hidden": False,
    "aside": False, "continueOff": False}], open(f"{ROOT}/sessions/index.json", "w"))
print(TOKEN)
