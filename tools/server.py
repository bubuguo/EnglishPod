#!/usr/bin/env python3
"""Self-hosted server for the EnglishPod PWA (zero dependencies).

Usage: python3 server.py [port]

Serves the static app from ./public on http://localhost:8080 (or the given
port). Media is streamed directly from archive.org by the browser, so no
proxy is required.
"""
import http.server
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()

    def guess_type(self, path):
        ctype = super().guess_type(path)
        if path.endswith(".webmanifest"):
            ctype = "application/manifest+json"
        elif path.endswith(".js"):
            ctype = "text/javascript"
        return ctype


class Server(http.server.ThreadingHTTPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    print(f"Serving {ROOT} at http://localhost:{PORT}")
    Server(("0.0.0.0", PORT), Handler).serve_forever()
