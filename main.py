"""
Ward — optional backend.

The app is FULLY FUNCTIONAL as static files (open index.html directly, or
serve this folder with any static host). This tiny server does two things:

  1. Serves the app (so it installs as a PWA and works offline).
  2. Adds ONE optional feature — /api/enrich — which asks Claude for a few
     extra exam-style practice questions on a topic. This is the only part
     that ever touches the network, and it only runs if you set an API key.
     Without a key, the app still does everything else with pure logic.

Run locally:      python main.py
On Replit:        press Run (see README). Set ANTHROPIC_API_KEY in Secrets
                  ONLY if you want the enrichment button.
"""
import json
import os
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", 3000))
API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")

MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".png": "image/png", ".svg": "image/svg+xml", ".md": "text/markdown; charset=utf-8",
    ".webmanifest": "application/manifest+json",
}


def enrich(topic, mode, title):
    """Ask Claude for 3 exam-style Q/A pairs. Returns list[{q,a}]."""
    if not API_KEY:
        raise RuntimeError("No ANTHROPIC_API_KEY set on the server")
    style = ("past-paper oral exam questions with model answers"
             if mode == "exam-driven"
             else "situational exam questions that test understanding")
    prompt = (
        f"You are a {title} examiner. Write exactly 3 {style} on the topic "
        f'"{topic}". Return ONLY a JSON array, no prose, no markdown fences, '
        'of objects with keys "q" (the question) and "a" (a concise correct '
        "answer, 1-3 sentences). Make them the kind a strict professor asks."
    )
    body = json.dumps({
        "model": MODEL,
        "max_tokens": 900,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=body, method="POST",
        headers={
            "content-type": "application/json",
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
        },
    )
    with urllib.request.urlopen(req, timeout=40) as r:
        data = json.loads(r.read().decode())
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    text = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        arr = json.loads(text)
    except Exception:
        # tolerate a leading/trailing sentence around the array
        s, e = text.find("["), text.rfind("]")
        arr = json.loads(text[s:e + 1]) if s >= 0 and e > s else []
    return [{"q": x.get("q", ""), "a": x.get("a", "")} for x in arr if isinstance(x, dict)][:3]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.rstrip("/") != "/api/enrich":
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(n) or b"{}")
            qs = enrich(payload.get("topic", ""), payload.get("mode", ""), payload.get("title", "this course"))
            self._send(200, {"questions": qs})
        except RuntimeError as e:
            self._send(400, {"error": str(e)})
        except urllib.error.HTTPError as e:
            self._send(502, {"error": f"Anthropic API error {e.code}"})
        except Exception as e:
            self._send(500, {"error": f"{type(e).__name__}: {e}"})

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", ""):
            path = "/index.html"
        if path == "/api/health":
            return self._send(200, {"ok": True, "enrichment": bool(API_KEY)})
        # static, path-traversal safe
        safe = os.path.normpath(os.path.join(ROOT, path.lstrip("/")))
        if not safe.startswith(ROOT) or not os.path.isfile(safe):
            return self._send(404, "Not found", "text/plain")
        ext = os.path.splitext(safe)[1]
        with open(safe, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        if ext in (".js", ".css", ".png"):
            self.send_header("Cache-Control", "public, max-age=3600")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    print(f"  Ward running →  http://0.0.0.0:{PORT}")
    print(f"  Claude enrichment: {'ON' if API_KEY else 'off (set ANTHROPIC_API_KEY to enable)'}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
