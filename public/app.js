/* Nutrient PII/PHI redaction PoC
 * A: Nutrient AI Assistant (chat + agent creates redaction annotations, human reviews)
 * B: JSON pipeline (Web SDK text JSON -> your LLM -> page/line/text/category/confidence -> SDK search -> redactions)
 * Shared: custom "finalize" = report BEFORE apply + remove comments/annotations + apply + strip metadata + verify.
 */
const NV = window.NutrientViewer;
const { List } = NV.Immutable;
const SAMPLE = "/docs/sample-case-file.pdf";
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let config;
const viewers = { a: null, b: null };

// ---------------------------------------------------------------- UI helpers
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), ms);
}
function modal(title, html, buttons = []) {
  const d = $("#modal");
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = html;
  const foot = $("#modal-foot"); foot.innerHTML = "";
  for (const b of buttons) {
    const el = document.createElement("button");
    el.textContent = b.label; if (b.primary) el.className = "primary";
    el.onclick = async () => { el.disabled = true; try { await b.onClick?.(el); } finally { el.disabled = false; } };
    foot.append(el);
  }
  if (!d.open) d.showModal();
}
$("#modal-close").onclick = () => $("#modal").close();
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function busy(btn, fn) {
  btn.disabled = true; const label = btn.textContent; btn.textContent = "Working…";
  try { return await fn(); } catch (e) { console.error(e); toast("Error: " + (e.message || e), 5000); } finally { btn.disabled = false; btn.textContent = label; }
}
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + t.dataset.tab));
}));

// ---------------------------------------------------------------- geometry
const intersects = (a, b, pad = 1) =>
  a.left < b.left + b.width + pad && b.left < a.left + a.width + pad && a.top < b.top + b.height + pad && b.top < a.top + a.height + pad;
const anyIntersect = (ra, rb) => ra.some((a) => rb.some((b) => intersects(a, b)));

// ---------------------------------------------------------------- AI Assistant config (approach A)
const AIA_SKILL = `PII/PHI redaction for UK legal case management (SAR / FOI / GDPR).
1. Work page by page. Each occurrence of a value is a separate redaction (same name on 3 pages = 3 redactions).
2. Categories: PERSON_NAME, DATE_OF_BIRTH, ADDRESS, POSTCODE, EMAIL, PHONE, NATIONAL_INSURANCE_NUMBER, NHS_NUMBER, BANK_ACCOUNT_NUMBER, SORT_CODE, IBAN, MEDICAL_CONDITION.
3. Scanned text can contain OCR errors (O instead of 0, extra spaces inside emails/phones). Redact the text exactly as it appears in the document.
4. Give a confidence score (0-100) per occurrence based on context. Company names, system/reference codes, flowers or street-name words are NOT personal data.
5. Only create redactions for confidence >= 90. List items between 60 and 89 in a table for human review, without redacting them.
6. In FOI/SAR disclosures, names and work contact details of public officials acting in an official capacity are not redacted unless the user says otherwise.
7. Never apply (burn in) redactions yourself: only mark them. The reviewer finalizes.
8. Always finish with a table: page | category | text | confidence | action.
9. LOCATING TEXT: read the page text, then locate every value with the text search tool and create the redaction from the rects it returns, one redaction per occurrence. Never estimate or draw coordinates from a page image for text. Page images are only for non-text content such as handwritten signatures or photos.
10. Redact the value only (e.g. the email address), never its label or neighbouring words. Never redact a word that is part of a company name (e.g. "John Smith & Sons Ltd").`;

const AIA_PROMPTS = [
  ["Data subject PII", "Find all personal data of the data subject John Michael Smith in this document (name, DOB, NI number, addresses, emails, phones, bank details, NHS number, health information), including OCR variants like J0hn or O77OO 9OO123. Mark each occurrence >= 90% confidence for redaction and give me the table."],
  ["Health data (PHI) + next of kin", "Mark for redaction all health information (diagnoses, NHS number, GP identifiers) and the next of kin's personal data. Give confidence per item."],
  ["FOI check", "This is an FOI/SAR disclosure. Which names or contact details did you NOT redact because they are officials acting in an official capacity? Explain briefly."],
  ["Signature", "Is there a handwritten signature in this document? If yes, on which page, and mark that area for redaction."],
];

