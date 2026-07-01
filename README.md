# Ward — Exam Study Engine

Ward turns a finished study guide into a study *system*: a revision sheet, practice questions, a ruthless day-before summary, and spaced-repetition review — all restructured around **how the topic is actually examined**.

It runs on **pure logic** — no AI needed, no account, no network, works offline. An **optional** API step (any provider you choose) can generate a few extra practice questions per topic, but everything else works with nothing configured.

---

## The workflow

Ward has two halves, and you can use just the first:

1. **Build the guide** (in a Claude chat) — hand Claude your past questions + your notes and get back a comprehensive guide weighted toward what professors ask, with a short "not asked" appendix. This synthesis is the AI-heavy part and it lives in a normal Claude conversation. **See `GUIDE-TEMPLATE.md`** for a ready-to-paste prompt and the exact format.
2. **Study the guide** (in Ward) — paste that guide into Ward. It detects the mode, extracts everything, and builds the study machinery. This half is pure offline logic — no key.

If you already write your own guides, skip step 1 and just paste them in.

### Two modes, detected automatically
- **Exam-driven** — guide contains past questions (numbered `Qn`, "examined", oral-recall language). Ward treats those questions as the source of truth: surfaces what's tested, pulls traps (🚩), mnemonics (🧠), and key numbers, and builds cards off the real questions.
- **Concept-driven** — only lecture/textbook material. Ward extracts definitions and key concepts and generates situational + fill-in-the-blank practice.

You don't pick the mode — a chip in the header shows which it chose. Two worked examples are bundled (a nephrology oral-exam guide → exam-driven; a neuropsychology guide → concept-driven). Hit **Load a sample** to try instantly.

### The five tabs
**Sources** (build/manage decks) · **Revise** (ranked revision sheet with the amber "heat spine") · **Practice** (tap-to-reveal questions) · **Day-before** (only the hottest topics, every trap, every must-know number) · **Review** (SM-2 spaced repetition — grade Again/Hard/Good/Easy).

---

## No upload limit

Decks are stored in your browser via **IndexedDB**, so capacity is bound by your device's disk, not the old ~5MB localStorage cap. Paste in as many full-course guides as you like. It's still fully offline and local to the device; nothing is uploaded anywhere. (If you used an earlier localStorage version, your existing decks migrate over automatically on first load.)

> The drop zone accepts `.md`/`.txt`. For a `.docx`, open it, Select-All, and paste the text into the box.

---

## Quick start (no install)

Open `index.html` in any modern browser and press **Load a sample**. That's the whole app.

---

## Deploy on Replit + save to your phone

Gives you a URL you can open on your phone and **install like an app** — full screen, offline, on your home screen.

### 1. Create the Repl
1. Go to **replit.com**, sign in, **Create Repl**, choose the **Python** template, name it `ward`.
2. Delete the default `main.py` it generates.

### 2. Upload the app
Upload the whole `studyapp` folder (Files panel → **⋮ → Upload folder**), or drag every file in. These must land at the **top level**:
`index.html`, `engine.js`, `app.js`, `samples.js`, `service-worker.js`, `manifest.json`, `main.py`, `icon-192.png`, `icon-512.png`, plus `.replit` and `replit.nix`.
If Replit hides dotfiles, enable **Show hidden files** so `.replit` is visible — it's what makes **Run** work.

### 3. Run
Press **Run**. The console prints `Ward running → http://0.0.0.0:3000` and a Webview opens. Click **Open in new tab** for the full URL (`https://ward.<username>.repl.co`). Confirm **Load a sample** works.

> `main.py` uses only the Python standard library — nothing to install. It exists to serve the files so the phone install works offline.

### 4. Save to your phone's home screen
**iPhone/iPad (Safari):** open the URL → **Share** → **Add to Home Screen** → **Add**.
**Android (Chrome):** open the URL → **⋮** → **Add to Home screen** → **Install**.

After the first online load, the service worker caches the app and it **works offline** thereafter. Free Repls sleep when idle, but once installed and loaded once, the app runs from cache — a sleeping Repl doesn't stop you studying (you only need it awake for the first load and for fresh enrichment).

---

## Deploy on GitHub (Pages)

