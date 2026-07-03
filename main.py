"""
Ward — optional backend.

The static app (open index.html) does all offline study with pure logic. This
small stdlib-only server adds the features that need the network:

  /api/enrich       a few extra practice questions on a topic   (needs LLM key)
  /api/guide        author a 100%-coverage study guide from raw material +
                    (optional) past questions                    (needs LLM key)
  /api/sbobina      rewrite a raw transcript into a clean lecture write-up,
                    with figure slots                            (needs LLM key)
  /api/cheatsheet   condense a guide/sbobina into a one-pager    (needs LLM key)
  /api/image-search open-licensed image lookup for sbobina figures
                    (Wikimedia Commons + Openverse; NO key needed)

The LLM routes use whichever PROVIDER you configure (see below). Image search
never needs a key. With no key set, only the LLM routes are disabled; static
study and PDF export still work everywhere.

Run locally:  python main.py       On Replit: press Run, set PROVIDER/API_KEY
in Secrets (see README). GitHub Pages can host the static study app but cannot
run these endpoints — use Replit (or any Python host) for generation.
"""
import json
import os
import re
import urllib.request
import urllib.error
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", 3000))

# ---- Provider config -------------------------------------------------------
# PROVIDER selects the API shape. The app works fully WITHOUT any of this;
# these only power the optional "+ more practice" enrichment button.
#   anthropic  -> Claude            (api.anthropic.com)
#   openai     -> OpenAI + any OpenAI-compatible endpoint
#                 (OpenRouter, Groq, Together, LM Studio, Ollama, vLLM…)
#   gemini     -> Google Gemini     (generativelanguage.googleapis.com)
# Set MODEL and API_KEY to match. BASE_URL overrides the default host, which
# is how you point "openai" at OpenRouter/Groq/a local server.
PROVIDER = os.environ.get("PROVIDER", "anthropic").strip().lower()
# accept a generic API_KEY, or the provider-specific classics, for convenience
API_KEY = (os.environ.get("API_KEY")
           or os.environ.get("ANTHROPIC_API_KEY")
           or os.environ.get("OPENAI_API_KEY")
           or os.environ.get("GEMINI_API_KEY")
           or os.environ.get("GOOGLE_API_KEY")
           or "").strip()

_DEFAULT_BASE = {
    "anthropic": "https://api.anthropic.com",
    "openai": "https://api.openai.com/v1",
    "gemini": "https://generativelanguage.googleapis.com",
}
_DEFAULT_MODEL = {
    "anthropic": "claude-sonnet-4-6",
    "openai": "gpt-4o-mini",
    "gemini": "gemini-2.5-flash",
}
BASE_URL = (os.environ.get("BASE_URL") or _DEFAULT_BASE.get(PROVIDER, "")).rstrip("/")
MODEL = os.environ.get("MODEL") or os.environ.get("CLAUDE_MODEL") or _DEFAULT_MODEL.get(PROVIDER, "")

MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".png": "image/png", ".svg": "image/svg+xml", ".md": "text/markdown; charset=utf-8",
    ".webmanifest": "application/manifest+json",
}


def _call_llm(prompt, max_tokens=900):
    """Send one prompt to the configured provider; return the raw text reply."""
    if not API_KEY:
        raise RuntimeError("No API key set on the server")
    if PROVIDER == "anthropic":
        url = f"{BASE_URL}/v1/messages"
        body = json.dumps({
            "model": MODEL, "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}],
        }).encode()
        headers = {"content-type": "application/json", "x-api-key": API_KEY,
                   "anthropic-version": "2023-06-01"}
    elif PROVIDER == "gemini":
        url = f"{BASE_URL}/v1beta/models/{MODEL}:generateContent?key={API_KEY}"
        body = json.dumps({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"maxOutputTokens": max_tokens},
        }).encode()
        headers = {"content-type": "application/json"}
    else:  # "openai" and any OpenAI-compatible endpoint (OpenRouter, Groq, Ollama…)
        url = f"{BASE_URL}/chat/completions"
        body = json.dumps({
            "model": MODEL, "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}],
        }).encode()
        headers = {"content-type": "application/json", "authorization": f"Bearer {API_KEY}"}

    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read().decode())

    if PROVIDER == "anthropic":
        return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    if PROVIDER == "gemini":
        cands = data.get("candidates", [])
        parts = (cands[0].get("content", {}).get("parts", []) if cands else [])
        return "".join(p.get("text", "") for p in parts)
    choices = data.get("choices", [])
    return choices[0].get("message", {}).get("content", "") if choices else ""


