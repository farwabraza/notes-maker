# Ward — Exam Study Engine

Ward turns raw medical course material into a study system. Paste your notes (or drop a `.md`/`.txt` file) and it restructures everything around **how the topic is actually examined** — then gives you revision sheets, practice questions, a ruthless day-before summary, and spaced-repetition review.

It runs on **pure logic** — no AI needed, no account, no network. Claude is used for exactly one *optional* extra (a few bonus practice questions per topic), and only if you choose to add a key.

---

## What it does

Ward reads your material and picks one of two strategies automatically:

- **Exam-driven** — if your notes contain past exam questions (numbered `Q1…Qn`, "examined", oral-exam recall, etc.), it treats those questions as the source of truth. It surfaces what's been tested, extracts the traps (🚩), mnemonics (🧠), key numbers, and builds cards straight off the real questions.
- **Concept-driven** — if you only have lecture/textbook material, it extracts definitions, key concepts, high-yield (🔥) items, and generates situational + fill-in-the-blank practice from the concepts themselves.

You don't choose the mode — it detects it and shows you which one it picked (with a chip in the header). Two full worked examples are bundled (a nephrology oral-exam guide → exam-driven, and a neuropsychology guide → concept-driven) so you can try it immediately with the **Load a sample** buttons.

### The five tabs
- **Sources** — paste/drop material, build a deck, pick a bundled sample, manage decks.
- **Revise** — the generated revision sheet: topics ranked by testing weight, each with a "heat spine" showing how heavily it's examined.
- **Practice** — practice questions with tap-to-reveal answers.
- **Day-before** — a ruthless high-yield cut: only the hottest topics, every trap, every must-know number. What you read the night before.
- **Review** — spaced repetition (SM-2). Grade each card Again / Hard / Good / Easy; it schedules the next appearance.

Everything is saved in your browser (localStorage). Decks, review progress, and settings persist across sessions on that device.

---

## Quick start (no install)

Open `index.html` in any modern browser and press **Load a sample**. That's the whole app — the file is self-contained.

> Note on Word docs: the drop zone accepts `.md` and `.txt`. If your material is a `.docx`, open it, Select-All, and paste the text into the box. (The bundled nephrology sample was originally a Word doc, already converted for you.)

---

## Deploy on Replit + save to your phone

Doing it this way gives you a URL you can open on your phone and **install like an app** — full screen, offline, on your home screen.

### 1. Create the Repl
1. Go to **replit.com**, sign in, and click **Create Repl**.
2. Choose the **Python** template, name it `ward`, and create it.
3. Delete the default `main.py` it generates (you're about to upload your own).

### 2. Upload the app
1. In the Files panel, click the **⋮ (three dots) → Upload folder**, and upload the whole `studyapp` folder — *or* drag every file from `studyapp/` into the file list.
   Make sure these all land at the **top level** of the Repl:
   `index.html`, `engine.js`, `app.js`, `samples.js`, `service-worker.js`, `manifest.json`, `main.py`, `icon-192.png`, `icon-512.png`, and the two config files `.replit` and `replit.nix`.
2. If Replit hides dotfiles, click **Show hidden files** so `.replit` is present. It's what makes the **Run** button work.

### 3. Run it
1. Press **Run**. The console should print `Ward running → http://0.0.0.0:3000`.
2. A **Webview** pane opens with the app. Click the **↗ / "Open in new tab"** icon to get the full URL (looks like `https://ward.<your-username>.repl.co`).
3. Open that URL and confirm **Load a sample** works.

> The server (`main.py`) uses only the Python standard library — nothing to `pip install`. It exists purely to serve the files so the phone install works offline.

### 4. (Optional) Turn on Claude enrichment
Only needed if you want the **"+ more practice"** button that asks Claude for a few extra exam-style questions on a topic. The app is fully functional without it.
1. In the Repl, open the **Secrets** tool (🔒 lock icon).
2. Add a secret named `ANTHROPIC_API_KEY` with your key as the value.
3. (Optional) add `CLAUDE_MODEL` — defaults to `claude-sonnet-4-6`.
4. Press **Run** again. The console will now say `Claude enrichment: ON`.

Without a key the enrichment button simply stays off; everything else is unaffected.

### 5. Save it to your phone's home screen

**iPhone / iPad (Safari):**
1. Open your Repl's URL in **Safari**.
2. Tap the **Share** button (the square with an up-arrow).
3. Scroll down, tap **Add to Home Screen**, then **Add**.
4. Launch it from the new "Ward" icon — it opens full-screen, no browser bar.

**Android (Chrome):**
1. Open the URL in **Chrome**.
2. Tap the **⋮** menu (top right).
3. Tap **Add to Home screen** → **Install**.
4. Launch from the icon.

After the first load with a network connection, the app caches itself (via `service-worker.js`) and **works offline** — on a plane, in a basement exam hall, wherever. Your decks live on the device.

> Keep-alive note: free Repls sleep when idle. Once the app is installed to your home screen and has loaded once, it runs offline from cache, so a sleeping Repl doesn't stop you studying. You only need it awake to load the very first time or to fetch fresh enrichment.

---

## Deploy anywhere else

Ward is just static files plus one optional tiny server.

- **Any static host** (GitHub Pages, Netlify, Vercel, S3): upload the folder; `index.html` is the entry point. Everything works except the optional enrichment button (which needs the Python server).
- **Locally with the server:** `python3 main.py` then open `http://localhost:3000`. Set `PORT` to change the port, `ANTHROPIC_API_KEY` to enable enrichment.
- **Locally without Python:** just open `index.html`.

---

## Using your own material

1. Go to **Sources**.
2. Paste your notes into the box, or drop a `.md`/`.txt` file.
3. Give the deck a name and click **Build deck**.
4. Ward detects the mode and builds everything. Switch tabs to study.

### Markers it understands
You don't need these, but if your notes use them, Ward reads them as signal:

| Marker | Meaning |
|--------|---------|
| 🔥 | high-yield / has appeared on exams |
| 🚩 | exam trap (surfaced prominently + in day-before) |
| 🧠 | mnemonic / memory trick |
| ⭐ | key line |
| 🔑 | key mechanism |
| 🎯 | an MCQ block |
| 📚 | source reference |
| `Q1:`, `Q2:` … | numbered exam questions (triggers exam-driven mode) |
| `> text` | a definition (blockquote) |

---

## How it works (for the curious)

- `engine.js` — the whole brain. Parses blocks, detects mode, extracts definitions/mnemonics/traps/MCQs/reference tables/clinical numbers, scores each topic by testing weight (`heat×3 + isQuestion×4 + traps×2 + …`), generates the revision/day-before/practice outputs, and runs the SM-2 spaced-repetition scheduler. Zero DOM dependencies — same file runs in Node and the browser.
- `app.js` — the UI controller and localStorage persistence.
- `index.html` — the shell + clinical dark/light theme (the amber "heat spine" is the signature).
- `samples.js` — the two bundled example guides, so samples work fully offline.
- `service-worker.js` + `manifest.json` + icons — what makes it installable and offline-capable.
- `main.py` — optional stdlib-only server; serves the app and proxies the one enrichment endpoint.

---

## Files

```
studyapp/
├── index.html          app shell + theme
├── engine.js           parser + scheduler (logic core, no deps)
├── app.js              UI controller + storage
├── samples.js          bundled example guides
├── service-worker.js   offline caching
├── manifest.json       PWA manifest
├── icon-192.png        app icons
├── icon-512.png
├── main.py             optional backend (stdlib only)
├── .replit             Replit run config
└── replit.nix          Replit environment
```

No build step. No dependencies. No account required.