function aiaConfig() {
  const ask = $("#aia-approval").checked;
  return {
    sessionId: config.aia.sessionId,
    jwt: config.aia.jwt,
    backendUrl: config.aia.backendUrl,
    agentId: "agentic",
    agentConfiguration: {
      skills: [{ name: "pii-redaction", description: "Use whenever the user asks to find, mark, review or redact personal data, PII, PHI, health data, bank details or signatures.", content: AIA_SKILL }],
      toolApproval: { defaults: { default: "allow", read: "allow", write: ask ? "ask" : "allow" }},
    },
  };
}

// ---------------------------------------------------------------- viewer loading
async function loadViewer(which, documentSrc) {
  const container = $("#viewer-" + which);
  if (viewers[which]) { try { NV.unload(container); } catch {} viewers[which] = null; }
  const items = NV.defaultToolbarItems.filter((i) => i.type !== "export-pdf");
  for (const t of ["redact-text-highlighter", "redact-rectangle"]) if (!items.some((i) => i.type === t)) items.push({ type: t });
  const conf = {
    container, document: documentSrc, baseUrl: location.origin + "/vendor/",
    toolbarItems: items,
    initialViewState: new NV.ViewState({ sidebarMode: which === "b" ? NV.SidebarMode.ANNOTATIONS : null }),
  };
  if (config.licenseKey) conf.licenseKey = config.licenseKey;
  if (which === "a" && config.aia.up) {
    conf.aiAssistant = aiaConfig();
    conf.toolbarItems = [...items, { type: "ai-assistant" }];
  }
  let inst;
  try { inst = await NV.load(conf); }
  catch (e) {
    if (!conf.licenseKey) throw e;
    console.warn("License rejected on this host, retrying in evaluation mode:", e.message);
    try { NV.unload(container); } catch {}
    delete conf.licenseKey; config.licenseKey = ""; inst = await NV.load(conf);
  }
  viewers[which] = inst;
  // Open the chat only once the PDF core is up: showAIAssistant in initialViewState
  // races the engine start ("CoreClient not yet initialized") and the chat never connects.
  if (conf.aiAssistant) setTimeout(() => inst.setViewState((v) => v.set("showAIAssistant", true)), 500);
  if (which === "a") wireA(inst); else wireB(inst);
  return inst;
}

// One row per redacted occurrence. Our own redactions (B) are already one per occurrence;
// an AI Assistant redaction can group several occurrences as several rects of one annotation.
async function occurrences(inst, a) {
  const clean = (t) => t.replace(/\s+/g, " ").trim();
  if (a.customData?.poc || a.rects.size <= 1) return [{ rect: a.boundingBox, text: clean(await inst.getTextFromRects(a.pageIndex, a.rects)) }];
  const out = [];
  for (const r of a.rects) out.push({ rect: r, text: clean(await inst.getTextFromRects(a.pageIndex, List([r]))) });
  return out;
}

// ================================================================ APPROACH A
function wireA(inst) {
  const refresh = () => renderA(inst);
  inst.addEventListener("annotations.change", refresh);
  refresh();
}
async function renderA(inst) {
  const rows = [];
  for (let p = 0; p < inst.totalPageCount; p++) {
    for (const a of await inst.getAnnotations(p)) {
      if (!(a instanceof NV.Annotations.RedactionAnnotation)) continue;
      for (const o of await occurrences(inst, a)) rows.push({ a, p, text: o.text, rect: o.rect });
    }
  }
  $("#a-count").textContent = rows.length;
  const list = $("#a-list");
  if (!rows.length) { list.innerHTML = `<div class="empty">No redaction marked yet.</div>`; return; }
  list.innerHTML = rows.map((r, i) => `
    <div class="item" data-i="${i}">
      <span>■</span>
      <div><div class="txt">${esc(r.text || "(area)")}</div><div class="meta">${esc(r.a.creatorName || "AI Assistant")}</div></div>
      <div class="right"><span class="pill src">p.${r.p + 1}</span></div>
    </div>`).join("");
  list.querySelectorAll(".item").forEach((el) => (el.onclick = () => {
    const r = rows[+el.dataset.i];
    inst.jumpToRect(r.p, r.rect); inst.setSelectedAnnotations(List([r.a.id]));
  }));
}
function renderPrompts() {
  const box = $("#aia-prompts");
  box.innerHTML = AIA_PROMPTS.map(([t, p], i) => `<button class="chip" data-i="${i}"><b>${esc(t)}</b>${esc(p)}</button>`).join("");
  box.querySelectorAll(".chip").forEach((c) => (c.onclick = async () => {
    const text = AIA_PROMPTS[+c.dataset.i][1];
    try { await navigator.clipboard.writeText(text); } catch {}
    viewers.a?.setViewState((v) => v.set("showAIAssistant", true));
    toast("Prompt copied — paste it in the AI Assistant chat (⌘V)");
  }));
  $("#aia-approval").onchange = () => { toast("Reloading viewer A with the new approval policy…"); loadViewer("a", SAMPLE); };
}