def enrich(topic, mode, title):
    """Ask the configured model for 3 exam-style Q/A pairs. Returns list[{q,a}]."""
    style = ("past-paper oral exam questions with model answers"
             if mode == "exam-driven"
             else "situational exam questions that test understanding")
    prompt = (
        f"You are a {title} examiner. Write exactly 3 {style} on the topic "
        f'"{topic}". Return ONLY a JSON array, no prose, no markdown fences, '
        'of objects with keys "q" (the question) and "a" (a concise correct '
        "answer, 1-3 sentences). Make them the kind a strict professor asks."
    )
    text = _call_llm(prompt).strip()
    text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        arr = json.loads(text)
    except Exception:
        s, e = text.find("["), text.rfind("]")
        arr = json.loads(text[s:e + 1]) if s >= 0 and e > s else []
    return [{"q": x.get("q", ""), "a": x.get("a", "")} for x in arr if isinstance(x, dict)][:3]


# ============================================================================
#  Sbobina maker — turn a raw transcript / rough notes into a clean, readable
#  written-up lecture (Italian-university "sbobina" style) with figure slots.
# ============================================================================
SBOBINA_RULES = (
    "Write in clear, flowing academic prose — full paragraphs, not bullet dumps. "
    "This is a written-up lecture (an Italian-university 'sbobina'): faithful to the "
    "material, well organised, readable on its own.\n"
    "FORMAT (markdown):\n"
    "- Use ## for each section heading. Phrase headings the way the lecturer frames "
    "them (often as a question, e.g. '## How does the urban environment affect mental health?').\n"
    "- Explain in paragraphs. Use '- ' bullet lists ONLY for genuine enumerations "
    "(levels, criteria, steps).\n"
    "- Use '> ' blockquotes for key definitions.\n"
    "- Bold the truly key terms with **term**.\n"
    "- Where a figure would genuinely help the reader (an anatomical structure, a "
    "concept diagram, a chart), insert on ITS OWN LINE a figure slot exactly like:\n"
    "  {{IMG: concise visual search query | descriptive figure caption}}\n"
    "  Use at most one figure slot per section, and only when it truly aids understanding. "
    "Prefer generic anatomy/concept queries (e.g. 'amygdala brain anatomy', "
    "'normal distribution vs power law') that open-licensed libraries will have.\n"
    "Do NOT invent facts, citations, or data not present in the source. Do not add a "
    "title header or author line — only the body sections."
)


def _chunk(text, size=11000):
    """Split on blank lines into chunks under ~size chars, keeping paragraphs whole."""
    paras = text.replace("\r\n", "\n").split("\n\n")
    chunks, cur = [], ""
    for p in paras:
        if len(cur) + len(p) + 2 > size and cur:
            chunks.append(cur)
            cur = ""
        cur += (("\n\n" if cur else "") + p)
    if cur.strip():
        chunks.append(cur)
    return chunks or [text]


def make_sbobina(transcript, title="this lecture"):
    """Return markdown body (with {{IMG:...}} slots). Chunks long transcripts."""
    chunks = _chunk(transcript)
    parts = []
    for i, ch in enumerate(chunks):
        pos = (f"\n\nThis is part {i + 1} of {len(chunks)} of the transcript; continue the "
               "write-up coherently and do not repeat earlier sections."
               if len(chunks) > 1 else "")
        prompt = (
            f"You are writing up a lecture titled \"{title}\" from the raw transcript / "
            f"notes below.{pos}\n\n{SBOBINA_RULES}\n\n--- SOURCE ---\n{ch}\n--- END SOURCE ---"
        )
        parts.append(_call_llm(prompt, max_tokens=4000).strip())
    body = "\n\n".join(parts)
    for fence in ("```markdown", "```md", "```"):
        if body.startswith(fence):
            body = body[len(fence):]
        if body.endswith("```"):
            body = body[:-3]
    return body.strip()


