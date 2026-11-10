"""Sits between the phone and an isolated dray-serve. Forwards everything, but
answers the PR commands itself from fixtures keyed on the session's repo
(`pr-<state>` in cwd), so every sheet state shows and no real PR is touched.
A merge flips that repo's fixture to MERGED; restart the proxy to reset it.
What `PrPanelTests` runs against.

Setup, from apps/ios:
  1. A server of its own, never the app's:
       DRAY_HOME=/tmp/pr-home DRAY_NO_ANALYTICS=1 dray --serve &
  2. One session per state, each in a throwaway repo named for it
     (pr-running, pr-failing, pr-ready, pr-draft, pr-loggedout, pr-merge), titled "PR <state>".
     `merge` is the merge test's own copy of `ready`, so its merge never reaches the states test:
       DRAY_ENDPOINT=/tmp/pr-home/dray.sock dray session new --project /tmp/pr-ready \\
         --model haiku --effort low --title "PR ready" "Reply with the single word ok."
  3. pip install websockets, then
       python3 scripts/pr_fixture_proxy.py 64999 $(head -1 /tmp/pr-home/serve-port)
  4. TEST_RUNNER_DRAY_URL=ws://127.0.0.1:64999 TEST_RUNNER_DRAY_TOKEN=$(cat /tmp/pr-home/serve-token) \\
       xcodebuild test -only-testing:DrayUITests/PrPanelTests …
"""
import asyncio, json, re, sys
import websockets

LISTEN, UP = int(sys.argv[1]), int(sys.argv[2])
URL = "https://github.com/monorepo-labs/dray/pull/812"

def check(name, state):
    return {"name": name, "state": state, "url": "https://github.com/monorepo-labs/dray/actions"}

def comment(author, body, kind="comment", path=None, resolved=False, replies=0, minute=1):
    return {"author": author, "avatar": f"https://github.com/{author}.png?size=40", "body": body,
            "createdAt": f"2026-11-10T10:{minute:02d}:00Z", "url": URL + f"#c{minute}", "kind": kind,
            "path": path, "resolved": resolved,
            "replies": [comment("yogesharc", "Fixed.", minute=minute + 30) for _ in range(replies)]}

COMMENTS = [
    comment("mira-k", "Looks right on the SE now. Ship it.", "approved", minute=1),
    comment("greptile-apps", "`trailingSlot` is 36pt here and 32pt in the child row, so the time column drifts by 4pt.",
            path="apps/ios/Dray/Sidebar.swift", replies=1, minute=2),
    comment("greptile-apps", "Padding is hardcoded; Theme.Space.m covers it.", path="apps/ios/Dray/Theme.swift",
            resolved=True, minute=3),
]
REVIEWED = comment("greptile-apps", "Confidence 4/5. The rail slot is fixed now, but one row still reads its width from the title.",
                   "reviewed", minute=4)
PASSED = [check("build-macos", "success"), check("cargo test", "success"),
          check("Greptile Review", "success"), check("Vercel — dray-site", "success")]

def pr(**over):
    base = {"number": 812, "title": "Tighten session row spacing", "url": URL, "state": "OPEN", "isDraft": False,
            "author": "yogesharc", "baseRefName": "main", "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
            "reviewDecision": "APPROVED", "checks": PASSED, "comments": COMMENTS,
            "additions": 142, "deletions": 38, "changedFiles": 6}
    base.update(over)
    return base

FIXTURES = {
    "running": [pr(mergeStateStatus="BLOCKED", checks=[check("build-macos", "pending"), check("cargo test", "pending"),
               check("Greptile Review", "success"), check("Vercel — dray-site", "success")], comments=[REVIEWED] + COMMENTS[1:])],
    "failing": [pr(mergeStateStatus="UNSTABLE", checks=[check("build-macos", "success"), check("cargo test", "failure"),
               check("Greptile Review", "success"), check("Vercel — dray-site", "success")], comments=[REVIEWED] + COMMENTS[1:])],
    "ready": [pr()],
    "merge": [pr()],
    "draft": [pr(isDraft=True, mergeStateStatus="DRAFT", comments=COMMENTS[1:])],
    "merged": [pr(state="MERGED")],
    "none": [],
}
ERRORS = {"loggedout": {"kind": "not_authenticated"}}

def repo(args):
    m = re.search(r"/pr-([a-z]+)", (args or {}).get("cwd", ""))
    return m and m.group(1)

def answer(msg):
    cmd, args, rid = msg.get("cmd"), msg.get("args") or {}, msg.get("id")
    name = repo(args)
    if cmd == "prs_for_branch" and name:
        if name in ERRORS:
            return {"id": rid, "err": ERRORS[name]}
        return {"id": rid, "ok": FIXTURES.get(name, [])}
    if cmd == "merge_pr" and name in FIXTURES:
        print("merge_pr", name, args.get("method"), flush=True)
        FIXTURES[name] = [dict(p, state="MERGED") for p in FIXTURES[name]]
        return {"id": rid, "ok": None}
    if cmd == "mark_pr_ready" and name in FIXTURES:
        FIXTURES[name] = [dict(p, isDraft=False, mergeStateStatus="CLEAN") for p in FIXTURES[name]]
        return {"id": rid, "ok": None}
    return None

async def handle(client):
    async with websockets.connect(f"ws://127.0.0.1:{UP}{client.request.path}", max_size=None) as up:
        async def down():
            async for m in up:
                await client.send(m)
        task = asyncio.create_task(down())
        try:
            async for m in client:
                try:
                    msg = json.loads(m)
                except Exception:
                    msg = {}
                reply = answer(msg) if isinstance(msg, dict) else None
                if reply is not None:
                    await client.send(json.dumps(reply))
                else:
                    await up.send(m)
        finally:
            task.cancel()

async def main():
    async with websockets.serve(handle, "127.0.0.1", LISTEN, max_size=None):
        print("proxy on", LISTEN, "->", UP, flush=True)
        await asyncio.Future()

asyncio.run(main())