Ward is static, so GitHub Pages hosts it directly — great for the offline PWA. The only thing Pages can't do is the optional enrichment button (that needs the Python server; see below).

1. Create a repo and upload the `studyapp` files to the root (or a `/docs` folder).
2. Repo **Settings → Pages** → Source: **Deploy from a branch** → pick your branch and `/root` (or `/docs`).
3. Wait for the green check, then open `https://<username>.github.io/<repo>/`.
4. Install to your phone's home screen exactly as in the Replit steps above.

Everything works on Pages except **+ more practice**. If you want enrichment with a static host, run the enrichment provider separately (any host that can run `main.py`, or a serverless function) and the app will call `/api/enrich`.

---

## Optional: enrichment with any provider

The **+ more practice** button asks a model for a few extra exam-style questions on a topic. It's the *only* feature that touches the network, and only if you configure it. The provider is pluggable — set environment variables (in Replit: the **Secrets** 🔒 panel).

| Provider | `PROVIDER` | `MODEL` (example) | `API_KEY` | `BASE_URL` (optional) |
|----------|-----------|-------------------|-----------|-----------------------|
| Claude (Anthropic) | `anthropic` | `claude-sonnet-4-6` | your Anthropic key | default `https://api.anthropic.com` |
| OpenAI | `openai` | `gpt-4o-mini` | your OpenAI key | default `https://api.openai.com/v1` |
| OpenRouter | `openai` | e.g. `anthropic/claude-3.5-sonnet` | your OpenRouter key | `https://openrouter.ai/api/v1` |
| Groq | `openai` | e.g. `llama-3.3-70b-versatile` | your Groq key | `https://api.groq.com/openai/v1` |
| Local (Ollama/LM Studio/vLLM) | `openai` | your local model name | any placeholder | e.g. `http://localhost:11434/v1` |
| Google Gemini | `gemini` | `gemini-2.5-flash` | your Gemini key | default Google endpoint |

Set `PROVIDER`, `MODEL`, and `API_KEY` (a bare `API_KEY` works, or the classic `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY`). Anything OpenAI-compatible uses `PROVIDER=openai` with a `BASE_URL`. Press **Run** again; the console shows `Enrichment: ON (provider=…, model=…)`. Check `/api/health` to confirm.

**On NotebookLM:** there's no public consumer API you can drop a key into — Google's only official surface is an *enterprise* API that needs a Google Cloud project, IAM roles, and OAuth tokens, and its outputs are summary/podcast-oriented rather than "answer these exam questions from my notes." So it isn't wired in as a provider. The natural Google option here is the **Gemini API** (`PROVIDER=gemini`), which is a real developer API with a simple key.

Without any of this, enrichment just stays off and nothing else is affected.

---

## Deploy anywhere else

- **Any static host** (Netlify, Vercel, S3): upload the folder; `index.html` is the entry point. Everything works except enrichment.
- **Locally with the server:** `python3 main.py`, open `http://localhost:3000`. `PORT` changes the port; provider vars enable enrichment.
- **Locally without Python:** just open `index.html`.

---

## Markers Ward understands

You don't need these, but if your guide uses them, Ward reads them as signal. `GUIDE-TEMPLATE.md` has the full spec.

| Marker | Meaning |
|--------|---------|
| 🔥 | high-yield / appeared on exams |
| 🚩 | exam trap (surfaced + in day-before) |
| 🧠 | mnemonic |
| ⭐ | key line |
| 🔑 | key mechanism |
| `**Qn: …**` | numbered exam question (triggers exam-driven mode) |
| `> text` | definition |

---

## Files

```
studyapp/
├── index.html          app shell + theme
├── engine.js           parser + scheduler (logic core, no deps)
├── app.js              UI controller + IndexedDB storage
├── samples.js          bundled example guides
├── service-worker.js   offline caching
├── manifest.json       PWA manifest
├── icon-192.png        app icons
├── icon-512.png
├── main.py             optional backend (stdlib only, multi-provider)
├── .replit             Replit run config
├── replit.nix          Replit environment
├── GUIDE-TEMPLATE.md   prompt + format for building guides
└── README.md
```

No build step. No dependencies. No account required.
