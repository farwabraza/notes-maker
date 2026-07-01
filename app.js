/* Ward — app controller. Ties StudyEngine to the UI, persists to
   localStorage (stateless server), runs SM-2 review, optional Claude. */
(function () {
  "use strict";
  const E = window.StudyEngine;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) =>
    (s == null ? "" : String(s)).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    );
  // ---- IndexedDB store: no ~5MB localStorage cap; limited only by disk ----
  const DB = (function () {
    const NAME = "ward-db", STORE = "kv", VER = 1;
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((res, rej) => {
        if (!("indexedDB" in window)) return rej(new Error("no-idb"));
        const r = indexedDB.open(NAME, VER);
        r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return dbp;
    }
    function tx(mode, fn) {
      return open().then((db) => new Promise((res, rej) => {
        const t = db.transaction(STORE, mode), s = t.objectStore(STORE);
        const out = fn(s);
        t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
        t.onerror = () => rej(t.error);
      }));
    }
    return {
      get(k) { return tx("readonly", (s) => s.get("ward:" + k)).catch(() => undefined); },
      set(k, v) { return tx("readwrite", (s) => s.put(v, "ward:" + k)).catch(() => {}); },
      del(k) { return tx("readwrite", (s) => s.delete("ward:" + k)).catch(() => {}); },
    };
  })();

  // Fallback if IndexedDB is unavailable (rare: private-mode Safari, etc.)
  const LSfallback = {
    get(k) { try { return JSON.parse(localStorage.getItem("ward:" + k)); } catch { return undefined; } },
    set(k, v) { try { localStorage.setItem("ward:" + k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem("ward:" + k); } catch {} },
  };
  let store = DB;           // swapped to LSfallback at boot if IDB fails

  // -------- state (populated asynchronously at boot) --------
  const state = {
    decks: {},               // id -> {model, sr:{cardId:srState}, raw}
    activeId: null,
    settings: { theme: "dark", reveal: true, claude: false },
    practice: null,          // active practice session
    review: null,            // active review session
  };
  const activeDeck = () => state.decks[state.activeId] || null;
  const saveDecks = () => store.set("decks", state.decks);
  const saveSettings = () => store.set("settings", state.settings);
  const saveActive = () => store.set("active", state.activeId);

  // Load persisted state; migrate any old localStorage decks into IndexedDB once.
  async function loadState() {
    try { await DB.get("decks"); } catch { store = LSfallback; }
    const g = async (k, d) => { const v = await store.get(k); return v == null ? d : v; };
    let decks = await g("decks", null);
    // one-time migration from the previous localStorage-based version
    if (decks == null) {
      try {
        const old = localStorage.getItem("ward:decks");
        if (old) {
          decks = JSON.parse(old);
          await store.set("decks", decks);
          const oa = localStorage.getItem("ward:active");
          if (oa) await store.set("active", JSON.parse(oa));
        }
      } catch {}
    }
    state.decks = decks || {};
    state.activeId = await g("active", null);
    state.settings = await g("settings", { theme: "dark", reveal: true, claude: false });
  }

  // -------- theme --------
  function applyTheme() {
    document.documentElement.dataset.theme = state.settings.theme;
    $("#tgTheme") && $("#tgTheme").classList.toggle("on", state.settings.theme === "dark");
  }

  // =====================================================================
  //  Build a deck from text
  // =====================================================================
  function buildDeck(text, name) {
    if (!text || text.trim().length < 40) { toast("Not enough text to build a deck."); return; }
    const model = E.buildModel(text, name ? { title: name } : {});
    const id = "d_" + Date.now().toString(36);
    state.decks[id] = { model, sr: {}, createdAt: Date.now(), raw: text };
    state.activeId = id;
    saveActive();
    saveDecks();
    renderAnalysis(model, true);
    refreshAll();
    go("revise");
    toast("Built “" + model.meta.title + "” — " + model.mode.replace("-", " "));
  }

  // =====================================================================
  //  SOURCES view
  // =====================================================================
  function renderAnalysis(model, justBuilt) {
    const s = model.signals;
    const byType = {};
    model.cards.forEach((c) => (byType[c.type] = (byType[c.type] || 0) + 1));
    const order = ["exam", "mcq", "define", "cloze", "trap", "mnemonic", "number", "ref"];
    const colors = { exam: "var(--amber)", mcq: "var(--cyan)", define: "var(--cyan)",
      cloze: "var(--violet)", trap: "var(--rose)", mnemonic: "var(--violet)",
      number: "var(--amber)", ref: "var(--mut)" };
    const labels = { exam: "Past Qs", mcq: "MCQs", define: "Definitions", cloze: "Fill-ins",
      trap: "Traps", mnemonic: "Mnemonics", number: "Numbers", ref: "Reference" };
    const total = model.cards.length || 1;
    const bars = order.filter((t) => byType[t]).map((t) =>
      `<i style="width:${(byType[t] / total * 100).toFixed(1)}%;background:${colors[t]}"></i>`).join("");
    const legend = order.filter((t) => byType[t]).map((t) =>
      `<span style="--c:${colors[t]}"><i style="background:${colors[t]}"></i>${labels[t]} ${byType[t]}</span>`
        .replace('<i ', '<em style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;vertical-align:middle" ')
        .replace('></i>', '></em>')).join("");

    const isExam = model.mode === "exam-driven";
    const explain = isExam
      ? `<b>Past questions detected</b> (${s.examQuestionBlocks} examined questions). Notes were restructured <b>around what professors test</b>: each question is answered at depth, ${s.trapMarkers} exam traps and ${s.mnemonicMarkers} mnemonics were pulled out, and everything is ranked by testing weight.`
      : `<b>No past questions found</b> — this is lecture/reading material. The engine <b>extracted key concepts and generated situational questions</b>: ${byType.define || 0} definitions, ${byType.cloze || 0} fill-in-the-blanks and ${byType.mcq || 0} MCQs from the material, ranked by the 🔥 heat you marked.`;

    $("#analysisWrap").innerHTML = `
      <div class="analysis">
        <h4>${justBuilt ? "✓ Built" : "Analysis"}: ${esc(model.meta.title)}
          <span class="modechip ${isExam ? "exam" : "concept"}" style="margin-left:6px">${isExam ? "exam-driven" : "concept-driven"}</span>
        </h4>
        <p class="tiny mut" style="margin:0 0 4px">${explain}</p>
        <div class="abar">${bars}</div>
        <div class="leg">${legend}</div>
        <div class="tiny mut" style="margin-top:8px">${model.topics.length} topics · ${model.cards.length} study cards generated</div>
      </div>`;
  }

  function renderDeckList() {
    const ids = Object.keys(state.decks);
    $("#deckListLabel").hidden = ids.length === 0;
    $("#deckList").innerHTML = ids.map((id) => {
      const d = state.decks[id], m = d.model;
      const active = id === state.activeId;
      return `<div class="card"><div class="pad" style="display:flex;align-items:center;gap:10px">
        <div style="flex:1;min-width:0">
          <div style="font-family:var(--disp);font-weight:700;font-size:15px">${esc(m.meta.title)}</div>
          <div class="tiny mut">${m.mode.replace("-", " ")} · ${m.topics.length} topics · ${m.cards.length} cards</div>
        </div>
        ${active ? '<span class="chip green">active</span>' : `<button class="btn ghost tiny" data-use="${id}">Use</button>`}
        <button class="iconbtn" data-del="${id}" title="Delete" style="width:32px;height:32px">✕</button>
      </div></div>`;
    }).join("");
    $$("#deckList [data-use]").forEach((b) => b.onclick = () => { state.activeId = b.dataset.use; saveActive(); refreshAll(); toast("Switched deck"); });
    $$("#deckList [data-del]").forEach((b) => b.onclick = () => {
      if (!confirm("Delete this deck and its review history?")) return;
      delete state.decks[b.dataset.del];
      if (state.activeId === b.dataset.del) state.activeId = Object.keys(state.decks)[0] || null;
      saveActive(); saveDecks(); refreshAll();
    });
  }

  // =====================================================================
  //  Header deck picker
  // =====================================================================
  function renderHeader() {
    const ids = Object.keys(state.decks);
    $("#deckbar").hidden = ids.length === 0;
    if (!ids.length) return;
    $("#deckPick").innerHTML = ids.map((id) =>
      `<option value="${id}" ${id === state.activeId ? "selected" : ""}>${esc(state.decks[id].model.meta.title)}</option>`).join("");
    const d = activeDeck();
    if (!d) return;
    const chip = $("#modeChip");
    const isExam = d.model.mode === "exam-driven";
    chip.className = "modechip " + (isExam ? "exam" : "concept");
    chip.textContent = isExam ? "exam-driven" : "concept-driven";
    const st = E.srStats(d.model, d.sr);
    $("#miniStat").innerHTML = `<b>${d.model.cards.length}</b> cards · <b>${st.due}</b> due`;
    const badge = $("#dueBadge");
    badge.hidden = st.due === 0; badge.textContent = st.due;
  }

  // =====================================================================
  //  REVISE view
  // =====================================================================
  let reviseFilter = "all";
  function renderRevise() {
    const d = activeDeck();
    if (!d) return empty("#reviseBody", "Build or load a deck first.");
    const isExam = d.model.mode === "exam-driven";
    $("#reviseSub").textContent = isExam
      ? "Every examined question, answered at depth — ordered by testing weight."
      : "Every concept, condensed to what earns marks — ordered by the heat you marked.";
    $("#reviseTools").innerHTML = `<div class="seg" id="revSeg">
      <button data-f="all" class="${reviseFilter === "all" ? "on" : ""}">All</button>
      <button data-f="hot" class="${reviseFilter === "hot" ? "on" : ""}">🔥 High-yield</button>
      <button data-f="trap" class="${reviseFilter === "trap" ? "on" : ""}">🚩 Traps</button>
    </div><button class="btn ghost tiny" id="expandAll">Expand all</button>`;
    let sheet = E.revisionSheet(d.model);
    const maxP = Math.max(1, ...sheet.map((t) => t.priority));
    if (reviseFilter === "hot") sheet = sheet.filter((t) => t.priority >= Math.max(3, maxP * 0.45));
    if (reviseFilter === "trap") sheet = sheet.filter((t) => t.traps.length);

    $("#reviseBody").innerHTML = sheet.map((t, i) => {
      const seg = Math.min(5, Math.round((t.priority / maxP) * 5));
      const hooks = t.hooks.map((h) => `<div class="hook"><b>${esc(stripEmoji(h.label))}</b>${h.body ? " — " + esc(h.body) : ""}</div>`).join("");
      const traps = t.traps.map((h) => `<div class="trap"><b>🚩 ${esc(stripEmoji(h.label).replace(/EXAM TRAP\s*[—-]?\s*/i, ""))}</b>${h.body ? " — " + esc(h.body) : ""}</div>`).join("");
      const nums = t.numbers.length ? `<div class="blk"><div class="lbl">key numbers</div><div class="nums">${t.numbers.slice(0, 10).map((n) => `<span class="numrow">${esc(n.item)}<span class="v">${esc(n.value)}</span></span>`).join("")}</div></div>` : "";
      const mcqs = t.mcqs.length ? `<div class="mcqmini">${t.mcqs.map((q) => `<div><b>${esc(q.q)}</b><div class="a">→ ${esc(q.a)}</div></div>`).join("")}</div>` : "";
      return `<div class="card topic ${i < 2 ? "open" : ""}">
        <div class="spined">
          <div class="spine s${seg}"><i style="height:${seg * 20}%"></i></div>
          <div class="spinebody pad">
            <div class="thead">
              <div class="ttitle">${t.qid ? `<span class="qid">${t.qid} · </span>` : ""}${esc(t.title)}</div>
              ${t.heat ? `<span class="chip amber">🔥${t.heat}</span>` : ""}
              <svg class="caret" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>
            </div>
            <div class="tbody">
              ${t.definition ? `<div class="def">${esc(t.definition)}</div>` : ""}
              ${hooks ? `<div class="blk"><div class="lbl">🧠 memory hooks</div>${hooks}</div>` : ""}
              ${traps ? `<div class="blk"><div class="lbl">exam traps</div>${traps}</div>` : ""}
              ${nums}
              ${mcqs}
              ${state.settings.claude ? `<div class="btnrow" style="margin-top:10px"><button class="btn ghost tiny claudeq" data-topic="${esc(t.title)}">✨ More practice Qs</button></div>` : ""}
            </div>
          </div>
        </div></div>`;
    }).join("") || empty(null, "Nothing matches this filter.");

    $$("#reviseBody .thead").forEach((h) => h.onclick = () => h.closest(".topic").classList.toggle("open"));
    $$("#revSeg button").forEach((b) => b.onclick = () => { reviseFilter = b.dataset.f; renderRevise(); });
    $("#expandAll").onclick = () => { const any = $("#reviseBody .topic:not(.open)"); $$("#reviseBody .topic").forEach((t) => t.classList.toggle("open", !!any)); };
    $$(".claudeq").forEach((b) => b.onclick = () => claudeEnrich(b.dataset.topic, b));
  }

  // =====================================================================
  //  PRACTICE view
  // =====================================================================
  let practiceOrder = "priority", practiceType = "all";
  function startPractice() {
    const d = activeDeck(); if (!d) return;
    const types = practiceType === "all" ? null : [practiceType];
    const cards = E.practiceSet(d.model, { order: practiceOrder, types, limit: 40 });
    state.practice = { cards, i: 0, revealed: !state.settings.reveal, right: 0, done: 0 };
    renderPractice();
  }
  function renderPractice() {
    const d = activeDeck();
    if (!d) return empty("#practiceBody", "Build or load a deck first.");
    const typeOpts = [["all", "All"], ["exam", "Past Qs"], ["mcq", "MCQs"], ["define", "Definitions"], ["trap", "Traps"], ["number", "Numbers"], ["mnemonic", "Mnemonics"]];
    const present = new Set(d.model.cards.map((c) => c.type));
    $("#practiceTools").innerHTML = `
      <div class="seg">${["priority", "shuffle"].map((o) => `<button data-o="${o}" class="${practiceOrder === o ? "on" : ""}">${o === "priority" ? "High-yield first" : "Shuffle"}</button>`).join("")}</div>
      <div class="seg">${typeOpts.filter(([t]) => t === "all" || present.has(t)).map(([t, l]) => `<button data-t="${t}" class="${practiceType === t ? "on" : ""}">${l}</button>`).join("")}</div>`;
    $$("#practiceTools [data-o]").forEach((b) => b.onclick = () => { practiceOrder = b.dataset.o; startPractice(); });
    $$("#practiceTools [data-t]").forEach((b) => b.onclick = () => { practiceType = b.dataset.t; startPractice(); });

    const p = state.practice;
    if (!p || p.i >= p.cards.length) {
      $("#practiceBody").innerHTML = p ? sessionDone(p, "practice") :
        `<div class="empty"><div class="big">🎯</div><div>Ready when you are.</div><div class="btnrow" style="justify-content:center;margin-top:14px"><button class="btn primary" id="startP">Start practice</button></div></div>`;
      const s = $("#startP"); if (s) s.onclick = startPractice;
      if (p) $("#againBtn").onclick = startPractice;
      return;
    }
    const c = p.cards[p.i];
    $("#practiceBody").innerHTML = `
      <div class="progressline"><i style="width:${(p.i / p.cards.length * 100).toFixed(0)}%"></i></div>
      <div class="tiny mut" style="display:flex;justify-content:space-between"><span>Card ${p.i + 1} / ${p.cards.length}</span><span>${cardTag(c)}</span></div>
      <div class="card"><div class="pad flash">
        <div class="fmeta">${c.qid ? `<span class="qid">${c.qid}</span>` : ""}<span class="chip ${chipClass(c.type)}">${c.tag}</span></div>
        <div class="front">${esc(c.front)}</div>
        <div class="back ${p.revealed ? "" : "hidden"}" id="pback">${esc(c.back)}</div>
        ${!p.revealed ? `<div class="btnrow" style="margin-top:16px"><button class="btn block" id="revealBtn">Reveal answer</button></div>` : gradeBar()}
      </div></div>`;
    if (!p.revealed) $("#revealBtn").onclick = () => { p.revealed = true; renderPractice(); };
    else bindGrades((g) => {
      p.done++; if (g >= 4) p.right++;
      gradeCard(c, g);
      p.i++; p.revealed = !state.settings.reveal; renderPractice();
    });
  }

  // =====================================================================
  //  REVIEW view (spaced repetition)
  // =====================================================================
  function renderReview() {
    const d = activeDeck();
    if (!d) { $("#srStats").innerHTML = ""; return empty("#reviewBody", "Build or load a deck first."); }
    const st = E.srStats(d.model, d.sr);
    $("#srStats").innerHTML = [
      ["due", st.due, "Due now"], ["new", st.new, "New"], ["learn", st.learning, "Learning"], ["mature", st.mature, "Mature"],
    ].map(([k, n, l]) => `<div class="stat ${k}"><div class="n">${n}</div><div class="k">${l}</div></div>`).join("");

    const r = state.review;
    if (!r) {
      const due = E.dueCards(d.model, d.sr);
      if (!due.length) return void ($("#reviewBody").innerHTML = `<div class="empty"><div class="big">✓</div><div>Nothing due right now.</div><div class="tiny mut" style="margin-top:6px">New cards appear as you build decks; reviewed cards resurface on schedule.</div><div class="btnrow" style="justify-content:center;margin-top:14px"><button class="btn" id="cram">Cram anyway (${d.model.cards.length})</button></div></div>`) || ($("#cram").onclick = () => { state.review = { cards: E.practiceSet(d.model, { order: "priority" }), i: 0, revealed: false, done: 0 }; renderReview(); });
      $("#reviewBody").innerHTML = `<div class="empty"><div class="big">🔁</div><div><b>${due.length}</b> cards due.</div><div class="btnrow" style="justify-content:center;margin-top:14px"><button class="btn primary" id="startR">Start review</button></div></div>`;
      $("#startR").onclick = () => { state.review = { cards: due, i: 0, revealed: false, done: 0 }; renderReview(); };
      return;
    }
    if (r.i >= r.cards.length) {
      $("#reviewBody").innerHTML = sessionDone(r, "review");
      $("#againBtn").onclick = () => { state.review = null; renderReview(); };
      return;
    }
    const c = r.cards[r.i];
    $("#reviewBody").innerHTML = `
      <div class="progressline"><i style="width:${(r.i / r.cards.length * 100).toFixed(0)}%"></i></div>
      <div class="tiny mut" style="display:flex;justify-content:space-between"><span>${r.i + 1} / ${r.cards.length}</span><span>${cardTag(c)}</span></div>
      <div class="card"><div class="pad flash">
        <div class="fmeta">${c.qid ? `<span class="qid">${c.qid}</span>` : ""}<span class="chip ${chipClass(c.type)}">${c.tag}</span></div>
        <div class="front">${esc(c.front)}</div>
        <div class="back ${r.revealed ? "" : "hidden"}">${esc(c.back)}</div>
        ${!r.revealed ? `<div class="btnrow" style="margin-top:16px"><button class="btn block" id="revealR">Show answer</button></div>` : gradeBar()}
      </div></div>`;
    if (!r.revealed) $("#revealR").onclick = () => { r.revealed = true; renderReview(); };
    else bindGrades((g) => { gradeCard(c, g); r.done++; r.i++; r.revealed = false; renderReview(); renderHeader(); });
  }

  // =====================================================================
  //  DAY-BEFORE view
  // =====================================================================
  function renderDayBefore() {
    const d = activeDeck();
    if (!d) return empty("#dayBody", "Build or load a deck first.");
    const db = E.dayBefore(d.model);
    const hot = db.hotTopics.map((t) =>
      `<div class="card"><div class="spined"><div class="spine s5"><i style="height:100%"></i></div>
        <div class="spinebody pad" style="padding:12px 14px">
          <div style="font-family:var(--disp);font-weight:700;font-size:15px">${t.qid ? `<span class="qid">${t.qid} · </span>` : ""}${esc(t.title)}${t.heat ? ` <span class="chip amber" style="vertical-align:middle">🔥${t.heat}</span>` : ""}</div>
          ${t.definition ? `<div class="tiny mut" style="margin-top:4px">${esc(t.definition.slice(0, 220))}</div>` : ""}
        </div></div></div>`).join("");
    const traps = db.traps.length ? `<div class="section-label">🚩 Traps — do not fall for these</div>${db.traps.map((t) => `<div class="trap" style="margin:6px 0"><b>${esc(stripEmoji(t.label).replace(/EXAM TRAP\s*[—-]?\s*/i, ""))}</b>${t.body ? " — " + esc(t.body) : ""}</div>`).join("")}` : "";
    const mnem = db.mnemonics.length ? `<div class="section-label">🧠 Mnemonics</div>${db.mnemonics.map((m) => `<div class="hook" style="margin:6px 0"><b>${esc(stripEmoji(m.label))}</b>${m.body ? " — " + esc(m.body) : ""}</div>`).join("")}` : "";
    const nums = db.numbers.length ? `<div class="section-label"># Numbers to have cold</div><div class="nums" style="margin-top:8px">${db.numbers.map((n) => `<span class="numrow">${esc(n.item)}<span class="v">${esc(n.value)}</span></span>`).join("")}</div>` : "";
    $("#dayBody").innerHTML =
      `<div class="section-label">★ Highest-yield topics (${db.hotTopics.length})</div>${hot}${traps}${mnem}${nums}`;
  }

  // =====================================================================
  //  Shared card UI helpers
  // =====================================================================
  function gradeBar() {
    return `<div class="gradebar">
      <button class="grade again" data-g="0">Again<small>&lt;12h</small></button>
      <button class="grade hard" data-g="3">Hard<small>short</small></button>
      <button class="grade good" data-g="4">Good<small>on track</small></button>
      <button class="grade easy" data-g="5">Easy<small>long</small></button></div>`;
  }
  function bindGrades(cb) { $$(".grade").forEach((b) => b.onclick = () => cb(+b.dataset.g)); }
  function gradeCard(c, g) {
    const d = activeDeck(); if (!d) return;
    d.sr[c.id] = E.schedule(d.sr[c.id], g);
    saveDecks(); renderHeader();
  }
  function sessionDone(s, kind) {
    const pct = s.done ? Math.round((s.right || s.done) / s.done * 100) : 0;
    const msg = kind === "practice"
      ? `You graded <b>${s.done}</b> cards${s.right != null ? ` · ${s.right} felt solid (${pct}%)` : ""}.`
      : `<b>${s.done}</b> cards reviewed. They'll resurface on schedule.`;
    return `<div class="empty"><div class="big">✓</div><div>${msg}</div>
      <div class="btnrow" style="justify-content:center;margin-top:14px">
        <button class="btn primary" id="againBtn">${kind === "practice" ? "Again" : "Back"}</button>
        <button class="btn ghost" onclick="location.hash='#daybefore'">Day-before →</button></div></div>`;
  }
  const chipClass = (t) => ({ exam: "amber", trap: "rose", mnemonic: "violet", number: "amber", cloze: "violet", mcq: "cyan", define: "cyan" }[t] || "");
  const cardTag = (c) => { const d = activeDeck(); const t = d && d.model.topics.find((x) => x.id === c.topicId); return t ? esc(t.title.slice(0, 40)) : ""; };
  const stripEmoji = (s) => (s || "").replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F\u{1F900}-\u{1F9FF}]/gu, "").trim();

  function empty(sel, msg) { const el = sel ? $(sel) : null; const html = `<div class="empty"><div class="big">◔</div><div>${msg}</div><div class="btnrow" style="justify-content:center;margin-top:12px"><button class="btn" onclick="location.hash='#sources'">Go to Sources</button></div></div>`; if (el) el.innerHTML = html; return html; }

  // =====================================================================
  //  Optional Claude enrichment (needs server + key; see README)
  // =====================================================================
  async function claudeEnrich(topic, btn) {
    const d = activeDeck(); if (!d) return;
    btn.disabled = true; const old = btn.textContent; btn.textContent = "✨ thinking…";
    try {
      const r = await fetch("/api/enrich", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, mode: d.model.mode, title: d.model.meta.title }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ("HTTP " + r.status));
      const data = await r.json();
      const qs = (data.questions || []).map((q) =>
        `<div class="mcqmini"><b>${esc(q.q || q.question || "")}</b><div class="a">→ ${esc(q.a || q.answer || "")}</div></div>`).join("");
      const box = document.createElement("div"); box.innerHTML = qs || `<div class="tiny mut">No extra questions returned.</div>`;
      btn.closest(".btnrow").after(box);
      btn.remove();
    } catch (e) {
      toast("Enrichment unavailable: " + e.message + " — works offline without it.");
      btn.disabled = false; btn.textContent = old;
    }
  }

  // =====================================================================
  //  Navigation + wiring
  // =====================================================================
  const VIEWS = ["sources", "revise", "practice", "daybefore", "review", "settings"];
  function go(v) {
    if (!VIEWS.includes(v)) v = "sources";
    $$(".view").forEach((s) => s.classList.remove("active"));
    $("#view-" + v).classList.add("active");
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
    if (location.hash !== "#" + v) history.replaceState(null, "", "#" + v);
    window.scrollTo(0, 0);
    ({ revise: renderRevise, practice: renderPractice, daybefore: renderDayBefore, review: renderReview, sources: renderSources }[v] || (() => {}))();
  }
  function renderSources() { renderDeckList(); const d = activeDeck(); if (d && !$("#analysisWrap").innerHTML) renderAnalysis(d.model); }

  function refreshAll() { renderHeader(); const cur = (location.hash || "#sources").slice(1); go(VIEWS.includes(cur) ? cur : "sources"); renderDeckList(); }

  // toast
  let toastT;
  function toast(msg) {
    let el = $("#toast");
    if (!el) { el = document.createElement("div"); el.id = "toast"; el.style.cssText = "position:fixed;left:50%;bottom:calc(80px + env(safe-area-inset-bottom));transform:translateX(-50%);background:var(--surface2);border:1px solid var(--line2);color:var(--ink);padding:10px 16px;border-radius:10px;font-size:13px;z-index:100;box-shadow:var(--shadow);max-width:90vw;text-align:center"; document.body.appendChild(el); }
    el.textContent = msg; el.style.opacity = "1"; clearTimeout(toastT);
    toastT = setTimeout(() => (el.style.opacity = "0"), 2600);
    el.style.transition = "opacity .3s";
  }

  function init() {
    applyTheme();
    // tabs
    $$(".tab").forEach((t) => t.onclick = () => go(t.dataset.view));
    window.addEventListener("hashchange", () => go((location.hash || "#sources").slice(1)));
    $("#themeBtn").onclick = () => { state.settings.theme = state.settings.theme === "dark" ? "light" : "dark"; saveSettings(); applyTheme(); };

    // samples
    $$(".samplecard").forEach((c) => c.onclick = () => {
      const s = window.SAMPLES[c.dataset.sample];
      if (!s) return toast("Sample unavailable.");
      buildDeck(s.text, s.title);
    });
    // build
    $("#buildBtn").onclick = () => buildDeck($("#paste").value, $("#deckName").value.trim());
    // file upload / drop
    const drop = $("#drop"), file = $("#file");
    drop.onclick = () => file.click();
    file.onchange = () => { const f = file.files[0]; if (f) readFile(f); };
    ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) readFile(f); });
    function readFile(f) { const r = new FileReader(); r.onload = () => { $("#paste").value = r.result; $("#deckName").value = f.name.replace(/\.[^.]+$/, ""); toast("Loaded " + f.name + " — press Build."); }; r.readAsText(f); }

    // header deck pick
    $("#deckPick").onchange = (e) => { state.activeId = e.target.value; saveActive(); refreshAll(); };

    // settings toggles
    const setTog = (id, key, after) => { const el = $(id); el.classList.toggle("on", !!state.settings[key]); el.onclick = () => { state.settings[key] = !state.settings[key]; el.classList.toggle("on", state.settings[key]); saveSettings(); after && after(); }; };
    setTog("#tgReveal", "reveal");
    setTog("#tgClaude", "claude", () => { if (state.settings.claude) toast("Enrichment on — needs the app on a server with an API key (see README)."); renderRevise(); });
    $("#tgTheme").onclick = () => { state.settings.theme = state.settings.theme === "dark" ? "light" : "dark"; saveSettings(); applyTheme(); };
    $("#exportBtn").onclick = () => { const blob = new Blob([JSON.stringify(state.decks, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "ward-decks.json"; a.click(); };
    $("#resetBtn").onclick = () => { if (confirm("Delete ALL decks, review history and settings?")) { store.del("decks"); store.del("active"); store.del("settings"); setTimeout(() => location.reload(), 60); } };

    // service worker (offline)
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});

    refreshAll();
    if (!Object.keys(state.decks).length) go("sources");
  }

  async function boot() {
    try { await loadState(); } catch (e) { /* start empty on any storage error */ }
    init();
  }

  if (!E) { document.body.innerHTML = '<p style="padding:40px;font-family:sans-serif">engine.js failed to load. Make sure engine.js sits next to index.html.</p>'; }
  else document.addEventListener("DOMContentLoaded", boot);
})();
