#!/usr/bin/env python3
"""Copy a raw capture into the fixtures tree with machine paths rewritten.

Home becomes /Users/dev, the probe tree becomes /work, and the session
directory becomes the path Dray would use. Nothing else is edited — the same
convention the Codex fixtures follow.

    ./sanitize.py raw/tools.jsonl ../../src-tauri/src/harness/pi/fixtures/no_approvals.jsonl
"""

import json
import os
import pathlib
import sys

HOME = os.path.expanduser("~")
PROBE = os.environ.get("PI_PROBE_DIR", "/tmp/pi-probe")

SUBS = [
    (f"{PROBE}/sessions", "/Users/dev/.dray/pi-sessions"),
    (f"{PROBE}/agentdir", "/Users/dev/.pi/agent"),
    (f"{PROBE}/work", "/work"),
    (PROBE, "/work"),
    (HOME, "/Users/dev"),
]


def main() -> None:
    src, dst = sys.argv[1], sys.argv[2]
    out = []
    for line in pathlib.Path(src).read_text().splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        text = rec["line"]
        for a, b in SUBS:
            text = text.replace(a, b)
        rec["line"] = text
        out.append(json.dumps(rec, separators=(",", ":")))
    pathlib.Path(dst).write_text("\n".join(out) + "\n")
    print(f"{dst}: {len(out)} records")


if __name__ == "__main__":
    main()
