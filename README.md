# Ward — a self-contained exam-study workspace

Ward turns your course material into things you can actually study from, organised
by subject. It runs as an installable web app (PWA). Everything you make is stored
**on your device** and exportable as **PDF**.

Each **subject** is a self-contained folder holding three kinds of item:

| Item | What it is | Needs a key? |
|------|------------|--------------|
| **Structured guide** | Your material, authored into a 100%-coverage study guide. Give it past questions → it answers every one at depth (exam-driven); give it none → it builds from the material and generates questions (concept-driven). Then: revise sheet, practice cards, day-before summary, spaced-repetition review. | Yes (to build) |
| **Sbobina** | A raw transcript / rough notes rewritten into a clean, readable lecture write-up, with open-licensed figures. | Yes |
| **Cheat sheet** | A dense one-page condensation of a guide or sbobina. | Yes |

Delete a subject folder and everything in it goes with it — handy once an exam is done.

---

## Two ways to run it

**1. Static (offline study, no server).** Open `index.html`, or host the folder on
GitHub Pages / any static host. You get: guides, revise/practice/day-before/review,
and PDF export. The **makers that call an LLM (sbobina, cheat sheet, extra questions)
do not work statically** — there's no server to hold your key.

**2. On a server (full features).** Run `python main.py` (or press **Run** on Replit).
Now the sbobina maker, cheat-sheet maker, extra-questions and open-licensed image
lookup all work. This is the mode to use with your API key.

> Image lookup (Wikimedia Commons + Openverse) needs **no key** and is always
> open-licensed. Only the text-generation features use your LLM key.

---

## Plugging in your key (Replit)

1. Upload this folder to a new Replit (or import the repo). Press **Run** once — it
   serves the app on the web preview.
2. Open the **Secrets** panel (lock icon) and add secrets to match your key:

| Your key is from | `PROVIDER` | `API_KEY` | `MODEL` (optional) | `BASE_URL` (optional) |
|------------------|-----------|-----------|--------------------|------------------------|
| **Anthropic (Claude)** | `anthropic` | your key | `claude-sonnet-4-6` | — |
| **OpenAI** | `openai` | your key | `gpt-4o-mini` | — |
| **OpenRouter** | `openai` | your key | e.g. `anthropic/claude-3.5-sonnet` | `https://openrouter.ai/api/v1` |
| **Groq** | `openai` | your key | e.g. `llama-3.3-70b-versatile` | `https://api.groq.com/openai/v1` |
| **Google Gemini** | `gemini` | your key | `gemini-2.5-flash` | — |
| **Local (Ollama/LM Studio)** | `openai` | any non-empty value | your local model | `http://localhost:11434/v1` |

Only `PROVIDER` and `API_KEY` are required; `MODEL` and `BASE_URL` have sensible
defaults. Press **Run** again after setting secrets.

3. Check it took: open `…replit.dev/api/health` — it reports the provider and model,
   and whether a key is loaded.

That's it. Add a subject, tap **+ Sbobina**, paste a transcript, and generate.

---

## Deploying on Render

Ward's `main.py` already binds `0.0.0.0` and reads Render's `PORT`, so no code
changes are needed. Two Render-specific files are included: `requirements.txt` (so
Render detects a Python service — Ward has no dependencies, so it's effectively
empty) and `render.yaml` (an optional Blueprint). The `.replit` / `replit.nix` files
are ignored by Render; leave them or delete them.

**Option A — Blueprint (easiest).** Push this folder to a GitHub repo, then in Render:
**New → Blueprint**, pick the repo. It reads `render.yaml` and creates the service.
When prompted, paste your key into `API_KEY`, and change `PROVIDER` / `MODEL` if your
key isn't Anthropic (see the table above).

**Option B — Manual.** **New → Web Service**, connect the repo, then set:
- **Runtime:** Python
- **Build command:** `pip install -r requirements.txt`
- **Start command:** `python main.py`
- **Environment variables:** the same `PROVIDER` / `API_KEY` / (`MODEL` / `BASE_URL`)
  from the table above.
- **Health check path** (optional): `/api/health`

Then **Create Web Service**. When it's live, open `https://<your-app>.onrender.com/api/health`
to confirm the provider/model and that your key loaded.

**Free-tier note:** Render's free web services spin down after ~15 min idle and take
~50s to wake on the next visit — normal, not a bug. Generating a long sbobina makes
several sequential model calls, so give it a moment.

---

## Using it

1. **Library → + Subject** to make a folder (e.g. *Medical Psychology*).
2. Inside the subject:
   - **+ Guide** — *Build it for me*: paste your **course material** and, in the
     separate box, your **past exam questions** (one per line; leave blank if none).
     With questions it answers every one at depth; without, it builds from the material
     and generates questions. Or choose *I already have one* to import a guide that's
     already written (pure parsing, no key). See `GUIDE-TEMPLATE.md` for that format.
   - **+ Sbobina** — fill the header (course, professor, you) + paste the
     transcript → generates a lecture write-up. Long transcripts are chunked
     automatically, so there's no upload limit. Figures are sourced open-licensed
     with a caption + attribution; where nothing suitable is found you get a
     labelled placeholder.
   - **+ Cheat sheet** — pick a guide/sbobina (or paste text) → dense one-pager.
3. Open any item, then **Export PDF** (uses your browser's print → *Save as PDF*).
   On iPhone: Share → Print → pinch out on the preview → Share → Save to Files.
4. Open a **guide** to study it: Revise, Practice, Day-before, and spaced-rep Review.

Install to your home screen: in the browser's share menu choose **Add to Home
Screen**. It then opens full-screen and works offline for everything except generation.

---

## Files

```
index.html          UI + all styles + PWA shell
engine.js           guide parser + scheduler (pure logic, no network)
md.js               tiny markdown -> HTML renderer (sbobine / cheat sheets)
app.js              subjects, makers, reader, PDF export, study views
samples.js          two worked-example guides
service-worker.js   offline cache
manifest.json       PWA manifest
icon-192.png/512    icons
main.py             optional server: /api/guide /api/sbobina /api/cheatsheet
                    /api/image-search /api/enrich  (+ static hosting)
.replit / replit.nix  Replit run config (ignored by Render)
requirements.txt    empty — lets Render detect a Python service
render.yaml         optional Render Blueprint
GUIDE-TEMPLATE.md   copy-paste format for structured guides
```

## Notes on images & copyright

Figures come only from **Wikimedia Commons** and **Openverse** (Creative Commons /
public domain), fetched server-side, with attribution shown under each figure. Ward
does **not** scrape figures from copyrighted papers or textbooks, so the images are
topically relevant illustrations rather than the exact figure from a given source.

## NotebookLM?

There's no public consumer NotebookLM API to plug in — only an enterprise Google
Cloud API. If you want a Google model, use **Gemini** (`PROVIDER=gemini`) above.

## Privacy

Guides, sbobine, cheat sheets and review history live in your browser (IndexedDB).
The only network calls are: LLM generation you trigger (to your chosen provider) and
open-licensed image lookups. Nothing is sent anywhere else.