# ============================================================================
#  Guide maker — the intelligent step. Takes raw material + (optionally) past
#  exam questions that live separately, and AUTHORS a 100%-coverage study guide:
#    - questions given  -> exam-driven: answer EVERY past question at depth
#    - no questions      -> concept-driven: build from material + GENERATE questions
#  Output is the markdown format engine.js parses into study cards.
# ============================================================================
# Chars of material we keep as context for one guide/cheatsheet call. Sized to sit
# well inside a large model context window (~200k tokens) with room for the answer,
# so it's non-binding for any realistic single course. It is NOT an upload/page limit:
# you can paste or drop a file of any size — long material is chunked (concept guides,
# sbobine) or batched by question (exam guides); this only bounds one API call.
MAX_CTX_CHARS = 300000

GUIDE_EXAM_RULES = (
    "Output GitHub-flavoured markdown. For EACH question, write:\n"
    "  `## <a short topic title for this question>`\n"
    "  `**Q<n>: <the full question text>?**`   (keep the given Q number)\n"
    "  then a thorough, exam-ready answer that a strict examiner would accept in full.\n"
    "Within the answer, surface cues on their own lines where they apply:\n"
    "  `> ` blockquote for a crisp definition;  a line starting 🚩 for each exam trap;\n"
    "  🧠 for a mnemonic / memory hook;  ⭐ for the single most important line;\n"
    "  🔑 for a must-state fact;  and state key thresholds / doses / values explicitly.\n"
    "Answer from the MATERIAL; add only standard, uncontroversial knowledge where the "
    "material is silent, and never contradict it. Be exhaustive — do not skip or merge "
    "questions. This must be 100% coverage of the questions given."
)
GUIDE_CONCEPT_RULES = (
    "There are no past questions, so build the guide from the material itself. Output "
    "GitHub-flavoured markdown:\n"
    "  - Break the material into topics, each as `## <topic>`.\n"
    "  - Under each: a `> ` one-line definition, then the key explanation in tight prose; "
    "add 🧠 mnemonics where useful; mark the highest-yield topics with a 🔥 on the heading line.\n"
    "  - After each major topic add a short `Practice:` line of 1-2 situational questions a "
    "professor might ask, each written as `- Q: <question>? — A: <concise model answer>` "
    "(plain list items, NOT bold headings).\n"
    "  - Cover the whole material; don't drop sections."
)


def _split_questions(text):
    out = []
    for line in (text or "").replace("\r\n", "\n").split("\n"):
        s = line.strip()
        if not s:
            continue
        s = re.sub(r"^(q\s*)?\d+\s*[\).:\-]\s*", "", s, flags=re.I)  # 1.  1)  Q1:
        s = re.sub(r"^[-*•]\s*", "", s)
        if len(s) > 3:
            out.append(s)
    return out


def _concept_sections(material, title, extra, note=""):
    """Build a full concept-driven guide from the material (chunked)."""
    chunks = _chunk(material)
    parts = []
    for i, ch in enumerate(chunks):
        pos = f" (part {i + 1} of {len(chunks)}; continue coherently)" if len(chunks) > 1 else ""
        prompt = (
            f'You are building a concept-driven study guide titled "{title}"{pos} from the '
            f"lecture / reading material below.\n{GUIDE_CONCEPT_RULES}{note}{extra}\n\n"
            f"--- MATERIAL ---\n{ch}\n--- END ---"
        )
        parts.append(_call_llm(prompt, max_tokens=4000).strip())
    return "\n\n".join(p for p in parts if p)


