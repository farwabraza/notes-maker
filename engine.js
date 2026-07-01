/* =====================================================================
   STUDY ENGINE  —  pure logic, no DOM, no network, no AI required.
   Works in Node (for tests) and in the browser (attached to window).

   Responsibilities:
     1. Parse a medical study guide (markdown / plain text) into a model.
     2. Detect the source shape:
          - "exam-driven"  : past questions exist  -> restructure around
                             what professors actually test.
          - "concept-driven": only notes/slides   -> extract concepts and
                             generate situational questions.
     3. Build a unified deck of flashcards (definitions, mnemonics, traps,
        numbers, MCQs, real past questions, cloze).
     4. Generate study outputs: revision sheet, day-before summary,
        practice set, and feed the spaced-repetition scheduler.
     5. FSRS-free, dependency-free SM-2 spaced repetition (well understood,
        provably correct, offline).
   ===================================================================== */
(function (root) {
  "use strict";

  // ---- markers we key off (the shorthand these guides already use) ----
  const HOT = "\u{1F525}";        // 🔥  appeared on / high-yield on exam
  const TRAP = "\u{1F6A9}";       // 🚩  exam trap
  const BRAIN = "\u{1F9E0}";      // 🧠  memory trick / mnemonic
  const STAR = "\u2B50";          // ⭐  key line examiners love
  const KEY = "\u{1F511}";        // 🔑  key mechanism
  const TARGET = "\u{1F3AF}";     // 🎯  MCQ block
  const BOOK = "\u{1F4DA}";       // 📚  source / reading

  // =====================================================================
  //  Small helpers
  // =====================================================================
  const stripMd = (s) =>
    (s || "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1")
      .replace(/`(.*?)`/g, "$1")
      .replace(/^>+\s?/gm, "")
      .replace(/\[(.*?)\]\(.*?\)/g, "$1")
      .trim();

  const countEmoji = (s, e) => (s.match(new RegExp(e, "gu")) || []).length;
  const hasEmoji = (s, e) => new RegExp(e, "u").test(s || "");
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  const slug = (s) =>
    stripMd(s)
      .toLowerCase()
      .replace(/[^\w]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "topic";

  // strip the leading emoji/number decoration off a heading for a clean title
  const titleOf = (raw) =>
    clean(
      stripMd(raw)
        .replace(/^[#\s]*/, "")
        .replace(
          /^[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}0-9\uFE0F\u20E3\.\)\s]+/u,
          ""
        )
    ) || clean(stripMd(raw).replace(/^[#\s]*/, ""));

  // =====================================================================
  //  Block splitter — headings + bold "Qn:" pseudo-headings
  // =====================================================================
  // Returns [{title, level, lines[]}]. Headings start a block. In exam
  // guides the real units are the "**Qn:  **..." bold paragraphs, so we
  // promote those to blocks too.
  function splitBlocks(text) {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const blocks = [];
    let cur = { title: "Overview", level: 0, lines: [] };
    const push = () => {
      if (cur.lines.join("").trim() || cur.title !== "Overview") blocks.push(cur);
    };
    const qRe = /^\s*\*\*\s*(Q\d+)\s*[:.\)]\s*(.*?)\s*\*\*\s*(.*)$/; // **Q1:** stem  OR  **Q1: stem**
    const qRe2 = /^\s*(Q\d+)\s*[:.\)]\s+(.*)$/;              // Q1: stem (plain)
    const hRe = /^(#{1,6})\s+(.*)$/;

    for (const ln of lines) {
      const h = ln.match(hRe);
      let q = null;
      const qm = ln.match(qRe);
      if (qm) {
        q = { id: qm[1], stem: ((qm[2] || "") + " " + (qm[3] || "")).trim() };
      } else {
        const qm2 = ln.match(qRe2);
        if (qm2) q = { id: qm2[1], stem: qm2[2].trim() };
      }
      if (h) {
        push();
        cur = { title: h[2], level: h[1].length, lines: [], kind: "heading" };
      } else if (q) {
        push();
        cur = {
          title: q.stem || q.id,
          qid: q.id,
          level: 4,
          lines: [],
          kind: "question",
        };
      } else {
        cur.lines.push(ln);
      }
    }
    push();
    return blocks;
  }

  // =====================================================================
  //  Extractors that run over a block's raw lines
  // =====================================================================
  function extractDefinition(lines) {
    // first blockquote wins; else first bold-led sentence
    for (const ln of lines) {
      if (/^\s*>/.test(ln)) {
        const t = stripMd(ln);
        if (t.length > 12) return t;
      }
    }
    for (const ln of lines) {
      const m = ln.match(/^\s*[-*]?\s*\*\*(.+?)\*\*\s*[=:\u2014-]\s*(.+)$/);
      if (m) return stripMd(m[1] + " \u2014 " + m[2]);
    }
    return "";
  }

  function extractHooks(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const ln = lines[i];
      if (hasEmoji(ln, BRAIN) || /MEMORY TRICK|MNEMONIC/i.test(ln)) {
        let label = stripMd(ln).replace(/^[-*\s]+/, "");
        // the mnemonic body often sits on the following non-empty lines
        const body = [];
        let j = i + 1;
        while (
          j < lines.length &&
          lines[j].trim() &&
          !/^#{1,6}\s/.test(lines[j]) &&
          !hasEmoji(lines[j], BRAIN) &&
          !hasEmoji(lines[j], TRAP) &&
          !/^\s*\*\*Q\d+/.test(lines[j]) &&
          body.length < 6
        ) {
          const t = stripMd(lines[j]);
          if (t) body.push(t);
          j++;
        }
        out.push({ label, body: body.join(" \u00B7 ") });
        i = j;
      } else i++;
    }
    return out;
  }

  function extractTraps(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const ln = lines[i];
      if (hasEmoji(ln, TRAP) || /EXAM TRAP|TRAP\b/i.test(ln)) {
        let label = stripMd(ln).replace(/^[-*\s]+/, "");
        const body = [];
        let j = i + 1;
        while (
          j < lines.length &&
          lines[j].trim() &&
          !/^#{1,6}\s/.test(lines[j]) &&
          !hasEmoji(lines[j], TRAP) &&
          !hasEmoji(lines[j], BRAIN) &&
          !/^\s*\*\*Q\d+/.test(lines[j]) &&
          body.length < 6
        ) {
          const t = stripMd(lines[j]);
          if (t) body.push(t);
          j++;
        }
        out.push({ label, body: body.join(" \u00B7 ") });
        i = j;
      } else i++;
    }
    return out;
  }

  // MCQ blocks like:
  //  1. **stem…** → *answer*   OR   1. **stem…** *answer*
  // We only accept a line as an MCQ when it reads like a question: a bold
  // stem, or a stem ending in ? / … . This keeps numbered *mechanism*
  // lists ("1) RAAS activation: ↓GFR → …") out of the question pool.
  function extractMCQs(lines) {
    const out = [];
    for (const ln of lines) {
      const m = ln.match(/^\s*\d+[.\)]\s+(.*)$/);
      if (!m) continue;
      const rest = m[1];
      const boldStem = /^\*\*(.+?)\*\*/.test(rest);
      let stem = "",
        ans = "";
      const arrow = rest.split(/\s*(?:\u2192|->|=>)\s*/);
      if (boldStem) {
        const bm = rest.match(/^\*\*(.+?)\*\*\s*(?:\u2192|->|=>)?\s*(.*)$/);
        stem = bm[1];
        ans = bm[2];
      } else if (arrow.length >= 2) {
        stem = arrow[0];
        ans = arrow.slice(1).join(" \u2192 ");
      }
      stem = stripMd(stem);
      ans = stripMd(ans);
      const looksQuestion = boldStem || /[?\u2026]\s*$/.test(stem);
      if (looksQuestion && stem.length > 6 && ans.length > 1) {
        out.push({ q: stem, a: ans });
      }
    }
    return out;
  }

  // 2-column reference tables -> key/value cards, when the table looks
  // like a lookup ("Numbers", "Pattern", "If you see"/"Think", "= value").
  function extractRefTable(lines, headingTitle) {
    const rows = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l));
    if (rows.length < 3) return [];
    const cells = rows.map((r) =>
      r.trim().replace(/^\||\|$/g, "").split("|").map((c) => stripMd(c))
    );
    // drop markdown separator rows (|---|:--:|)
    const body = cells.filter((c) => !/^[-:\s|]+$/.test(c.join("")));
    const dataRows = body.filter((c) => c.length >= 2 && c[0] && c[1] && !/^-+$/.test(c[0]));
    if (dataRows.length < 2) return [];
    const header = dataRows[0].map((h) => h.toLowerCase());
    const looksLookup =
      /number|value|pattern|think|if you see|item|hallmark|=|target|threshold/i.test(
        (headingTitle || "") + " " + header.join(" ")
      );
    if (!looksLookup) return [];
    return dataRows.slice(1).map((c) => ({ q: c[0], a: c.slice(1).join(" \u2014 ") }));
  }

  // pull inline "clinical numbers" (GFR <60, Hb < 13 g/dL, K⁺ > 5.3…)
  function extractNumbers(lines) {
    const text = lines.join(" ");
    const out = [];
    const re = /([A-Z][A-Za-z⁺₂₃/()\-\u2082-\u2089\s]{1,26}?)\s*(<|>|≤|≥|=|≈|~)\s*([\d.,\u2013\-]+\s?(?:mL\/min|g\/dL|mEq\/L|mg\/dL|mmHg|L\/day|pg\/mL|mg\/day|g\/day|%)?)/g;
    let m,
      seen = new Set();
    while ((m = re.exec(text)) && out.length < 40) {
      const item = clean(m[1]);
      if (item.length < 2 || /^(the|a|an|of|and|to|is)$/i.test(item)) continue;
      const val = clean(m[2] + " " + m[3]);
      // skip durations ("≥ 3 months", "6 hours") — not lab thresholds
      const after = text.slice(re.lastIndex, re.lastIndex + 8).toLowerCase();
      const bareInt = /^[<>=≈~≤≥]\s*\d{1,3}$/.test(val.replace(/[\u2013\-]/g, ""));
      if (bareInt && /^\s*(month|year|week|day|hour|hr|\u00d7|time)/.test(after)) continue;
      const k = (item + val).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ item, value: val });
    }
    return out;
  }

  // =====================================================================
  //  MODE DETECTION
  // =====================================================================
  function detectMode(text, blocks) {
    const qBlocks = blocks.filter((b) => b.kind === "question");
    const qMentions = (text.match(/\bQ\d+\b/g) || []).length;
    const examinedPhrase =
      /examined question|past (?:exam|paper|question)|oral exam|appeared on|recalled exam|exam recollection/i.test(
        text
      );
    const examDriven = qBlocks.length >= 4 || qMentions >= 8 || (examinedPhrase && qBlocks.length >= 2);
    return {
      mode: examDriven ? "exam-driven" : "concept-driven",
      signals: {
        examQuestionBlocks: qBlocks.length,
        qMentions,
        examinedLanguage: examinedPhrase,
        hotMarkers: countEmoji(text, HOT),
        trapMarkers: countEmoji(text, TRAP),
        mnemonicMarkers: countEmoji(text, BRAIN),
      },
    };
  }

  // =====================================================================
  //  BUILD MODEL
  // =====================================================================
  function buildModel(rawText, meta) {
    const text = rawText.replace(/\r\n/g, "\n");
    const blocks = splitBlocks(text);
    const det = detectMode(text, blocks);

    const topics = [];
    for (const b of blocks) {
      const bodyText = b.lines.join("\n");
      const heat = countEmoji(bodyText, HOT) + countEmoji(b.title, HOT);
      const isStarred = hasEmoji(bodyText, STAR);
      const def = extractDefinition(b.lines);
      const hooks = extractHooks(b.lines);
      const traps = extractTraps(b.lines);
      const mcqs = extractMCQs(b.lines);
      const refs = extractRefTable(b.lines, b.title);
      const numbers = extractNumbers(b.lines);
      // question stems keep their wording (74-year-old etc.); headings get
      // their emoji/number decoration trimmed for a clean title.
      const cleanTitle =
        b.kind === "question" ? clean(stripMd(b.title)) : titleOf(b.title);
      const body = stripMd(bodyText).replace(/\n{3,}/g, "\n\n").trim();
      if (
        !cleanTitle &&
        !def &&
        !hooks.length &&
        !traps.length &&
        !mcqs.length &&
        !refs.length &&
        body.length < 40
      )
        continue;

      // priority: what professors reward. Exam Qs and hot markers dominate.
      let priority =
        heat * 3 +
        (b.kind === "question" ? 4 : 0) +
        traps.length * 2 +
        (isStarred ? 1 : 0) +
        (hooks.length ? 1 : 0) +
        (mcqs.length ? 1 : 0);

      topics.push({
        id: slug((b.qid ? b.qid + " " : "") + cleanTitle) + "-" + topics.length,
        qid: b.qid || null,
        kind: b.kind || "heading",
        level: b.level,
        title: cleanTitle,
        heat,
        starred: isStarred,
        priority,
        definition: def,
        body,
        hooks,
        traps,
        mcqs,
        refs,
        numbers,
      });
    }

    // ---- card synthesis -------------------------------------------------
    const cards = [];
    const add = (c) => {
      const id = c.type + "::" + slug(c.front).slice(0, 48) + "::" + cards.length;
      cards.push(Object.assign({ id, topicId: c.topicId, priority: c.priority || 0 }, c));
    };

    for (const t of topics) {
      // 1) real past exam questions (exam-driven docs) — the gold
      if (t.kind === "question") {
        const back =
          (t.definition ? t.definition + "\n\n" : "") +
          (t.body ? t.body : "");
        add({
          type: "exam",
          topicId: t.id,
          front: (t.qid ? t.qid + ". " : "") + t.title,
          back: clean(back).slice(0, 1400),
          priority: t.priority + 3,
          tag: "Past question",
        });
      }
      // 2) definitions -> "define X"
      if (t.definition && t.kind !== "question") {
        add({
          type: "define",
          topicId: t.id,
          front: "Define: " + t.title,
          back: t.definition,
          priority: t.priority + (t.heat ? 2 : 0),
          tag: "Definition",
        });
      }
      // 3) MCQs (explicit banks)
      for (const q of t.mcqs) {
        add({
          type: "mcq",
          topicId: t.id,
          front: q.q,
          back: q.a,
          priority: t.priority + 1,
          tag: "MCQ",
        });
      }
      // 4) mnemonics
      for (const h of t.hooks) {
        add({
          type: "mnemonic",
          topicId: t.id,
          front: "Memory hook \u2014 " + (h.label.replace(/^.*?[\u2014-]\s*/, "") || t.title),
          back: (h.label ? h.label + "\n" : "") + h.body,
          priority: t.priority,
          tag: "Mnemonic",
        });
      }
      // 5) traps
      for (const tr of t.traps) {
        add({
          type: "trap",
          topicId: t.id,
          front: "Trap \u2014 " + (tr.label.replace(/EXAM TRAP\s*[\u2014-]?\s*/i, "") || t.title),
          back: (tr.label ? tr.label + "\n" : "") + tr.body,
          priority: t.priority + 2,
          tag: "Exam trap",
        });
      }
      // 6) reference tables (numbers / patterns / lookups)
      for (const r of t.refs) {
        add({
          type: "ref",
          topicId: t.id,
          front: r.q,
          back: r.a,
          priority: t.priority,
          tag: "Reference",
        });
      }
      // 7) inline numbers (only for exam-driven, where numbers matter)
      if (det.mode === "exam-driven") {
        for (const n of t.numbers.slice(0, 6)) {
          add({
            type: "number",
            topicId: t.id,
            front: n.item + " = ?",
            back: n.value,
            priority: t.priority,
            tag: "Number",
          });
        }
      }
      // 8) situational cloze (concept-driven): turn a strong definition
      //    sentence into a fill-in-the-blank so notes become active recall
      if (det.mode === "concept-driven" && t.definition) {
        const cz = makeCloze(t.definition);
        if (cz) {
          add({
            type: "cloze",
            topicId: t.id,
            front: cz.front,
            back: cz.answer,
            priority: t.priority,
            tag: "Fill-in",
          });
        }
      }
    }

    // de-dup cards by front+back
    const seen = new Set();
    const deduped = cards.filter((c) => {
      const k = (c.front + "|" + c.back).toLowerCase().slice(0, 160);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    return {
      meta: Object.assign(
        { title: guessTitle(text) || (meta && meta.title) || "Study deck", createdAt: Date.now() },
        meta || {}
      ),
      mode: det.mode,
      signals: det.signals,
      topics,
      cards: deduped,
    };
  }

  function guessTitle(text) {
    const m = text.match(/^\s*#\s+(.+)$/m) || text.match(/^\s*\*\*(.+?)\*\*\s*$/m);
    return m ? clean(titleOf(m[1])) : "";
  }

  // pick a salient noun-ish token from a definition to blank out
  function makeCloze(def) {
    const s = def.replace(/^[^:]*[:\u2014-]\s*/, "");
    // prefer a capitalised multiword term or a quoted/parenthetical key term
    const cand =
      s.match(/\b([A-Z][a-z]+(?:\s[a-z]+){0,2})\b/) ||
      s.match(/\b(contralateral|ipsilateral|anterograde|retrograde|non-fluent|fluent|parietal|frontal|temporal)\b/i);
    if (!cand) return null;
    const term = cand[1] || cand[0];
    if (term.length < 4 || /^(The|This|That|These|Those|With|From|When)$/i.test(term)) return null;
    const front = s.replace(term, "\u2015\u2015\u2015\u2015");
    if (front === s) return null;
    return { front: front.slice(0, 300), answer: term };
  }

  // =====================================================================
  //  OUTPUT GENERATORS
  // =====================================================================
  // Revision sheet: every topic, condensed to what earns marks.
  function revisionSheet(model) {
    const ordered = [...model.topics]
      .filter((t) => t.title || t.definition || t.hooks.length)
      .sort((a, b) => b.priority - a.priority || a.level - b.level);
    return ordered.map((t) => ({
      title: t.title,
      qid: t.qid,
      heat: t.heat,
      priority: t.priority,
      definition: t.definition,
      hooks: t.hooks,
      traps: t.traps,
      numbers: t.numbers,
      mcqs: t.mcqs.slice(0, 4),
    }));
  }

  // Day-before summary: ruthless. Only the highest-yield — hot topics,
  // every trap, every mnemonic, every number. "If you read one thing."
  function dayBefore(model) {
    const cut =
      model.mode === "exam-driven"
        ? Math.max(3, percentile(model.topics.map((t) => t.priority), 0.55))
        : Math.max(2, percentile(model.topics.map((t) => t.priority), 0.6));
    const hot = model.topics
      .filter((t) => t.priority >= cut && (t.title || t.definition))
      .sort((a, b) => b.priority - a.priority);
    const traps = [];
    const mnemonics = [];
    const numbers = [];
    for (const t of model.topics) {
      t.traps.forEach((x) => traps.push({ topic: t.title, ...x }));
      t.hooks.forEach((x) => mnemonics.push({ topic: t.title, ...x }));
      t.numbers.forEach((x) => numbers.push({ topic: t.title, ...x }));
    }
    return {
      cut,
      hotTopics: hot.map((t) => ({
        title: t.title,
        qid: t.qid,
        heat: t.heat,
        definition: t.definition,
        oneLiner: (t.hooks[0] && t.hooks[0].label) || t.definition,
      })),
      traps,
      mnemonics,
      numbers: dedupeBy(numbers, (n) => n.item + n.value).slice(0, 40),
    };
  }

  function percentile(arr, p) {
    const a = [...arr].filter((x) => typeof x === "number").sort((x, y) => x - y);
    if (!a.length) return 0;
    return a[Math.min(a.length - 1, Math.floor(a.length * p))];
  }
  function dedupeBy(arr, keyFn) {
    const s = new Set();
    return arr.filter((x) => {
      const k = keyFn(x).toLowerCase();
      if (s.has(k)) return false;
      s.add(k);
      return true;
    });
  }

  // Practice set: ordered by priority, optionally filtered by topic/type.
  function practiceSet(model, opts) {
    opts = opts || {};
    let cs = [...model.cards];
    if (opts.types && opts.types.length) cs = cs.filter((c) => opts.types.includes(c.type));
    if (opts.topicId) cs = cs.filter((c) => c.topicId === opts.topicId);
    if (opts.order === "priority") cs.sort((a, b) => b.priority - a.priority);
    else shuffle(cs);
    if (opts.limit) cs = cs.slice(0, opts.limit);
    return cs;
  }
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // =====================================================================
  //  SPACED REPETITION — SM-2 (SuperMemo 2). Pure functions.
  //  grade: 0 Again, 3 Hard, 4 Good, 5 Easy  (0-2 = lapse)
  // =====================================================================
  const DAY = 86400000;
  function freshState() {
    return { reps: 0, ef: 2.5, interval: 0, due: Date.now(), lapses: 0, last: 0 };
  }
  function schedule(state, grade, now) {
    now = now || Date.now();
    const s = Object.assign(freshState(), state || {});
    if (grade < 3) {
      s.reps = 0;
      s.interval = 0; // relearn same session / next day
      s.lapses += 1;
      s.due = now + Math.round(0.5 * DAY); // ~12h
    } else {
      s.reps += 1;
      if (s.reps === 1) s.interval = 1;
      else if (s.reps === 2) s.interval = 6;
      else s.interval = Math.round(s.interval * s.ef);
      s.ef = Math.max(
        1.3,
        s.ef + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02))
      );
      s.due = now + s.interval * DAY;
    }
    s.last = now;
    return s;
  }
  function dueCards(model, sr, now) {
    now = now || Date.now();
    return model.cards
      .map((c) => ({ card: c, st: sr[c.id] || freshState() }))
      .filter((x) => (x.st.due || 0) <= now)
      .sort(
        (a, b) =>
          (a.st.reps === 0 ? -1 : 0) - (b.st.reps === 0 ? -1 : 0) ||
          b.card.priority - a.card.priority
      )
      .map((x) => x.card);
  }
  function srStats(model, sr, now) {
    now = now || Date.now();
    let due = 0,
      newC = 0,
      learning = 0,
      mature = 0;
    for (const c of model.cards) {
      const st = sr[c.id];
      if (!st || st.reps === 0) newC++;
      else if (st.interval >= 21) mature++;
      else learning++;
      if (!st || (st.due || 0) <= now) due++;
    }
    return { total: model.cards.length, due, new: newC, learning, mature };
  }

  // =====================================================================
  //  Public surface
  // =====================================================================
  const API = {
    buildModel,
    revisionSheet,
    dayBefore,
    practiceSet,
    // scheduler
    schedule,
    freshState,
    dueCards,
    srStats,
    // low-level (exposed for tests)
    _internals: {
      splitBlocks,
      detectMode,
      extractMCQs,
      extractHooks,
      extractTraps,
      extractNumbers,
      makeCloze,
      stripMd,
      titleOf,
    },
    markers: { HOT, TRAP, BRAIN, STAR, KEY, TARGET, BOOK },
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.StudyEngine = API;
})(typeof self !== "undefined" ? self : this);
