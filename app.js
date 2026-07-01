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
  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // -------- state (populated asynchronously at boot) --------
  const state = {
    subjects: {},            // sid -> {id, name, createdAt, items:{iid:item}}
    activeSubject: null,     // subject folder currently open in Library
    activeGuideId: null,     // guide item currently being studied
    openDocId: null,         // sbobina/cheatsheet open in the Reader
    settings: { theme: "dark", reveal: true, claude: false },
    practice: null,
    review: null,
  };
  const subj = (sid) => state.subjects[sid || state.activeSubject] || null;
  // find any item by id across subjects
  function findItem(iid) {
    for (const s of Object.values(state.subjects)) if (s.items[iid]) return { item: s.items[iid], subject: s };
    return null;
  }
  // the guide being studied — same {model, sr} shape the study views expect
  const curGuide = () => { const f = findItem(state.activeGuideId); return f && f.item.type === "guide" ? f.item : null; };
  const activeDeck = curGuide;                    // study views call activeDeck()
  const saveSubjects = () => store.set("subjects", state.subjects);
  const saveDecks = saveSubjects;                 // legacy alias used by gradeCard
  const saveSettings = () => store.set("settings", state.settings);
  const saveActive = () => store.set("active", { subject: state.activeSubject, guide: state.activeGuideId });

  async function loadState() {
    try { await DB.get("subjects"); } catch { store = LSfallback; }
    const g = async (k, d) => { const v = await store.get(k); return v == null ? d : v; };
    let subjects = await g("subjects", null);
    if (subjects == null) {
      // migrate the previous flat "decks" (IndexedDB or legacy localStorage) into a subject
      let decks = await g("decks", null);
      if (decks == null) { try { const o = localStorage.getItem("ward:decks"); if (o) decks = JSON.parse(o); } catch {} }
      subjects = {};
      if (decks && Object.keys(decks).length) {
        const sid = uid("s_"), items = {};
        for (const [id, d] of Object.entries(decks)) {
          items[id] = Object.assign({ id, type: "guide",
            title: (d.model && d.model.meta && d.model.meta.title) || "Guide",
            createdAt: d.createdAt || Date.now() }, d);
        }
        subjects[sid] = { id: sid, name: "Imported", createdAt: Date.now(), items };
      }
      await store.set("subjects", subjects);
    }
    state.subjects = subjects || {};
    const act = await g("active", {});
    state.activeSubject = (act && act.subject && state.subjects[act.subject]) ? act.subject : (Object.keys(state.subjects)[0] || null);
    state.activeGuideId = (act && act.guide) || null;
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
  function buildGuide(text, name) {
    if (!text || text.trim().length < 40) { toast("Not enough text to build a guide."); return; }
    const s = subj(); if (!s) { toast("Open a subject first."); return; }
    const model = E.buildModel(text, name ? { title: name } : {});
    const id = uid("g_");
    s.items[id] = { id, type: "guide", title: model.meta.title, createdAt: Date.now(), model, sr: {}, raw: text };
    state.activeGuideId = id;
    saveActive(); saveSubjects();
    refreshAll();
    go("revise");
    toast("Built “" + model.meta.title + "” — " + model.mode.replace("-", " "));
  }

  // =====================================================================
  //  Shared: API + modal + markdown helpers
  // =====================================================================
  async function api(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
    return data;
  }
  function openModal(html) { const m = $("#modal"); $("#modalCard").innerHTML = html; m.hidden = false; document.body.style.overflow = "hidden"; }
  function closeModal() { $("#modal").hidden = true; $("#modalCard").innerHTML = ""; document.body.style.overflow = ""; }
  function modalBusy(msg, sub) { $("#modalCard").innerHTML = `<div class="busy"><div class="spinner"></div><div class="bmsg">${esc(msg)}</div><div class="tiny mut">${esc(sub || "")}</div></div>`; }
  const wordCount = (s) => (s.trim().match(/\S+/g) || []).length;

  // figure tokens {{IMG: query | caption}} -> placeholders + list
  function extractFigs(md) {
    const figs = [];
    const body = (md || "").replace(/\{\{\s*IMG:\s*([\s\S]*?)\}\}/gi, (_, inner) => {
      const [q, cap] = inner.split("|");
      figs.push({ query: (q || "").trim(), caption: (cap || q || "").trim(), image: null });
      return "\n\n@@FIG" + (figs.length - 1) + "@@\n\n";
    });
    return { body: body.trim(), figs };
  }
  function figureHTML(f) {
    if (!f) return "";
    if (!f.image) return `<figure class="fig missing"><div class="ph">figure: ${esc(f.caption || f.query)}</div><figcaption>${esc(f.caption || "")} <span class="attrib">— no open-licensed image found</span></figcaption></figure>`;
    return `<figure class="fig"><img src="${f.image.url}" alt="${esc(f.caption || "")}" loading="lazy"><figcaption>${esc(f.caption || f.image.title || "")} ${f.image.page ? `<a href="${f.image.page}" target="_blank" rel="noopener noreferrer" class="attrib">${esc(f.image.attribution)}</a>` : `<span class="attrib">${esc(f.image.attribution)}</span>`}</figcaption></figure>`;
  }
  function sbobinaBodyHTML(item) {
    let html = window.MD.render(item.markdown || "");
    html = html.replace(/<p>@@FIG(\d+)@@<\/p>/g, (_, k) => figureHTML((item.figs || [])[+k]));
    return html;
  }
  function docHeaderHTML(m) {
    m = m || {};
    const line1 = [m.school, m.course, m.professor ? "Prof. " + m.professor : ""].filter(Boolean).join(" — ");
    return `<div class="sbhead">
      ${line1 ? `<div class="sbrow">${esc(line1)}</div>` : ""}
      ${m.title ? `<h1 class="sbtitle">${esc(m.title)}</h1>` : ""}
      <div class="sbrow tiny mut">${[m.date, m.author ? "Author: " + m.author : ""].filter(Boolean).map(esc).join(" · ")}</div>
    </div>`;
  }

  // =====================================================================
  //  LIBRARY view — subjects (folders) and their items
  // =====================================================================
  function guideMeta(it) { const m = it.model; return `${m.mode.replace("-", " ")} · ${m.topics.length} topics · ${m.cards.length} cards`; }
  function itemMeta(it) {
    if (it.type === "guide") return guideMeta(it);
    if (it.type === "sbobina") return `lecture write-up · ${(it.figs || []).filter((f) => f.image).length} figures`;
    return "cheat sheet";
  }
  function itemRow(it) {
    const active = it.type === "guide" && it.id === state.activeGuideId;
    return `<div class="card"><div class="pad itemrow">
      <div class="imain" data-open="${it.id}">
        <div class="ititle">${esc(it.title)}${active ? ' <span class="chip green">studying</span>' : ""}</div>
        <div class="tiny mut">${itemMeta(it)}</div>
      </div>
      <button class="iconbtn" data-pdf="${it.id}" title="Export PDF" aria-label="Export PDF">⤓</button>
      <button class="iconbtn" data-delitem="${it.id}" title="Delete" aria-label="Delete">✕</button>
    </div></div>`;
  }
  function group(label, type, items, addLabel) {
    const rows = items.map(itemRow).join("");
    return `<div class="grp">
      <div class="grphead"><span>${label}</span><button class="btn ghost tiny" data-add="${type}">+ ${addLabel}</button></div>
      ${rows || `<div class="tiny mut" style="padding:2px 2px 8px">None yet.</div>`}
    </div>`;
  }
  function renderLibrary() {
    const wrap = $("#libBody");
    const sids = Object.keys(state.subjects);
    // subject chips
    const chips = sids.map((sid) => `<button class="fchip ${sid === state.activeSubject ? "on" : ""}" data-subj="${sid}">${esc(state.subjects[sid].name)}</button>`).join("");
    let html = `<div class="fchips">${chips}<button class="fchip add" id="newSubjBtn">+ Subject</button></div>`;

    const s = subj();
    if (!s) {
      html += `<div class="empty"><div class="big">📁</div><div>Create a subject folder to get started.</div>
        <div class="tiny mut" style="margin-top:6px">Each subject holds its guides, sbobine and cheat sheets. Delete the whole folder when you're done.</div>
        <div class="btnrow" style="justify-content:center;margin-top:14px"><button class="btn primary" id="newSubjBtn2">New subject</button> <button class="btn ghost" id="loadSampleBtn">Load a sample</button></div></div>`;
      wrap.innerHTML = html;
      $("#newSubjBtn").onclick = $("#newSubjBtn2").onclick = newSubjectPrompt;
      $("#loadSampleBtn") && ($("#loadSampleBtn").onclick = loadSampleSubject);
      bindSubjChips();
      return;
    }
    const items = Object.values(s.items).sort((a, b) => b.createdAt - a.createdAt);
    const guides = items.filter((i) => i.type === "guide");
    const sbob = items.filter((i) => i.type === "sbobina");
    const cheat = items.filter((i) => i.type === "cheatsheet");
    html += `<div class="subjhead">
      <div class="sname">${esc(s.name)}</div>
      <button class="btn ghost tiny" id="delSubjBtn">Delete subject</button>
    </div>`;
    html += group("Structured guides", "guide", guides, "Guide");
    html += group("Sbobine (lecture write-ups)", "sbobina", sbob, "Sbobina");
    html += group("Cheat sheets", "cheatsheet", cheat, "Cheat sheet");
    wrap.innerHTML = html;

    bindSubjChips();
    $("#newSubjBtn").onclick = newSubjectPrompt;
    $("#delSubjBtn").onclick = () => deleteSubject(s.id);
    $$("#libBody [data-add]").forEach((b) => b.onclick = () => addPrompt(b.dataset.add));
    $$("#libBody [data-open]").forEach((b) => b.onclick = () => openItem(b.dataset.open));
    $$("#libBody [data-pdf]").forEach((b) => b.onclick = (e) => { e.stopPropagation(); exportPDF(b.dataset.pdf); });
    $$("#libBody [data-delitem]").forEach((b) => b.onclick = (e) => { e.stopPropagation(); deleteItem(b.dataset.delitem); });
  }
  function bindSubjChips() { $$("#libBody [data-subj]").forEach((b) => b.onclick = () => { state.activeSubject = b.dataset.subj; saveActive(); renderLibrary(); }); }

  function newSubjectPrompt() {
    openModal(`<h3 class="mtitle">New subject</h3>
      <input id="subjName" class="input" placeholder="e.g. Medical Psychology" autofocus>
      <div class="btnrow end"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn primary" id="mOk">Create</button></div>`);
    $("#mCancel").onclick = closeModal;
    $("#mOk").onclick = () => { const n = $("#subjName").value.trim(); if (!n) return; const id = uid("s_"); state.subjects[id] = { id, name: n, createdAt: Date.now(), items: {} }; state.activeSubject = id; saveActive(); saveSubjects(); closeModal(); renderLibrary(); };
    $("#subjName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#mOk").click(); });
  }
  function deleteSubject(sid) {
    const s = state.subjects[sid]; if (!s) return;
    if (!confirm(`Delete subject “${s.name}” and everything in it?`)) return;
    if (Object.keys(s.items).includes(state.activeGuideId)) state.activeGuideId = null;
    delete state.subjects[sid];
    if (state.activeSubject === sid) state.activeSubject = Object.keys(state.subjects)[0] || null;
    saveActive(); saveSubjects(); refreshAll();
  }
  function deleteItem(iid) {
    const f = findItem(iid); if (!f) return;
    if (!confirm("Delete this item?")) return;
    delete f.subject.items[iid];
    if (state.activeGuideId === iid) state.activeGuideId = null;
    if (state.openDocId === iid) state.openDocId = null;
    saveActive(); saveSubjects(); renderLibrary(); renderHeader();
  }

  function openItem(iid) {
    const f = findItem(iid); if (!f) return;
    if (f.item.type === "guide") { state.activeGuideId = iid; saveActive(); refreshAll(); go("revise"); }
    else openReader(iid);
  }

  // ---- add flows -----------------------------------------------------
  function addPrompt(type) {
    if (type === "guide") return addGuidePrompt();
    if (type === "sbobina") return addSbobinaPrompt();
    if (type === "cheatsheet") return addCheatsheetPrompt();
  }
  function fileField(id, accept) {
    return `<label class="drop sm" id="${id}drop">Drop a file or tap — <span class="tiny mut">${accept}</span><input type="file" id="${id}" accept="${accept}" hidden></label>`;
  }
  function wireFile(id, ta) {
    const inp = $("#" + id), drop = $("#" + id + "drop");
    const read = (f) => { if (!f) return; const r = new FileReader(); r.onload = () => { $(ta).value = r.result; }; r.readAsText(f); };
    drop.onclick = () => inp.click();
    inp.onchange = () => read(inp.files[0]);
    ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => read(e.dataTransfer.files[0]));
  }
  function addGuidePrompt() {
    openModal(`<h3 class="mtitle">New structured guide</h3>
      <input id="gName" class="input" placeholder="Guide title *">
      <div class="seg gmode" id="gModeSeg">
        <button data-m="generate" class="on">Build it for me</button>
        <button data-m="import">I already have one</button>
      </div>
      <div id="gGen">
        <textarea id="gMat" class="input ta" placeholder="Course material / lecture notes *  (paste or drop a file)"></textarea>
        ${fileField("gMatFile", ".md,.txt")}
        <textarea id="gQs" class="input ta" style="min-height:110px" placeholder="Past exam questions — one per line. Leave blank if there are none."></textarea>
        <input id="gInstr" class="input" placeholder="Extra instructions (optional) — e.g. 'emphasise management', 'assume Italian oral exam'">
        <div class="tiny mut">With questions → <b>exam-driven</b>: every question answered at depth (100% coverage). Without → <b>concept-driven</b>: built from your material with questions generated. Uses your key.</div>
      </div>
      <div id="gImp" hidden>
        <textarea id="gText" class="input ta" placeholder="Paste an already-structured guide (e.g. one built earlier)…"></textarea>
        ${fileField("gImpFile", ".md,.txt")}
        <div class="tiny mut">Pure logic, no key needed — just parses a guide that's already written.</div>
      </div>
      <div class="btnrow end"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn primary" id="mOk">Build</button></div>`);
    let gmode = "generate";
    wireFile("gMatFile", "#gMat"); wireFile("gImpFile", "#gText");
    $$("#gModeSeg button").forEach((b) => b.onclick = () => {
      gmode = b.dataset.m;
      $$("#gModeSeg button").forEach((x) => x.classList.toggle("on", x === b));
      $("#gGen").hidden = gmode !== "generate"; $("#gImp").hidden = gmode !== "import";
    });
    $("#mCancel").onclick = closeModal;
    $("#mOk").onclick = () => {
      const title = $("#gName").value.trim();
      if (!title) return toast("Give the guide a title.");
      if (gmode === "import") {
        const t = $("#gText").value;
        if (!t || t.trim().length < 40) return toast("Paste the guide text first.");
        closeModal(); buildGuide(t, title);
      } else {
        const material = $("#gMat").value;
        if (wordCount(material) < 40) return toast("Add your course material first.");
        generateGuide(title, material, $("#gQs").value, $("#gInstr").value);
      }
    };
  }
  async function generateGuide(title, material, questions, instructions) {
    const exam = (questions || "").trim().length > 0;
    modalBusy("Building your guide…", exam ? "Answering every past question at depth — this can take a bit." : "Building from your material and generating questions…");
    try {
      const { markdown } = await api("/api/guide", { material, questions, instructions, title });
      const model = E.buildModel(markdown, { title });
      const id = uid("g_");
      subj().items[id] = { id, type: "guide", title: model.meta.title || title, createdAt: Date.now(), model, sr: {}, raw: markdown };
      state.activeGuideId = id; saveActive(); saveSubjects(); closeModal();
      refreshAll(); go("revise");
      toast("Built “" + (model.meta.title || title) + "” — " + model.mode.replace("-", " "));
    } catch (e) { generationError(e, "guide"); }
  }
  function addSbobinaPrompt() {
    openModal(`<h3 class="mtitle">New sbobina — lecture write-up</h3>
      <div class="grid2">
        <input id="sbTitle" class="input" placeholder="Lecture title *">
        <input id="sbDate" class="input" placeholder="Date (e.g. 17/03/2026)">
        <input id="sbSchool" class="input" placeholder="School / faculty">
        <input id="sbCourse" class="input" placeholder="Course">
        <input id="sbProf" class="input" placeholder="Professor">
        <input id="sbAuthor" class="input" placeholder="Author (you)">
      </div>
      <textarea id="sbText" class="input ta" placeholder="Paste the raw transcript or rough lecture notes…"></textarea>
      ${fileField("sbFile", ".txt,.md,.vtt,.srt")}
      <div class="tiny mut">Needs the server + an API key. Long transcripts are chunked automatically. Figures are open-licensed (Wikimedia / Openverse).</div>
      <div class="btnrow end"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn primary" id="mOk">Generate</button></div>`);
    wireFile("sbFile", "#sbText");
    $("#mCancel").onclick = closeModal;
    $("#mOk").onclick = () => {
      const title = $("#sbTitle").value.trim(), text = $("#sbText").value;
      if (!title) return toast("Give the lecture a title.");
      if (wordCount(text) < 40) return toast("Paste the transcript first.");
      const meta = { title, date: $("#sbDate").value.trim(), school: $("#sbSchool").value.trim(), course: $("#sbCourse").value.trim(), professor: $("#sbProf").value.trim(), author: $("#sbAuthor").value.trim() };
      generateSbobina(meta, text);
    };
  }
  function addCheatsheetPrompt() {
    const s = subj(); const src = Object.values(s.items).filter((i) => i.type === "guide" || i.type === "sbobina");
    const opts = src.map((i) => `<option value="${i.id}">${esc(i.title)} (${i.type})</option>`).join("");
    openModal(`<h3 class="mtitle">New cheat sheet</h3>
      <input id="csTitle" class="input" placeholder="Cheat sheet title *">
      ${src.length ? `<div class="tiny mut" style="margin-bottom:4px">Condense an existing item:</div><select id="csSrc" class="input">${opts}<option value="__paste">— paste my own text —</option></select>` : `<input type="hidden" id="csSrc" value="__paste">`}
      <textarea id="csText" class="input ta" placeholder="Or paste material to condense…" ${src.length ? "hidden" : ""}></textarea>
      <div class="tiny mut">Needs the server + an API key. Produces a dense one-pager.</div>
      <div class="btnrow end"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn primary" id="mOk">Generate</button></div>`);
    const sel = $("#csSrc"), ta = $("#csText");
    if (sel && sel.tagName === "SELECT") sel.onchange = () => { ta.hidden = sel.value !== "__paste"; };
    $("#mCancel").onclick = closeModal;
    $("#mOk").onclick = () => {
      const title = $("#csTitle").value.trim(); if (!title) return toast("Give it a title.");
      let content = "";
      if (sel && sel.value && sel.value !== "__paste") {
        const it = s.items[sel.value];
        content = it.type === "guide" ? it.raw : it.markdown;
      } else content = ta.value;
      if (wordCount(content) < 30) return toast("Not enough material to condense.");
      generateCheatsheet(title, content);
    };
  }

  async function generateSbobina(meta, transcript) {
    modalBusy("Writing up the lecture…", "This can take a moment for long transcripts.");
    try {
      const { markdown } = await api("/api/sbobina", { transcript, title: meta.title });
      const { body, figs } = extractFigs(markdown);
      for (let k = 0; k < figs.length; k++) {
        modalBusy("Finding open-licensed figures…", `${k + 1} / ${figs.length}`);
        try { figs[k].image = (await api("/api/image-search", { query: figs[k].query })).image; } catch { figs[k].image = null; }
      }
      const id = uid("b_");
      subj().items[id] = { id, type: "sbobina", title: meta.title, createdAt: Date.now(), meta, markdown: body, figs };
      saveSubjects(); closeModal(); openReader(id); renderLibrary();
    } catch (e) { generationError(e, "sbobina"); }
  }
  async function generateCheatsheet(title, content) {
    modalBusy("Condensing to a cheat sheet…");
    try {
      const { markdown } = await api("/api/cheatsheet", { content, title });
      const id = uid("c_");
      subj().items[id] = { id, type: "cheatsheet", title, createdAt: Date.now(), markdown };
      saveSubjects(); closeModal(); openReader(id); renderLibrary();
    } catch (e) { generationError(e, "cheat sheet"); }
  }
  function generationError(e, what) {
    $("#modalCard").innerHTML = `<h3 class="mtitle">Couldn't generate the ${what}</h3>
      <div class="tiny mut" style="margin-bottom:8px">${esc(e.message)}</div>
      <div class="tiny mut">This feature needs the app running on the server (Replit) with an API key set. On GitHub Pages the study features still work, but generation does not. See the README.</div>
      <div class="btnrow end"><button class="btn primary" id="mClose">OK</button></div>`;
    $("#mClose").onclick = closeModal;
  }

  // =====================================================================
  //  READER view — sbobine & cheat sheets
  // =====================================================================
  function openReader(iid) { state.openDocId = iid; go("reader"); }
  function renderReader() {
    const f = findItem(state.openDocId);
    if (!f) return void ($("#readerBody").innerHTML = empty(null, "Nothing open."));
    const it = f.item;
    const bodyHTML = it.type === "sbobina"
      ? docHeaderHTML(it.meta) + `<div class="sbobina">${sbobinaBodyHTML(it)}</div>`
      : `<div class="cheatsheet"><h1 class="sbtitle">${esc(it.title)}</h1>${window.MD.render(it.markdown || "")}</div>`;
    $("#readerBody").innerHTML = `
      <div class="readerbar">
        <button class="btn ghost tiny" id="backLib">← ${esc(f.subject.name)}</button>
        <div class="rtitle">${esc(it.title)}</div>
        <button class="btn tiny" id="pdfBtn">Export PDF</button>
      </div>
      <div class="doc">${bodyHTML}</div>`;
    $("#backLib").onclick = () => { state.openDocId = null; go("library"); };
    $("#pdfBtn").onclick = () => exportPDF(it.id);
  }

  // =====================================================================
  //  PDF export via print
  // =====================================================================
  function guideDocHTML(it) {
    const m = it.model, sheet = E.revisionSheet(m);
    const secs = sheet.map((t) => {
      const hooks = t.hooks.map((h) => `<li><b>${esc(stripEmoji(h.label))}</b>${h.body ? " — " + esc(h.body) : ""}</li>`).join("");
      const traps = t.traps.map((h) => `<li class="tr"><b>🚩 ${esc(stripEmoji(h.label).replace(/EXAM TRAP\s*[—-]?\s*/i, ""))}</b>${h.body ? " — " + esc(h.body) : ""}</li>`).join("");
      const nums = t.numbers.length ? `<div class="nums">${t.numbers.map((n) => `<span class="numrow">${esc(n.item)} <b>${esc(n.value)}</b></span>`).join("")}</div>` : "";
      const mcqs = t.mcqs.map((q) => `<div class="qa"><b>${esc(q.q)}</b><div>→ ${esc(q.a)}</div></div>`).join("");
      return `<section class="tsec"><h2>${t.qid ? t.qid + " · " : ""}${esc(t.title)}${t.heat ? " 🔥" + t.heat : ""}</h2>
        ${t.definition ? `<p class="def">${esc(t.definition)}</p>` : ""}
        ${hooks ? `<ul>${hooks}</ul>` : ""}${traps ? `<ul>${traps}</ul>` : ""}${nums}${mcqs}</section>`;
    }).join("");
    return `<h1 class="sbtitle">${esc(m.meta.title)}</h1><div class="tiny mut">${m.mode.replace("-", " ")} · ${m.topics.length} topics</div>${secs}`;
  }
  function exportPDF(iid) {
    const f = findItem(iid); if (!f) return; const it = f.item;
    let html;
    if (it.type === "sbobina") html = `<div class="sbobina">${docHeaderHTML(it.meta)}${sbobinaBodyHTML(it)}</div>`;
    else if (it.type === "cheatsheet") html = `<div class="cheatsheet"><h1 class="sbtitle">${esc(it.title)}</h1>${window.MD.render(it.markdown || "")}</div>`;
    else html = `<div class="guidedoc">${guideDocHTML(it)}</div>`;
    $("#printRoot").innerHTML = `<div class="printinner">${html}</div>`;
    document.body.classList.add("printing");
    const done = () => { document.body.classList.remove("printing"); $("#printRoot").innerHTML = ""; window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    setTimeout(() => window.print(), 60);
    setTimeout(done, 2000);
  }

  function loadSampleSubject() {
    const id = uid("s_"); state.subjects[id] = { id, name: "Samples", createdAt: Date.now(), items: {} };
    state.activeSubject = id;
    ["neuropsychology", "nephrology"].forEach((k) => {
      const s = window.SAMPLES && window.SAMPLES[k]; if (!s) return;
      const model = E.buildModel(s.text, { title: s.title });
      const gid = uid("g_");
      state.subjects[id].items[gid] = { id: gid, type: "guide", title: model.meta.title, createdAt: Date.now(), model, sr: {}, raw: s.text };
    });
    saveActive(); saveSubjects(); renderLibrary(); toast("Loaded two sample guides.");
  }

  // =====================================================================
  //  Header (subject / guide context)
  // =====================================================================
  function renderHeader() {
    const s = subj();
    const guides = s ? Object.values(s.items).filter((i) => i.type === "guide") : [];
    $("#deckbar").hidden = guides.length === 0;
    if (!guides.length) return;
    $("#deckPick").innerHTML = guides.map((g) => `<option value="${g.id}" ${g.id === state.activeGuideId ? "selected" : ""}>${esc(g.title)}</option>`).join("");
    const d = curGuide();
    if (!d) { $("#miniStat").innerHTML = ""; $("#modeChip").textContent = ""; $("#dueBadge").hidden = true; return; }
    const chip = $("#modeChip"); const isExam = d.model.mode === "exam-driven";
    chip.className = "modechip " + (isExam ? "exam" : "concept");
    chip.textContent = isExam ? "exam-driven" : "concept-driven";
    const st = E.srStats(d.model, d.sr);
    $("#miniStat").innerHTML = `<b>${d.model.cards.length}</b> cards · <b>${st.due}</b> due`;
    const badge = $("#dueBadge"); badge.hidden = st.due === 0; badge.textContent = st.due;
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

  function empty(sel, msg) { const el = sel ? $(sel) : null; const html = `<div class="empty"><div class="big">◔</div><div>${msg}</div><div class="btnrow" style="justify-content:center;margin-top:12px"><button class="btn" onclick="location.hash='#library'">Go to Library</button></div></div>`; if (el) el.innerHTML = html; return html; }

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
  const VIEWS = ["library", "revise", "practice", "daybefore", "review", "reader", "settings"];
  const TABS = ["library", "revise", "practice", "daybefore", "review"];
  function go(v) {
    if (!VIEWS.includes(v)) v = "library";
    $$(".view").forEach((s) => s.classList.remove("active"));
    $("#view-" + v).classList.add("active");
    // reader/settings aren't bottom tabs; keep library highlighted for reader
    const tabFor = v === "reader" ? "library" : v;
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === tabFor));
    if (location.hash !== "#" + v) history.replaceState(null, "", "#" + v);
    window.scrollTo(0, 0);
    ({ library: renderLibrary, revise: renderRevise, practice: renderPractice, daybefore: renderDayBefore, review: renderReview, reader: renderReader }[v] || (() => {}))();
  }

  function refreshAll() { renderHeader(); const cur = (location.hash || "#library").slice(1); go(VIEWS.includes(cur) ? cur : "library"); }

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
    $$(".tab").forEach((t) => t.onclick = () => go(t.dataset.view));
    window.addEventListener("hashchange", () => go((location.hash || "#library").slice(1)));
    $("#themeBtn").onclick = () => { state.settings.theme = state.settings.theme === "dark" ? "light" : "dark"; saveSettings(); applyTheme(); };
    $("#modalBack") && ($("#modalBack").onclick = closeModal);

    // header guide picker
    $("#deckPick").onchange = (e) => { state.activeGuideId = e.target.value; saveActive(); refreshAll(); };

    // settings toggles
    const setTog = (id, key, after) => { const el = $(id); el.classList.toggle("on", !!state.settings[key]); el.onclick = () => { state.settings[key] = !state.settings[key]; el.classList.toggle("on", state.settings[key]); saveSettings(); after && after(); }; };
    setTog("#tgReveal", "reveal");
    setTog("#tgClaude", "claude", () => { if (state.settings.claude) toast("Enrichment on — needs the app on a server with an API key (see README)."); renderRevise(); });
    $("#tgTheme").onclick = () => { state.settings.theme = state.settings.theme === "dark" ? "light" : "dark"; saveSettings(); applyTheme(); };
    $("#exportBtn").onclick = () => { const blob = new Blob([JSON.stringify(state.subjects, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "ward-subjects.json"; a.click(); };
    $("#resetBtn").onclick = () => { if (confirm("Delete ALL subjects, guides, sbobine, cheat sheets and review history?")) { store.del("subjects"); store.del("active"); store.del("settings"); store.del("decks"); setTimeout(() => location.reload(), 60); } };

    if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});

    refreshAll();
    if (!location.hash) go("library");
  }

  async function boot() {
    try { await loadState(); } catch (e) { /* start empty on any storage error */ }
    init();
  }

  if (!E) { document.body.innerHTML = '<p style="padding:40px;font-family:sans-serif">engine.js failed to load. Make sure engine.js sits next to index.html.</p>'; }
  else document.addEventListener("DOMContentLoaded", boot);
})();