def make_guide(material, questions="", instructions="", title="this exam", mode="auto", partial=False):
    material = (material or "").strip()
    qlist = _split_questions(questions) if (questions or "").strip() else []
    exam = (mode == "exam") or (mode == "auto" and len(qlist) >= 1)
    extra = f"\nAlso follow these instructions from the student: {instructions.strip()}" if (instructions or "").strip() else ""

    if exam and qlist:
        mat = material[:MAX_CTX_CHARS]
        parts, B = [], 8
        for start in range(0, len(qlist), B):
            batch = qlist[start:start + B]
            numbered = "\n".join(f"Q{start + k + 1}: {q}" for k, q in enumerate(batch))
            prompt = (
                f'You are building a 100%-coverage oral-exam study guide titled "{title}". '
                "Below is the course material, then a batch of past exam questions. Answer each "
                f"question thoroughly USING the material.\n{GUIDE_EXAM_RULES}{extra}\n\n"
                f"--- MATERIAL ---\n{mat}\n--- END MATERIAL ---\n\n"
                f"--- QUESTIONS ---\n{numbered}\n--- END QUESTIONS ---"
            )
            parts.append(_call_llm(prompt, max_tokens=4000).strip())
        answered = "\n\n".join(p for p in parts if p)

        if partial:
            # The provided questions are only SOME of what's examinable: answer them,
            # then ALSO build a full guide from the notes so nothing is missed.
            note = ("\nNOTE: some real past questions have already been answered separately; "
                    "still cover the entire material thoroughly here so the guide is complete, "
                    "generating your own practice questions across all topics.")
            full = _concept_sections(material, title, extra, note)
            body = ("## Known past questions — answer these for sure\n\n"
                    + answered
                    + "\n\n## Full study guide — complete coverage of the notes\n\n"
                    + full)
        else:
            # Treat the questions as the complete set: tight coverage + short appendix.
            try:
                asked = ", ".join(qlist)[:1500]
                tail = (
                    f'From the course material below for "{title}", output exactly two markdown '
                    "sections and nothing else:\n"
                    "1) `## Numbers to have cold` — a table `| Item | Value |` of every threshold, "
                    "dose, cutoff or value worth memorising.\n"
                    "2) `## In the notes but not asked` — a bullet list of important points in the "
                    f"material NOT covered by these questions: {asked}\n\n"
                    f"--- MATERIAL ---\n{mat}\n--- END ---"
                )
                answered += "\n\n" + _call_llm(tail, max_tokens=1500).strip()
            except Exception:
                pass
            body = answered
    else:
        body = _concept_sections(material, title, extra)

    for fence in ("```markdown", "```md", "```"):
        if body.startswith(fence):
            body = body[len(fence):]
    if body.endswith("```"):
        body = body[:-3]
    return body.strip()


def make_cheatsheet(content, title="this subject"):
    """Condense a guide/sbobina into a dense one-page cheat sheet (markdown)."""
    content = content[:MAX_CTX_CHARS]
    prompt = (
        f"Condense the material below into a DENSE one-page cheat sheet for \"{title}\" "
        "to review minutes before an exam. Markdown only. Rules: use ## for a few tight "
        "sections; under each, short '- ' bullets (fragments, not sentences); bold key "
        "terms; include a '## Numbers' section if any figures matter; include a "
        "'## Don't confuse' section for easily-mixed-up pairs; add mnemonics where useful. "
        "Be ruthless — only the highest-yield facts. No preamble, no images.\n\n"
        f"--- MATERIAL ---\n{content}\n--- END ---"
    )
    body = _call_llm(prompt, max_tokens=2500).strip()
    for fence in ("```markdown", "```md", "```"):
        if body.startswith(fence):
            body = body[len(fence):]
    if body.endswith("```"):
        body = body[:-3]
    return body.strip()


# ============================================================================
#  Image search — OPEN-LICENSED ONLY (Wikimedia Commons, then Openverse).
#  Server-side so the browser avoids CORS. No API key required.
# ============================================================================
_UA = "WardStudyApp/1.0 (educational study tool; contact: user)"


def _http_get_json(url, headers=None, timeout=15):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": _UA}, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _strip_html(s):
    out, depth = [], 0
    for c in s or "":
        if c == "<":
            depth += 1
        elif c == ">":
            depth = max(0, depth - 1)
        elif depth == 0:
            out.append(c)
    return "".join(out).strip()


