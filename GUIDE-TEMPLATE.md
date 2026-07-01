# Building a Ward-ready study guide

Ward now **authors the guide for you** inside the app: **+ Guide → Build it for me**,
paste your material and (optionally) your past questions, and it calls your API key to
produce a 100%-coverage guide — answering every past question at depth (exam-driven),
or building from the material and generating questions (concept-driven).

You only need this file if you want to **import a guide that's already written** (the
*I already have one* option, which just parses — no key), or to understand the exact
markdown the maker emits and that Ward parses best. Everything below is that format.

---

## The prompt

Paste this into a Claude conversation, then attach or paste your **past questions** and your **notes** as two blocks. Fill in the subject.

> You are building a study guide for my **[SUBJECT]** exam. I'll give you two things: a set of **past exam questions** (some with a short summary answer, some with none) and my **lecture/reading notes**.
>
> Build a single comprehensive guide, **weighted toward what the professors actually ask**. Rules:
> - For every past question, write a complete, correct answer using my notes as the source. Where my notes are thin, fill the gap with standard, correct material for the field and keep it concise.
> - Order and emphasise topics by how heavily they appear in the past questions.
> - Mark exam traps, mnemonics, and must-know numbers explicitly (see format below).
> - At the **end**, add a short section titled **"In the notes but not asked"** covering important material from my notes that the past questions never touched — kept brief.
>
> Output in **this exact markdown format** so my study app can parse it:
> - Use `##` headings for each topic.
> - Write each examined question as a bolded numbered stem on its own line: `**Q1: <question text>**`, immediately followed by the answer in normal paragraphs.
> - Use these inline markers where they apply: `🔥` high-yield/frequently asked, `🚩 EXAM TRAP:` before a trap, `🧠 MEMORY TRICK:` before a mnemonic, `⭐` before a key line, `🔑` before a key mechanism.
> - Put hard figures in a two-column markdown table titled **"Numbers worth memorising"** (value | meaning).
> - Use `>` blockquotes for definitions.
> - End with `## In the notes but not asked` and keep it short.
>
> Here are my past questions:
> [PASTE QUESTIONS]
>
> Here are my notes:
> [PASTE NOTES]

When Claude replies, copy the whole thing and paste it into Ward → **Sources** → **Build deck**. Ward will detect **exam-driven** mode automatically (it keys off the numbered `Qn` stems and examined language).

---

## The format Ward reads

You don't have to hit every element — Ward degrades gracefully — but the closer you match this, the richer the output.

```markdown
## Chronic Kidney Disease

🔥 Frequently examined. Staged by GFR and albuminuria.

**Q1: How is CKD defined and staged?**
CKD is kidney damage or GFR < 60 for ≥ 3 months. Staged G1–G5 by GFR and
A1–A3 by albuminuria.

> eGFR: an estimate of filtration rate from creatinine, age, sex.

🚩 EXAM TRAP: a single low GFR does NOT diagnose CKD — it must persist ≥ 3 months.
🧠 MEMORY TRICK: "GFR 90-60-45-30-15" marks the stage boundaries.
⭐ Proteinuria is the strongest modifiable predictor of progression.

**Q2: Which anaemia is typical in CKD and why?**
Normocytic normochromic, from reduced erythropoietin...

### Numbers worth memorising
| Value | Meaning |
|-------|---------|
| GFR < 15 | Stage G5 / kidney failure |
| Hb < 11 | Treat renal anaemia |
| K⁺ > 6.0 | Emergency hyperkalaemia |

## In the notes but not asked
Brief coverage of tubular transport physiology, mentioned in lectures but
absent from every past paper.
```

### What each marker does in Ward
| Marker | Effect |
|--------|--------|
| `**Qn: …**` | becomes a past-exam card; drives exam-driven mode |
| `🔥` | raises the topic's testing weight (taller heat spine, kept in day-before) |
| `🚩` | pulled out as a trap; always shown in the day-before summary |
| `🧠` | becomes a mnemonic card |
| `⭐` | flagged as a key line |
| `🔑` | flagged as a key mechanism |
| `>` blockquote | becomes a definition card |
| Numbers table | each row becomes a number card; surfaced in day-before |

---

## Concept-driven guides (no past questions)

If you have no past questions — only lectures/readings — skip the `Qn` stems. Use `##` topic headings, `>` definitions, `🔥` on high-yield items, and `🧠`/`⭐`/`🔑` markers. Ward detects **concept-driven** mode and generates definition, fill-in-the-blank, and situational practice from the concepts instead. The bundled neuropsychology sample is an example of this shape.