// ================================================================ APPROACH B
const B = { json: null, lineIndex: new Map(), items: [], seq: 0, metrics: {} };
const auto = () => +$("#t-auto").value;
const rev = () => +$("#t-rev").value;
const tier = (it) => (it.confidence >= auto() ? "ok" : it.confidence >= rev() ? "rev" : "low");

// Regexes used both by "patterns" (through the SDK search) and by the cross-check (on the plain text string).
// `score`: strict formats are certain (100); loose ones (any 8 digits, any 10 digits, postcode-like) go to review.
const UK_PATTERNS = [
  { category: "PHONE", re: String.raw`(?:\+44 ?\d{2,4}|\b0\d{2,4}) ?\d{3,4} ?\d{3,4}\b`, score: 95 },
  { category: "SORT_CODE", re: String.raw`\b\d{2}-\d{2}-\d{2}\b`, score: 100 },
  { category: "BANK_ACCOUNT_NUMBER", re: String.raw`\b\d{8}\b`, score: 75 },
  { category: "NATIONAL_INSURANCE_NUMBER", re: String.raw`\b[A-CEGHJ-PR-TW-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b`, score: 100 },
  { category: "NHS_NUMBER", re: String.raw`\b\d{3} ?\d{3} ?\d{4}\b`, score: 75 },
  { category: "IBAN", re: String.raw`\bGB\d{2} ?[A-Z]{4}(?: ?\d{4}){3} ?\d{2}\b`, score: 100 },
  { category: "POSTCODE", re: String.raw`\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b`, score: 80 },
  { category: "EMAIL", re: String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`, score: 100 },
];
const SDK_PRESETS = [
  { category: "EMAIL", preset: NV.SearchPattern.EMAIL_ADDRESS, score: 100 },
  { category: "PHONE", preset: NV.SearchPattern.INTERNATIONAL_PHONE_NUMBER, score: 95 },
  { category: "CREDIT_CARD", preset: NV.SearchPattern.CREDIT_CARD_NUMBER, score: 100 },
];

function wireB(inst) {
  inst.addEventListener("annotations.delete", (deleted) => {
    const ids = new Set(deleted.map((a) => a.id).toArray());
    let changed = false;
    for (const it of B.items) if (it.annotId && ids.has(it.annotId)) { it.annotId = null; it.selected = false; it.manual = true; changed = true; }
    if (changed) renderB();
  });
}

async function extractJson(inst) {
  const t0 = performance.now();
  const pages = []; B.lineIndex.clear();
  for (let p = 0; p < inst.totalPageCount; p++) {
    const info = inst.pageInfoForIndex(p);
    const lines = [];
    (await inst.textLinesForPageIndex(p)).forEach((l, i) => {
      const text = l.contents.trim(); if (!text) return;
      const id = `p${p + 1}-l${i + 1}`;
      const b = l.boundingBox;
      lines.push({ id, text, bbox: [b.left, b.top, b.width, b.height].map((n) => Math.round(n * 10) / 10) });
      B.lineIndex.set(id, { page: p, text, rect: b });
    });
    pages.push({ page: p + 1, width: info.width, height: info.height, lines });
  }
  B.json = { document: "sample-case-file.pdf", pageCount: pages.length, pages };
  B.metrics.extractMs = Math.round(performance.now() - t0);
  return B.json;
}
// What is sent to the LLM: ids + text only (boxes stay local).
const llmPayload = (json) => ({ pages: json.pages.map((p) => ({ page: p.page, lines: p.lines.map(({ id, text }) => ({ id, text })) })) });

function fuzzyRegex(text) {
  const map = { "0": "[0Oo]", o: "[0Oo]", "1": "[1lI|]", l: "[1lI|]", i: "[1lIi|]", "5": "[5Ss]", s: "[5Ss]", "8": "[8B]", b: "[8Bb]" };
  return [...text.replace(/\s+/g, "")]
    .map((c) => map[c.toLowerCase()] || c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"))
    .join("\\s*");
}
// Locate an LLM item on ITS page and, when known, inside ITS line only.
async function locate(inst, it) {
  const p = it.page - 1;
  const line = B.lineIndex.get(it.lineId);
  const keep = (res) => res.filter((r) => r.pageIndex === p && (!line || r.rectsOnPage.some((rc) => intersects(rc, line.rect, 2))));
  const opts = { startPageIndex: p, endPageIndex: p, caseSensitive: false };
  if (it.text.trim().length >= 2) {
    let res = keep((await inst.search(it.text.trim(), opts)).toArray());
    if (res.length) return { rects: res[0].rectsOnPage.toArray(), match: "exact" };
    if ($("#b-fuzzy").checked) {
      res = keep((await inst.search(fuzzyRegex(it.text), { ...opts, searchType: NV.SearchType.REGEX })).toArray());
      if (res.length) return { rects: res[0].rectsOnPage.toArray(), match: "fuzzy" };
    }
  }
  return { rects: [], match: line ? "line?" : "none" };
}

function addItem(it) {
  it.id = ++B.seq; it.annotId = null; it.manual = false;
  it.selected = tier(it) === "ok" && it.rects.length > 0;
  B.items.push(it);
  return it;
}

async function runDetect(btn) {
  const inst = viewers.b;
  if (!B.json) await extractJson(inst);
  const payload = llmPayload(B.json);
  const r = await fetch("/api/detect", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document: payload, foi: $("#b-foi").checked }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  // replace previous LLM results
  await removeItems((it) => it.source === "llm");
  for (const e of data.entities) {
    const loc = await locate(inst, e);
    addItem({ ...e, source: "llm", rects: loc.rects, match: loc.match });
  }
  Object.assign(B.metrics, {
    model: data.model, llmMs: data.ms, promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens,
    jsonChars: JSON.stringify(payload).length, entities: data.entities.length,
  });
  await sync(); renderB();
  toast(`${data.entities.length} items returned by ${data.model}`);
}

async function runPatterns() {
  const inst = viewers.b;
  const t0 = performance.now();
  await removeItems((it) => it.source === "pattern");
  const hits = [];
  for (const p of SDK_PRESETS) for (const r of await inst.search(p.preset, { searchType: NV.SearchType.PRESET })) hits.push({ r, category: p.category, how: "SDK preset", score: p.score });
  for (const p of UK_PATTERNS) for (const r of await inst.search(p.re, { searchType: NV.SearchType.REGEX, caseSensitive: true })) hits.push({ r, category: p.category, how: "regex", score: p.score });
  let added = 0, confirmed = 0;
  for (const { r, category, how, score } of hits) {
    const rects = r.rectsOnPage.toArray();
    const text = r.previewText.substr(r.locationInPreview ?? 0, r.lengthInPreview ?? r.previewText.length);
    const dup = B.items.find((it) => it.page === r.pageIndex + 1 && it.rects.length && anyIntersect(it.rects, rects));
    if (dup) { if (dup.source !== "pattern") { dup.confirmedBy = how; confirmed++; } continue; }
    addItem({ source: "pattern", category, text, page: r.pageIndex + 1, lineId: null, confidence: score, reason: score >= 95 ? `Deterministic ${how} match (no AI, no tokens)` : `Loose ${how} format: may be a company number / system code, human review`, rects, match: how });
    added++;
  }
  B.metrics.patternMs = Math.round(performance.now() - t0);
  await sync(); renderB();
  toast(`Patterns: ${added} new, ${confirmed} confirming LLM items`);
}

async function runCrossCheck() {
  const inst = viewers.b;
  const json = await extractJson(inst); // fresh text
  const t0 = performance.now();
  const found = [];
  for (const page of json.pages) for (const line of page.lines) for (const p of UK_PATTERNS) {
    for (const m of line.text.matchAll(new RegExp(p.re, "g"))) found.push({ page: page.page, lineId: line.id, text: m[0], category: p.category });
  }
  const regexMs = (performance.now() - t0).toFixed(1);
  const reds = await allRedactions(inst);
  for (const f of found) {
    const loc = await locate(inst, { ...f, text: f.text });
    f.rects = loc.rects;
    f.covered = reds.some((a) => a.pageIndex === f.page - 1 && anyIntersect(a.rects.toArray(), loc.rects));
  }
  const missing = found.filter((f) => !f.covered);
  const chars = json.pages.reduce((n, p) => n + p.lines.reduce((m, l) => m + l.text.length, 0), 0);
  modal("Regex cross-check on the extracted text", `
    <p class="muted">Regexes run on the <b>plain text string</b> (${chars.toLocaleString()} characters) extracted once from the PDF, not on the PDF itself: ${regexMs} ms for ${UK_PATTERNS.length} patterns × ${json.pages.length} pages. Only the hits are then located in the viewer.</p>
    <div class="kpis">
      <div class="kpi"><div class="v">${found.length}</div><div class="l">regex hits</div></div>
      <div class="kpi good"><div class="v">${found.length - missing.length}</div><div class="l">already covered by a redaction</div></div>
      <div class="kpi ${missing.length ? "bad" : "good"}"><div class="v">${missing.length}</div><div class="l">not covered</div></div>
      <div class="kpi"><div class="v">${regexMs} ms</div><div class="l">regex time</div></div>
    </div>
    <table><tr><th></th><th>Page</th><th>Category</th><th>Text</th></tr>
    ${found.map((f) => `<tr><td>${f.covered ? "✅" : "⚠️"}</td><td>${f.page}</td><td>${f.category}</td><td class="mono">${esc(f.text)}</td></tr>`).join("")}
    </table>
    <p class="muted small">Regex is a safety net: some hits are legitimately not personal data (company numbers, system codes). Uncovered hits are added to the list as <b>review</b> items so a human decides.</p>`,
    missing.length ? [{ label: `Add ${missing.length} uncovered hit(s) for review`, primary: true, onClick: async () => {
      for (const f of missing) addItem({ source: "regex", category: f.category, text: f.text, page: f.page, lineId: f.lineId, confidence: Math.max(rev(), Math.min(auto() - 1, 75)), reason: "Regex cross-check hit not covered by any redaction", rects: f.rects, match: "regex" });
      await sync(); renderB(); $("#modal").close();
    } }] : []);
}

async function removeItems(pred) {
  const gone = B.items.filter(pred);
  const ids = gone.map((it) => it.annotId).filter(Boolean);
  B.items = B.items.filter((it) => !pred(it));
  if (ids.length) { try { await viewers.b.delete(ids); } catch {} }
}

// Make the viewer match the checkboxes: one redaction annotation per selected occurrence.
async function sync() {
  const inst = viewers.b;
  const del = B.items.filter((it) => !it.selected && it.annotId);
  if (del.length) { const ids = del.map((it) => it.annotId); del.forEach((it) => (it.annotId = null)); await inst.delete(ids); }
  const add = B.items.filter((it) => it.selected && !it.annotId && it.rects.length);
  if (!add.length) return;
  const annots = add.map((it) => new NV.Annotations.RedactionAnnotation({
    pageIndex: it.page - 1,
    rects: List(it.rects),
    boundingBox: NV.Geometry.Rect.union(List(it.rects)),
    outlineColor: tier(it) === "ok" ? new NV.Color({ r: 220, g: 38, b: 38 }) : new NV.Color({ r: 234, g: 140, b: 0 }),
    creatorName: it.source === "llm" ? "LLM (JSON)" : it.source === "pattern" ? "Pattern engine" : "Regex cross-check",
    customData: { poc: true, itemId: it.id, category: it.category, confidence: it.confidence, source: it.source, match: it.match },
  }));
  const created = await inst.create(annots);
  created.forEach((a, i) => (add[i].annotId = a.id));
}

function renderB() {
  const items = B.items;
  $("#b-count").textContent = items.filter((i) => i.selected).length + " / " + items.length;
  const m = B.metrics;
  $("#b-metrics").innerHTML = [
    m.extractMs != null && `JSON extract <b>${m.extractMs} ms</b>`,
    m.jsonChars && `JSON to LLM <b>${(m.jsonChars / 1024).toFixed(1)} KB</b>`,
    m.promptTokens && `tokens <b>${m.promptTokens}</b> in / <b>${m.completionTokens}</b> out`,
    m.llmMs && `${esc(m.model)} <b>${(m.llmMs / 1000).toFixed(1)} s</b>`,
    m.patternMs != null && `patterns <b>${m.patternMs} ms</b> (0 tokens)`,
  ].filter(Boolean).join(" · ");
  const list = $("#b-list");
  if (!items.length) { list.innerHTML = `<div class="empty">Run ② (LLM) and/or ③ (patterns).</div>`; return; }
  const groups = {};
  for (const it of items) (groups[it.category] ||= []).push(it);
  list.innerHTML = Object.keys(groups).sort().map((cat) => {
    const g = groups[cat].sort((x, y) => x.page - y.page || y.confidence - x.confidence);
    const allOn = g.every((i) => i.selected || !i.rects.length);
    return `<div class="group"><div class="group-head"><input type="checkbox" data-group="${cat}" ${allOn ? "checked" : ""}/> ${cat.replace(/_/g, " ")} <span class="n">${g.length}</span></div>
      ${g.map((it) => {
        const t = tier(it);
        const pill = it.rects.length ? `<span class="pill ${t}">${it.confidence}%</span>` : `<span class="pill miss" title="Not located on the page">not found</span>`;
        return `<div class="item ${t === "low" ? "low" : ""}" data-id="${it.id}" title="${esc(it.reason || "")}">
          <input type="checkbox" data-id="${it.id}" ${it.selected ? "checked" : ""} ${it.rects.length ? "" : "disabled"}/>
          <div><div class="txt">${esc(it.text)}</div><div class="meta">p.${it.page} · ${it.source}${it.match ? " · " + it.match : ""}${it.confirmedBy ? " · ✔ " + esc(it.confirmedBy) : ""}${it.subjectData === false ? " · third party" : ""}</div></div>
          <div class="right">${pill}</div></div>`;
      }).join("")}</div>`;
  }).join("");
  list.querySelectorAll("input[data-id]").forEach((cb) => (cb.onclick = async (e) => {
    e.stopPropagation();
    const it = items.find((i) => i.id === +cb.dataset.id); it.selected = cb.checked; it.manual = true;
    await sync(); renderB();
  }));
  list.querySelectorAll("input[data-group]").forEach((cb) => (cb.onclick = async () => {
    for (const it of groups[cb.dataset.group]) if (it.rects.length) { it.selected = cb.checked; it.manual = true; }
    await sync(); renderB();
  }));
  list.querySelectorAll(".item").forEach((el) => (el.onclick = () => {
    const it = items.find((i) => i.id === +el.dataset.id);
    const inst = viewers.b;
    if (it.rects.length) inst.jumpToRect(it.page - 1, NV.Geometry.Rect.union(List(it.rects)));
    else inst.setViewState((v) => v.set("currentPageIndex", it.page - 1));
    if (it.annotId) inst.setSelectedAnnotations(List([it.annotId]));
  }));
}

function onThresholds() {
  if (+$("#t-rev").value > +$("#t-auto").value) $("#t-rev").value = $("#t-auto").value;
  $("#t-auto-v").textContent = auto(); $("#t-rev-v").textContent = rev();
  for (const it of B.items) if (!it.manual) it.selected = tier(it) === "ok" && it.rects.length > 0;
  clearTimeout(onThresholds._t);
  onThresholds._t = setTimeout(async () => { await sync(); renderB(); }, 120);
  renderB();
}
$("#t-auto").oninput = onThresholds;
$("#t-rev").oninput = onThresholds;

$("#b-extract").onclick = (e) => busy(e.currentTarget, async () => {
  const json = await extractJson(viewers.b);
  renderB();
  const payload = llmPayload(json);
  modal("JSON structure extracted with the Web SDK", `
    <p class="muted">${json.pageCount} pages, ${json.pages.reduce((n, p) => n + p.lines.length, 0)} text lines in ${B.metrics.extractMs} ms. Only <b>ids + text</b> go to the LLM (${(JSON.stringify(payload).length / 1024).toFixed(1)} KB); bounding boxes stay in the app and are used to place redactions on the exact line the LLM points to. In production the same structure can come from Azure Document Intelligence or Nutrient OCR/ICR/VLM extraction for scans.</p>
    <h5>Sent to the LLM</h5><pre>${esc(JSON.stringify(payload, null, 1)).slice(0, 6000)}…</pre>
    <h5>Kept locally (index)</h5><pre>${esc(JSON.stringify(json.pages[0].lines.slice(0, 6), null, 1))}…</pre>`,
    [{ label: "Download full JSON", onClick: () => download("document-structure.json", JSON.stringify(json, null, 2), "application/json") }]);
});
$("#b-detect").onclick = (e) => busy(e.currentTarget, () => runDetect());
$("#b-patterns").onclick = (e) => busy(e.currentTarget, () => runPatterns());
$("#b-crosscheck").onclick = (e) => busy(e.currentTarget, () => runCrossCheck());

// ================================================================ FINALIZE (shared)
async function allRedactions(inst) {
  const out = [];
  for (let p = 0; p < inst.totalPageCount; p++) for (const a of await inst.getAnnotations(p)) if (a instanceof NV.Annotations.RedactionAnnotation) out.push(a);
  return out;
}
async function docText(inst) {
  let s = "";
  for (let p = 0; p < inst.totalPageCount; p++) s += (await inst.textLinesForPageIndex(p)).map((l) => l.contents).join("\n") + "\n";
  return s;
}
const csv = (rows) => {
  const cols = ["page", "category", "text", "confidence", "source", "method", "markedBy"];
  return [cols.join(","), ...rows.map((r) => cols.map((c) => `"${String(r[c] ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
};

async function finalize(which) {
  const inst = viewers[which];
  const all = [];
  for (let p = 0; p < inst.totalPageCount; p++) (await inst.getAnnotations(p)).forEach((a) => all.push(a));
  const reds = all.filter((a) => a instanceof NV.Annotations.RedactionAnnotation);
  const others = all.filter((a) => !(a instanceof NV.Annotations.RedactionAnnotation));
  let comments = [];
  try { comments = (await inst.getComments()).toArray(); } catch {}
  const rows = [];
  for (const a of reds) {
    const cd = a.customData || {};
    for (const o of await occurrences(inst, a)) rows.push({
      page: a.pageIndex + 1,
      category: cd.category || (which === "a" ? "AI Assistant" : "Manual"),
      text: o.text || "(area / image)",
      confidence: cd.confidence ?? "", source: cd.source || (which === "a" ? "ai-assistant" : "manual"),
      method: cd.match || "", markedBy: a.creatorName || "",
    });
  }
  rows.sort((x, y) => x.page - y.page);
  const report = { document: "sample-case-file.pdf", approach: which === "a" ? "A - AI Assistant" : "B - JSON pipeline", generatedAt: new Date().toISOString(), redactions: rows };
  const typeName = (a) => a.constructor.readableName || a.constructor.name.replace("Annotation", "");
  const otherTypes = others.reduce((m, a) => ((m[typeName(a)] = (m[typeName(a)] || 0) + 1), m), {});

  if (!rows.length) return toast("Nothing marked for redaction yet.");
  modal("Redaction report — before apply", `
    <div class="kpis">
      <div class="kpi"><div class="v">${rows.length}</div><div class="l">redactions to apply</div></div>
      <div class="kpi"><div class="v">${new Set(rows.map((r) => r.page)).size}</div><div class="l">pages affected</div></div>
      <div class="kpi ${others.length ? "bad" : ""}"><div class="v">${others.length}</div><div class="l">other annotations to remove<br>${esc(Object.entries(otherTypes).map(([k, v]) => `${v} ${k}`).join(", "))}</div></div>
      <div class="kpi ${comments.length ? "bad" : ""}"><div class="v">${comments.length}</div><div class="l">comments to remove</div></div>
    </div>
    <p class="muted">This report is captured <b>before</b> the redactions are burned in (the text underneath is gone afterwards). Finalizing then removes every reviewer note/highlight/comment, applies the redactions, strips the document metadata (author, title, keywords, XMP) and re-checks the output.</p>
    <table><tr><th>Page</th><th>Category</th><th>Redacted text</th><th>Conf.</th><th>Source</th></tr>
    ${rows.map((r) => `<tr><td>${r.page}</td><td>${esc(r.category)}</td><td class="mono">${esc(r.text)}</td><td>${r.confidence !== "" ? r.confidence + "%" : ""}</td><td>${esc(r.source)}${r.method ? " · " + esc(r.method) : ""}</td></tr>`).join("")}
    </table>`, [
    { label: "Download report (CSV)", onClick: () => download("redaction-report.csv", csv(rows), "text/csv") },
    { label: "Download report (JSON)", onClick: () => download("redaction-report.json", JSON.stringify(report, null, 2), "application/json") },
    { label: "Apply & finalize", primary: true, onClick: () => applyFinal(which, inst, rows, others, comments, report) },
  ]);
}

async function applyFinal(which, inst, rows, others, comments, report) {
  $("#modal-body").insertAdjacentHTML("afterbegin", `<div class="status">Removing annotations & comments, applying redactions, scrubbing metadata…</div>`);
  if (others.length) await inst.delete(others.map((a) => a.id));
  if (comments.length) await inst.delete(comments.map((c) => c.id));
  await inst.applyRedactions();
  const exported = await inst.exportPDF();
  const resp = await fetch("/api/scrub", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: exported });
  if (!resp.ok) throw new Error("Metadata scrub failed");
  const scrub = JSON.parse(decodeURIComponent(resp.headers.get("X-Scrub-Report") || "%7B%7D"));
  const finalPdf = await resp.arrayBuffer();
  const copy = finalPdf.slice(0);
  const out = await loadViewer(which, finalPdf);
  if (which === "b") { B.items = []; B.json = null; renderB(); }

  // Verification on the output document
  const text = (await docText(out)).replace(/\s+/g, " ");
  const leaks = rows.filter((r) => r.text.length >= 3 && r.text !== "(area / image)" && text.toLowerCase().includes(r.text.toLowerCase()));
  let annotsLeft = 0;
  for (let p = 0; p < out.totalPageCount; p++) annotsLeft += (await out.getAnnotations(p)).size;
  const meta = scrub.before || {};
  report.finalizedAt = new Date().toISOString();
  report.verification = { textLeaks: leaks.map((l) => l.text), annotationsLeft: annotsLeft, metadataRemoved: meta };

  modal("Finalized — verification of the output", `
    <div class="kpis">
      <div class="kpi ${leaks.length ? "bad" : "good"}"><div class="v">${leaks.length}</div><div class="l">redacted strings still in the text layer</div></div>
      <div class="kpi ${annotsLeft ? "bad" : "good"}"><div class="v">${annotsLeft}</div><div class="l">annotations/comments left</div></div>
      <div class="kpi good"><div class="v">${rows.length}</div><div class="l">redactions burned in</div></div>
      <div class="kpi ${scrub.removedAnnots ? "bad" : "good"}"><div class="v">${scrub.removedAnnots ?? 0}</div><div class="l">stray annotations found by the server check</div></div>
    </div>
    ${leaks.length ? `<p class="status err">Still found elsewhere in the text: ${leaks.map((l) => esc(l.text)).join(", ")}. Another occurrence was left unredacted — check it is intentional (e.g. inside a company name) or redact it.</p>` : ""}
    <h5>Metadata removed</h5>
    <table>${Object.entries(meta).map(([k, v]) => `<tr><th>${k}</th><td class="mono"><s>${esc(v || "—")}</s></td></tr>`).join("")}</table>
    <p class="muted small">The viewer now shows the final document. Viewer annotations and comments are deleted through the Web SDK API before <code>applyRedactions()</code>; the server only removes the Info dictionary/XMP (the Web SDK has no metadata API) and double-checks no annotation survived.</p>`, [
    { label: "Download report (CSV)", onClick: () => download("redaction-report.csv", csv(rows), "text/csv") },
    { label: "Download report (JSON)", onClick: () => download("redaction-report.json", JSON.stringify(report, null, 2), "application/json") },
    { label: "Download redacted PDF", primary: true, onClick: () => download("sample-case-file-REDACTED.pdf", copy, "application/pdf") },
  ]);
}
document.querySelectorAll("[data-finalize]").forEach((b) => (b.onclick = (e) => busy(e.currentTarget, () => finalize(b.dataset.finalize))));

// ================================================================ boot
async function boot() {
  config = await (await fetch("/api/config")).json();
  const st = $("#aia-status");
  if (config.aia.up) { st.className = "status ok"; st.textContent = `AI Assistant service connected (${config.aia.backendUrl}). Your own LLM key, your infrastructure.`; }
  else { st.className = "status err"; st.textContent = `AI Assistant service not reachable at ${config.aia.backendUrl} — start it with: docker compose -f aia/docker-compose.yml up -d`; }
  renderPrompts(); renderB();
  await loadViewer("b", SAMPLE);
  await loadViewer("a", SAMPLE);
}
$("#reset-all").onclick = (e) => busy(e.currentTarget, async () => {
  B.items = []; B.json = null; B.metrics = {}; renderB();
  config = await (await fetch("/api/config")).json();
  await loadViewer("a", SAMPLE); await loadViewer("b", SAMPLE);
  toast("Original sample reloaded in both viewers");
});
boot().catch((e) => { console.error(e); toast("Startup error: " + e.message, 8000); });
