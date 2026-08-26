"""Throwaway stand-in for Aptabase's ingest API.

Run it, then start the app with `APTABASE_KEY=A-DEV-000` — a `DEV` key points
the client at localhost:3000 — to see exactly what the wire carries.
"""

import json
from http.server import BaseHTTPRequestHandler, HTTPServer


class Sink(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        print(f"POST {self.path}  App-Key={self.headers.get('App-Key')}")
        print(json.dumps(json.loads(body), indent=2), flush=True)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):
        pass


HTTPServer(("127.0.0.1", 3000), Sink).serve_forever()