def _parse_commons(data):
    pages = (data.get("query", {}) or {}).get("pages", {}) or {}
    # keep search order via 'index'
    for pg in sorted(pages.values(), key=lambda p: p.get("index", 999)):
        info = (pg.get("imageinfo") or [{}])[0]
        mime = info.get("mime", "")
        url = info.get("thumburl") or info.get("url")
        if not url or not mime.startswith("image/") or mime == "image/tiff":
            continue
        meta = info.get("extmetadata", {}) or {}
        lic = _strip_html(meta.get("LicenseShortName", {}).get("value", "")) or "see source"
        artist = _strip_html(meta.get("Artist", {}).get("value", "")) or "Wikimedia Commons"
        return {
            "url": url,
            "title": pg.get("title", "").replace("File:", ""),
            "source": "Wikimedia Commons",
            "license": lic,
            "attribution": f"{artist} / Wikimedia Commons ({lic})",
            "page": info.get("descriptionurl", ""),
        }
    return None


def _parse_openverse(data):
    for it in data.get("results", []) or []:
        url = it.get("url") or it.get("thumbnail")
        if not url:
            continue
        creator = it.get("creator") or "Unknown"
        lic = (it.get("license") or "").upper()
        ver = it.get("license_version") or ""
        return {
            "url": url,
            "title": it.get("title", ""),
            "source": "Openverse",
            "license": f"CC {lic} {ver}".strip(),
            "attribution": f"{creator} (CC {lic} {ver})".strip(),
            "page": it.get("foreign_landing_url", ""),
        }
    return None


def image_search(query):
    """Return one open-licensed image dict, or None. Never raises."""
    q = urllib.parse.quote(query.strip())
    # 1) Wikimedia Commons
    try:
        url = ("https://commons.wikimedia.org/w/api.php?action=query&format=json"
               "&generator=search&gsrnamespace=6&gsrlimit=6"
               f"&gsrsearch={q}%20filetype:bitmap"
               "&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=900")
        hit = _parse_commons(_http_get_json(url))
        if hit:
            return hit
    except Exception:
        pass
    # 2) Openverse (Creative Commons aggregator)
    try:
        url = ("https://api.openverse.org/v1/images/?"
               f"q={q}&license_type=commercial,modification&mature=false&page_size=6")
        hit = _parse_openverse(_http_get_json(url))
        if hit:
            return hit
    except Exception:
        pass
    return None


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
        route = self.path.rstrip("/")
        if route not in ("/api/enrich", "/api/guide", "/api/sbobina", "/api/cheatsheet", "/api/image-search"):
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(n) or b"{}")
            if route == "/api/enrich":
                qs = enrich(payload.get("topic", ""), payload.get("mode", ""),
                            payload.get("title", "this course"))
                return self._send(200, {"questions": qs})
            if route == "/api/guide":
                md = make_guide(payload.get("material", ""), payload.get("questions", ""),
                                payload.get("instructions", ""), payload.get("title", "this exam"),
                                payload.get("mode", "auto"), bool(payload.get("partial", False)))
                return self._send(200, {"markdown": md})
            if route == "/api/sbobina":
                md = make_sbobina(payload.get("transcript", ""),
                                  payload.get("title", "this lecture"))
                return self._send(200, {"markdown": md})
            if route == "/api/cheatsheet":
                md = make_cheatsheet(payload.get("content", ""),
                                     payload.get("title", "this subject"))
                return self._send(200, {"markdown": md})
            if route == "/api/image-search":
                # image search needs no key; only the LLM routes do
                img = image_search(payload.get("query", ""))
                return self._send(200, {"image": img})
        except RuntimeError as e:
            self._send(400, {"error": str(e)})
        except urllib.error.HTTPError as e:
            self._send(502, {"error": f"{PROVIDER} API error {e.code}"})
        except Exception as e:
            self._send(500, {"error": f"{type(e).__name__}: {e}"})

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", ""):
            path = "/index.html"
        if path == "/api/health":
            return self._send(200, {"ok": True, "enrichment": bool(API_KEY),
                                     "provider": PROVIDER, "model": MODEL})
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
    if API_KEY:
        print(f"  Enrichment: ON  (provider={PROVIDER}, model={MODEL})")
    else:
        print("  Enrichment: off  (set API_KEY + PROVIDER to enable — see README)")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
