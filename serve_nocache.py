"""Static dev server for PianoCoach with two things the stdlib server lacks:

  1. no-cache headers  -> edited JS/CSS/JSON are always fresh on reload
     (the browser otherwise caches ES modules aggressively).
  2. HTTP Range support -> <audio> seeking works, which the reference-preview
     (§15) needs. Python's SimpleHTTPRequestHandler does NOT serve 206/Range,
     so media seeking stalls without this.

Usage: python serve_nocache.py [port]   (default 8123, serves this folder)
"""
import http.server
import os
import re
import socketserver
import sys
from http import HTTPStatus
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
ROOT = str(Path(__file__).resolve().parent)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Accept-Ranges", "bytes")   # advertise range support
        super().end_headers()

    def do_GET(self):
        path = self.translate_path(self.path)
        rng = self.headers.get("Range")
        # only handle byte-range requests for real files; everything else -> base
        if not rng or os.path.isdir(path) or not os.path.isfile(path):
            return super().do_GET()

        size = os.path.getsize(path)
        m = re.match(r"bytes=(\d*)-(\d*)", rng)
        if not m:
            return super().do_GET()
        start = int(m.group(1)) if m.group(1) else 0
        end = int(m.group(2)) if m.group(2) else size - 1
        end = min(end, size - 1)
        if start > end or start >= size:
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return

        length = end - start + 1
        self.send_response(HTTPStatus.PARTIAL_CONTENT)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            self.wfile.write(f.read(length))


socketserver.TCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"PianoCoach dev server (no-cache + Range) on http://127.0.0.1:{PORT}  (root: {ROOT})")
    httpd.serve_forever()
