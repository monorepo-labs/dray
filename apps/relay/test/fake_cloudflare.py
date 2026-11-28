#!/usr/bin/env python3
"""The part of Cloudflare's DNS API the relay calls, answered against
pebble-challtestsrv, so the relay's ACME path runs whole against Pebble:

    fake_cloudflare.py PORT CHALLTESTSRV_URL

TXT records go to challtestsrv's `/set-txt` and `/clear-txt`; a CNAME is
remembered and listed back. Every call is printed.
"""

import json
import sys
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

CHALLTEST = sys.argv[2].rstrip("/")
records = {}


def challtest(path, body):
    req = urllib.request.Request(CHALLTEST + path, data=json.dumps(body).encode(), method="POST")
    urllib.request.urlopen(req, timeout=5).read()


class Handler(BaseHTTPRequestHandler):
    def reply(self, body, status=200):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        if not self.headers.get("authorization", "").startswith("Bearer "):
            self.reply({"success": False, "errors": ["no token"]}, 403)
            return False
        return True

    def do_GET(self):
        if not self.authorized():
            return
        q = parse_qs(urlparse(self.path).query)
        found = [
            {"id": i, **r}
            for i, r in records.items()
            if r["type"] == q.get("type", [""])[0] and r["name"] == q.get("name", [""])[0]
        ]
        print("GET", q, "->", len(found), flush=True)
        self.reply({"success": True, "result": found})

    def do_POST(self):
        if not self.authorized():
            return
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        rid = uuid.uuid4().hex
        records[rid] = {"type": body["type"], "name": body["name"], "content": body["content"]}
        if body["type"] == "TXT":
            challtest("/set-txt", {"host": body["name"] + ".", "value": body["content"]})
        print("POST", body["type"], body["name"], "proxied" if body.get("proxied") else "", flush=True)
        self.reply({"success": True, "result": {"id": rid}})

    def do_DELETE(self):
        if not self.authorized():
            return
        rid = self.path.rsplit("/", 1)[-1]
        record = records.pop(rid, None)
        if record and record["type"] == "TXT":
            challtest("/clear-txt", {"host": record["name"] + "."})
        print("DELETE", record and record["name"], flush=True)
        self.reply({"success": True, "result": {"id": rid}})

    def log_message(self, *_):
        pass


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
