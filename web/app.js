// Interface de la version en ligne. Tout se passe dans le navigateur (voir core.js).
import * as core from "./core.js";

// Bibliothèques libres, copiées dans vendor/ par scripts/build-web.mjs.
const LIBS = {
  mupdf: "./vendor/mupdf/mupdf.js",
  pdflib: "vendor/pdf-lib.min.js",
  xlsx: "vendor/xlsx.full.min.js",
  docx: "vendor/docx.iife.js",
  tesseract: "vendor/tesseract/tesseract.min.js",
};
const vendorUrl = path => new URL("vendor/tesseract/" + path, location.href).href;

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const PT = 96 / 72;           // zoom 100 % : 1 point PDF = 1,33 pixel écran
const OCR_ZOOM = 3.5;         // résolution envoyée à l'OCR (~250 dpi)
const MAX_UNDO = 30;

let ready = false;
let doc = null;               // document affiché : { name, bytes, pages, history, mu, version… }
const docs = [];              // tous les documents ouverts (un onglet chacun)
let twoPages = false;         // affichage deux pages côte à côte
let mode = "read";
let zoom = 1;                 // 1 = 100 % ; ou "width" / "page" (ajusté à la fenêtre)
let current = 0;              // page affichée (la plus visible)

function say(text, err) { const m = $("#msg"); m.textContent = text; m.className = err ? "err" : ""; }
function setButtons(disabled) {
  $$(".ribbon button, .ribbon input, .ribbon select").forEach(b => b.disabled = disabled || (!doc && !b.classList.contains("always")));
  $$("[data-sample], label.btn input").forEach(b => b.disabled = disabled);
  $("#undo").disabled = disabled || !doc || !doc.history.length;
  $("#redo").disabled = disabled || !doc || !doc.future.length;
}
async function busy(message, fn) {
  say(message); document.body.classList.add("busy"); setButtons(true);
  try { return await fn(); }
  catch (e) { console.error(e); say("Erreur : " + (e.message || e), true); }
  finally { document.body.classList.remove("busy"); setButtons(false); }
}

const scripts = {};
function loadScript(url) {
  return scripts[url] ??= new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = url; s.onload = ok;
    s.onerror = () => ko(new Error("impossible de charger un composant (vérifiez la connexion Internet)"));
    document.head.appendChild(s);
  });
}

// ------------------------------------------------------------ document

function setBytes(bytes) {
  doc.bytes = bytes;
  doc.mu?.destroy();
  doc.mu = core.openMu(bytes);
  doc.pages = core.pageInfo(bytes);
  doc.annots = core.listAnnotations(bytes);
  doc.outline = core.outline(doc.mu);
  doc.fieldList = core.fields(doc.mu);
  doc.version++;
  found = null; $("#find-count").textContent = "";
  render();
  refreshList();
  refreshSide();
}

function setTitle(text) {
  document.title = text;
  window.pywebview?.api?.titre?.(text);
}

// Modifié depuis l'ouverture ou le dernier enregistrement ?
const modified = d => d.history.length !== (d.savedAt ?? 0);

const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;

// Bandeau d'information : document signé électroniquement, champs de formulaire.
function showInfo() {
  const parts = [];
  if (doc.signed) parts.push(core.keepsOriginal(doc.original, doc.bytes)
    ? "🔏 Ce document est signé électroniquement. Vos commentaires, surlignages et signatures sont ajoutés sans toucher à la signature d'origine."
    : "⚠ Ce document était signé électroniquement : vos modifications rendent cette signature invalide dans la copie enregistrée (le fichier d'origine n'est pas touché).");
  if (doc.fields) parts.push(`Ce document contient ${plural(doc.fields, "champ")} de formulaire : cliquez dedans pour les remplir.`);
  if (doc.protection) parts.push("🔒 Le PDF enregistré sera protégé par " + (doc.protection.password ? "mot de passe." : "des restrictions (impression, copie ou modification).") +
    " Fichier › Protéger pour changer.");
  $("#info").textContent = parts.join(" ");
  $("#info").hidden = !parts.length;
}

// Demande le mot de passe d'un PDF protégé ; renvoie les octets déverrouillés, ou null si l'utilisateur abandonne.
async function askPassword(bytes, name) {
  const dlg = $("#pw-dlg"), input = $("#pw-input");
  let hint = `« ${name}.pdf » est protégé par un mot de passe.`;
  for (;;) {
    $("#pw-hint").textContent = hint; input.value = "";
    const ok = await new Promise(done => { dlg.onclose = () => done(dlg.returnValue === "ok"); dlg.returnValue = ""; dlg.showModal(); input.focus(); });
    if (!ok) return null;
    try { return { bytes: core.unlock(bytes, input.value), password: input.value }; }
    catch { hint = "Mot de passe incorrect, réessayez."; }
  }
}

async function openBytes(bytes, name) {
  if (!ready) return say("Patientez, le lecteur se charge…");
  let protection = null;
  try {
    if (core.needsPassword(bytes)) {
      const r = await askPassword(bytes, name);
      if (!r) return say("Ouverture annulée.");
      bytes = r.bytes; protection = { password: r.password };
    }
  } catch { return say(`Erreur : ${name}.pdf n'est pas un PDF lisible.`, true); }
  // Déjà ouvert (même nom, même contenu) : on affiche simplement son onglet.
  const same = docs.find(d => d.name === name && d.original.length === bytes.length && core.keepsOriginal(d.original, bytes));
  if (same) { activate(same); return say(`${name}.pdf est déjà ouvert.`); }
  await busy("Ouverture…", async () => {
    try { core.pageInfo(bytes); } catch { throw new Error("ce fichier n'est pas un PDF lisible"); }
    remember();
    doc = { name, history: [], future: [], version: 0, original: bytes, signed: core.isSigned(bytes), scroll: 0, protection };
    docs.push(doc);
    current = 0;
    setBytes(bytes);
    doc.fields = core.formFields(doc.mu);
    showDoc();
    if (innerWidth > 900) openSide(doc.outline.length ? "outline" : "thumbs");
  });
  showRecents();
  if (doc) say(`${doc.name} : ${plural(doc.pages.length, "page")}.` + (core.needsOcr(doc.pages)
    ? " Ce PDF semble être une image (scan) : cliquez sur « Reconnaître le texte (OCR) » pour pouvoir le modifier ou le convertir." : ""));
}

// ------------------------------------------------------------ onglets (plusieurs documents)

// Garde la position de lecture du document affiché avant d'en afficher un autre.
function remember() {
  if (doc) Object.assign(doc, { scroll: scrollY, page: current });
}

// Met l'interface aux couleurs du document affiché (titre, bandeau, onglets…).
function showDoc() {
  $("#drop").hidden = true;
  $("#docname").textContent = doc.name + ".pdf";
  setTitle(doc.name + ".pdf – Mim PDF");
  $("#find").value = ""; $("#find-count").textContent = ""; found = null;
  showInfo();
  drawTabs();
}

function activate(d) {
  if (d === doc || document.body.classList.contains("busy")) return;
  remember();
  doc = d;
  current = d.page || 0;
  render(); refreshList(); refreshSide(); showDoc(); setButtons(false);
  scrollTo(0, d.scroll || 0);
  say(`${doc.name} : ${plural(doc.pages.length, "page")}.`);
}

function closeDoc(d = doc) {
  if (!d) return;
  if (modified(d) && !confirm(`Fermer « ${d.name}.pdf » sans enregistrer les modifications ?`)) return;
  const k = docs.indexOf(d);
  docs.splice(k, 1);
  d.mu?.destroy();
  if (d !== doc) return drawTabs();
  doc = null;
  if (docs.length) return activate(docs[Math.min(k, docs.length - 1)]);
  observer.disconnect();
  $$("#pages .page img").forEach(img => img.src && URL.revokeObjectURL(img.src));
  $("#pages").innerHTML = ""; $("#list").hidden = true;
  $("#drop").hidden = false; $("#docname").textContent = ""; $("#count").textContent = "/ 0";
  $("#info").hidden = true; closeSide(); found = null; $("#find").value = ""; $("#find-count").textContent = "";
  setTitle("Mim PDF"); drawTabs(); showRecents();
  setButtons(false); say("Ouvrez un PDF pour commencer.");
}

function drawTabs() {
  const bar = $("#doctabs");
  bar.hidden = docs.length < 2;
  bar.innerHTML = "";
  for (const d of docs) {
    const tab = document.createElement("div");
    tab.className = "doctab" + (d === doc ? " on" : "");
    tab.title = d.name + ".pdf";
    tab.innerHTML = `<span></span><button title="Fermer ce document">✖</button>`;
    tab.querySelector("span").textContent = (modified(d) ? "• " : "") + d.name;
    tab.onclick = () => activate(d);
    tab.querySelector("button").onclick = e => { e.stopPropagation(); closeDoc(d); };
    bar.appendChild(tab);
  }
}

// Ouvre des fichiers choisis ou déposés : chaque PDF dans son onglet ; les images (photos, scans)
// sont réunies dans un nouveau PDF, une page par image.
async function openFiles(files) {
  files = [...files];
  if (!files.length) return;
  const read = await Promise.all(files.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
  const images = read.filter(f => core.imageType(f.bytes)), others = read.filter(f => !core.imageType(f.bytes));
  for (const f of others) {
    if (!/\.pdf$/i.test(f.name) && f.bytes[0] !== 0x25) { say(`« ${f.name} » n'est ni un PDF ni une image PNG ou JPEG.`, true); continue; }
    await openBytes(f.bytes, f.name.replace(/\.pdf$/i, ""));
  }
  if (images.length) await openImages(images.map(f => f.bytes), images[0].name.replace(/\.[^.]+$/, ""));
}
const openFile = file => file && openFiles([file]);

async function openImages(list, name) {
  if (!ready) return say("Patientez, le lecteur se charge…");
  const bytes = await busy("Création du PDF à partir des images…", () => core.imagesToPdf(list));
  if (bytes) await openBytes(bytes, name);
}

// Fichier ouvert depuis Windows : un PDF, ou une image transformée en PDF.
async function openAny(bytes, filename) {
  if (core.imageType(bytes)) return openImages([bytes], filename.replace(/\.[^.]+$/, ""));
  return openBytes(bytes, filename.replace(/\.pdf$/i, ""));
}

// Applique une modification ; `fn` renvoie les nouveaux octets (ou null si rien n'a changé).
async function edit(message, fn, done) {
  await busy(message, async () => {
    const before = doc.bytes;
    const after = await fn(before);
    if (!after) return;
    doc.history.push(before);
    if (doc.history.length > MAX_UNDO) doc.history.shift();
    doc.future = [];
    setBytes(after);
    const broke = doc.signed && core.keepsOriginal(doc.original, before) && !core.keepsOriginal(doc.original, after);
    say((typeof done === "function" ? done() : done) +
        (broke ? " Attention : cette modification rend la signature électronique invalide dans la copie (Ctrl+Z pour annuler)." : ""));
    showInfo(); drawTabs();
  });
}

// ------------------------------------------------------------ affichage

const observer = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) drawPage(e.target);
}, { rootMargin: "800px" });

// Pixels écran par point PDF pour la page `p`, selon le zoom choisi.
function scaleFor(p) {
  const box = $("#pages"), width = (twoPages ? (box.clientWidth - 48) / 2 : box.clientWidth - 30), height = window.innerHeight - box.getBoundingClientRect().top - 40;
  if (zoom === "width") return Math.max(width / p.w, 0.2);
  if (zoom === "page") return Math.max(Math.min(width / p.w, height / p.h), 0.2);
  return zoom * PT;
}

function drawPage(div) {
  const i = +div.dataset.index, img = div.querySelector("img");
  const scale = scaleFor(doc.pages[i]), key = doc.version + ":" + scale.toFixed(3);
  if (img.dataset.key === key) return;
  const res = Math.min(scale * (window.devicePixelRatio || 1), 4);
  const url = URL.createObjectURL(new Blob([core.renderPage(doc.mu, i, res)], { type: "image/png" }));
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = url; img.dataset.key = key;
  div.style.setProperty("--k", scale);
  if (!div.querySelector(".tl")) div.appendChild(textLayer(i));
  if (!div.querySelector(".fl") && doc.fieldList.some(f => f.page === i)) {
    div.appendChild(formLayer(i));
    if (refocus) { const el = div.querySelector(`[data-field="${refocus}"]`); if (el) { refocus = null; el.focus({ preventScroll: true }); } }
  }
}

// ------------------------------------------------------------ formulaires

// Calque des champs : on tape directement dans la page ; la valeur est écrite dans le PDF en quittant le champ.
let refocus = null;
function formLayer(i) {
  const p = doc.pages[i], fl = document.createElement("div");
  fl.className = "fl";
  for (const f of doc.fieldList.filter(f => f.page === i)) {
    const [x0, y0, x1, y1] = f.rect, key = `${f.page}:${f.index}`;
    let el;
    if (f.type === "checkbox" || f.type === "radiobutton") {
      el = document.createElement("button");
      el.type = "button"; el.className = "box";
      el.title = (f.label || f.name) + (f.checked ? " (coché)" : "");
      el.onclick = () => fillField(f, !f.checked, key);
    } else if (f.type === "combobox" || f.type === "listbox") {
      el = document.createElement("select");
      for (const o of ["", ...f.options]) el.add(new Option(o, o, false, o === f.value));
      el.onchange = () => fillField(f, el.value, key);
    } else {
      el = document.createElement(f.multiline ? "textarea" : "input");
      el.value = f.value;
      if (f.maxLen > 0) el.maxLength = f.maxLen;
      el.addEventListener("focusout", e => {
        if (el.value !== f.value) fillField(f, el.value, e.relatedTarget?.dataset?.field);
      });
      el.onkeydown = e => { if (e.key === "Enter" && !f.multiline) { e.preventDefault(); el.blur(); } };
      el.style.fontSize = `calc(var(--k) * ${Math.min(12, (y1 - y0) * 0.7)}px)`;
    }
    el.dataset.field = key;
    if (!el.title) el.title = f.label || f.name;
    Object.assign(el.style, { left: 100 * x0 / p.w + "%", top: 100 * y0 / p.h + "%",
      width: 100 * (x1 - x0) / p.w + "%", height: 100 * (y1 - y0) / p.h + "%" });
    fl.appendChild(el);
  }
  return fl;
}

async function fillField(f, value, next) {
  refocus = next || null;
  await edit("Remplissage…", b => core.setField(b, f.page, f.index, value), `Champ « ${f.label || f.name} » rempli.`);
  // Le champ suivant (touche Tab) reprend le curseur une fois la page redessinée.
  const el = refocus && $(`[data-field="${refocus}"]`);
  if (el) { refocus = null; el.focus({ preventScroll: true }); }
}

// Calque de texte transparent : chaque ligne est placée et étirée exactement sur le texte
// de l'image, si bien que la souris sélectionne et copie le vrai texte (Ctrl+C).
const measure = document.createElement("canvas").getContext("2d");
function textLayer(i) {
  const p = doc.pages[i], tl = document.createElement("div");
  tl.className = "tl";
  for (const l of core.pageText(doc.mu, i)) {
    const span = document.createElement("span"), family = /serif/.test(l.family) && !/sans/.test(l.family) ? "serif" : "sans-serif";
    span.textContent = l.text;
    measure.font = `${l.size}px ${family}`;
    const natural = measure.measureText(l.text).width;
    Object.assign(span.style, { left: 100 * l.x / p.w + "%", top: 100 * l.y / p.h + "%", fontFamily: family,
      fontSize: `calc(var(--k) * ${l.size}px)`, transform: natural > 0 ? `scaleX(${l.w / natural})` : "" });
    tl.appendChild(span);
  }
  return tl;
}

function layout() {
  $$("#pages .page").forEach(div => {
    const p = doc.pages[+div.dataset.index], scale = scaleFor(p);
    div.style.width = Math.round(p.w * scale) + "px";
    div.style.setProperty("--k", scale);
  });
  $$("#pages .page").filter(visible).forEach(drawPage);
}

const visible = div => { const r = div.getBoundingClientRect(); return r.bottom > -800 && r.top < innerHeight + 800; };

function setZoom(value) {
  if (!doc) return;
  const anchor = $$("#pages .page")[current];
  zoom = value;
  $("#zoom").value = String(value);
  if ($("#zoom").value !== String(value)) {   // valeur hors liste : option temporaire
    const o = $("#zoom option.custom") || $("#zoom").appendChild(Object.assign(document.createElement("option"), { className: "custom" }));
    o.value = String(value); o.textContent = Math.round(value * 100) + " %"; $("#zoom").value = o.value;
  }
  layout();
  anchor?.scrollIntoView({ block: "start" });
}

function zoomStep(dir) {
  const now = typeof zoom === "number" ? zoom : scaleFor(doc.pages[current]) / PT;
  const steps = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  setZoom(dir > 0 ? steps.find(z => z > now + 0.01) ?? 4 : [...steps].reverse().find(z => z < now - 0.01) ?? 0.25);
}

function goTo(i) {
  if (!doc) return;
  i = Math.max(0, Math.min(doc.pages.length - 1, i));
  $$("#pages .page")[i]?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function trackCurrent() {
  if (!doc) return;
  const mid = innerHeight / 2;
  let best = 0, dist = Infinity;
  $$("#pages .page").forEach((div, i) => {
    const r = div.getBoundingClientRect(), d = r.top > mid ? r.top - mid : r.bottom < mid ? mid - r.bottom : 0;
    if (d < dist) { dist = d; best = i; }
  });
  if (best !== current) { current = best; markSide(); }
  if (document.activeElement !== $("#goto")) $("#goto").value = current + 1;
}

function render() {
  const box = $("#pages");
  observer.disconnect();
  $$("#pages .page img").forEach(img => img.src && URL.revokeObjectURL(img.src));
  box.innerHTML = "";
  doc.pages.forEach((p, i) => {
    const div = document.createElement("div");
    div.className = "page"; div.dataset.index = i;
    div.style.width = Math.round(p.w * scaleFor(p)) + "px";
    div.style.aspectRatio = `${p.w} / ${p.h}`;
    div.innerHTML = `<img draggable="false" alt="Page ${i + 1}">
      <div class="bar"><button title="Pivoter">⟳</button><button title="Supprimer la page">🗑</button></div>
      <div class="num">${i + 1} / ${doc.pages.length}</div>`;
    const [rot, del] = div.querySelectorAll(".bar button");
    rot.onclick = () => rotate(i, 90);
    del.onclick = () => removePage(i);
    attachTools(div, i, p);
    for (const a of doc.annots.filter(a => a.page === i && a.type === "Text")) {
      const [x0, y0, x1, y1] = a.bounds, hit = document.createElement("div");
      hit.className = "note-hit"; hit.title = a.text;
      Object.assign(hit.style, { left: 100 * x0 / p.w + "%", top: 100 * y0 / p.h + "%",
                                 width: 100 * (x1 - x0) / p.w + "%", height: 100 * (y1 - y0) / p.h + "%" });
      div.appendChild(hit);
    }
    box.appendChild(div);
    observer.observe(div);
  });
  $("#goto").max = doc.pages.length;
  $("#count").textContent = "/ " + doc.pages.length;
  trackCurrent();
  paintHits();
}

// ------------------------------------------------------------ rechercher

let found = null;             // { query, hits: [{ page, rects }], at }
async function find(dir = 1) {
  if (!doc) return;
  const query = $("#find").value.trim();
  if (!query) { found = null; paintHits(); $("#find-count").textContent = ""; return; }
  if (found?.query !== query) {
    found = { query, hits: [], at: -1 };
    for (let i = 0; i < doc.pages.length; i++) {
      for (const rects of core.search(doc.mu, i, query)) found.hits.push({ page: i, rects });
      if (i % 10 === 9) { $("#find-count").textContent = `page ${i + 1}…`; await new Promise(r => setTimeout(r)); }
      if (found?.query !== query) return;       // nouvelle recherche lancée entre-temps
    }
    // On part de la page affichée.
    const first = found.hits.findIndex(h => h.page >= current);
    found.at = (first < 0 ? 0 : first) - (dir > 0 ? 1 : 0);
  }
  const n = found.hits.length;
  if (!n) { $("#find-count").textContent = "0 résultat"; paintHits(); return say(`« ${query} » est introuvable dans ce document.`, true); }
  found.at = ((found.at + dir) % n + n) % n;
  $("#find-count").textContent = `${found.at + 1} / ${n}`;
  paintHits();
  $(".hit.cur")?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function paintHits() {
  $$("#pages .hit").forEach(h => h.remove());
  if (!found) return;
  const pages = $$("#pages .page");
  found.hits.forEach((h, k) => {
    const p = doc.pages[h.page];
    for (const [x0, y0, x1, y1] of h.rects) {
      const d = document.createElement("div");
      d.className = "hit" + (k === found.at ? " cur" : "");
      Object.assign(d.style, { left: 100 * x0 / p.w + "%", top: 100 * y0 / p.h + "%",
                               width: 100 * (x1 - x0) / p.w + "%", height: 100 * (y1 - y0) / p.h + "%" });
      pages[h.page]?.appendChild(d);
    }
  });
}

// ------------------------------------------------------------ panneau : signets et pages en miniature

let sideTab = "outline";
const thumbObserver = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) drawThumb(e.target);
}, { root: $("#thumbs"), rootMargin: "300px" });

function drawThumb(b) {
  const i = +b.dataset.index, img = b.querySelector("img"), key = String(doc.version);
  if (img.dataset.key === key) return;
  const zoom = 120 / doc.pages[i].w * (window.devicePixelRatio || 1);
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(new Blob([core.renderPage(doc.mu, i, zoom)], { type: "image/png" }));
  img.dataset.key = key;
}

function refreshSide() {
  if (!doc || $("#side").hidden) return;
  const out = $("#outline");
  out.innerHTML = "";
  if (!doc.outline.length) out.innerHTML = '<div class="empty">Ce document n\'a pas de signets. Utilisez l\'onglet « Pages ».</div>';
  doc.outline.forEach((o, k) => {
    const b = document.createElement("button");
    b.textContent = o.title; b.style.paddingLeft = 8 + 14 * o.level + "px"; b.dataset.k = k;
    b.title = o.page >= 0 ? `Page ${o.page + 1}` : "";
    b.onclick = () => o.page >= 0 && goTo(o.page);
    out.appendChild(b);
  });
  const thumbs = $("#thumbs");
  thumbObserver.disconnect();
  $$("#thumbs img").forEach(img => img.src && URL.revokeObjectURL(img.src));
  thumbs.innerHTML = "";
  doc.pages.forEach((p, i) => {
    const b = document.createElement("button");
    b.dataset.index = i;
    b.innerHTML = `<img alt="" style="aspect-ratio:${p.w} / ${p.h}"><span>${i + 1}</span>`;
    b.onclick = () => goTo(i);
    dragThumbs(b, i);
    thumbs.appendChild(b);
    thumbObserver.observe(b);
  });
  markSide();
}

// Met en évidence la page affichée dans le panneau.
function markSide() {
  if (!doc || $("#side").hidden) return;
  $$("#thumbs button").forEach((b, i) => b.classList.toggle("cur", i === current));
  if (sideTab === "thumbs") $("#thumbs button.cur")?.scrollIntoView({ block: "nearest" });
  let k = -1;
  doc.outline.forEach((o, j) => { if (o.page >= 0 && o.page <= current) k = j; });
  $$("#outline button").forEach((b, j) => b.classList.toggle("cur", j === k));
}

function openSide(tab = sideTab) {
  sideTab = tab;
  $$("[data-side]").forEach(b => b.classList.toggle("on", b.dataset.side === tab));
  $("#outline").hidden = tab !== "outline";
  $("#thumbs").hidden = tab !== "thumbs";
  const wasHidden = $("#side").hidden;
  $("#side").hidden = false;
  if (wasHidden) { refreshSide(); if (doc && typeof zoom !== "number") layout(); }
  else markSide();
}
function closeSide() {
  $("#side").hidden = true;
  thumbObserver.disconnect();
  if (doc && typeof zoom !== "number") layout();
}

// ------------------------------------------------------------ imprimer

// Chaque page est rendue en haute définition (180 dpi) puis Windows / le navigateur imprime.
async function printDoc() {
  if (!doc) return;
  const box = $("#print");
  const ok = await busy("Préparation de l'impression…", async () => {
    box.innerHTML = "";
    for (let i = 0; i < doc.pages.length; i++) {
      say(`Préparation de l'impression : page ${i + 1} / ${doc.pages.length}…`);
      const img = new Image();
      img.src = URL.createObjectURL(new Blob([core.renderPage(doc.mu, i, 2.5)], { type: "image/png" }));
      box.appendChild(img);
      await img.decode();
    }
    return true;
  });
  if (!ok) return;
  say("Impression lancée.");
  window.print();
  setTimeout(() => { $$("#print img").forEach(img => URL.revokeObjectURL(img.src)); box.innerHTML = ""; }, 1000);
}

const rotate = (i, angle) => edit("Rotation…", b => core.rotatePage(b, i, angle), `Page ${i + 1} pivotée.`);
function removePage(i) {
  if (doc.pages.length === 1) return say("Impossible de supprimer la seule page du document.", true);
  if (confirm(`Supprimer la page ${i + 1} ?`)) edit("Suppression…", b => core.deletePage(b, i), "Page supprimée.");
}

// ------------------------------------------------------------ protection

async function protectDoc() {
  const dlg = $("#protect-dlg"), cur = doc.protection || {};
  $("#pr-pass").value = $("#pr-pass2").value = cur.password || "";
  $("#pr-print").checked = cur.print ?? true; $("#pr-copy").checked = cur.copy ?? true; $("#pr-modify").checked = cur.modify ?? true;
  $("#pr-remove").hidden = !doc.protection;
  for (;;) {
    const choice = await new Promise(done => { dlg.onclose = () => done(dlg.returnValue); dlg.returnValue = ""; dlg.showModal(); $("#pr-pass").focus(); });
    if (choice === "remove") { doc.protection = null; showInfo(); return say("Protection retirée : le PDF sera enregistré sans mot de passe ni restriction."); }
    if (choice !== "ok") return;
    const password = $("#pr-pass").value, opts = { print: $("#pr-print").checked, copy: $("#pr-copy").checked, modify: $("#pr-modify").checked };
    if (password !== $("#pr-pass2").value) { say("Les deux mots de passe sont différents.", true); continue; }
    if (/[,=]/.test(password)) { say("Le mot de passe ne peut pas contenir de virgule ni de signe =.", true); continue; }
    if (!password && opts.print && opts.copy && opts.modify) { say("Indiquez un mot de passe ou décochez au moins une autorisation.", true); continue; }
    doc.protection = { password, ...opts };
    showInfo();
    return say((password ? "Mot de passe défini" : "Restrictions définies") + " : la protection sera appliquée en enregistrant (Ctrl+S). Notez bien ce mot de passe, il ne pourra pas être retrouvé.");
  }
}

// ------------------------------------------------------------ optimiser

const size = n => n < 1e6 ? `${Math.max(1, Math.round(n / 1e3))} Ko` : `${(n / 1e6).toFixed(1).replace(".", ",")} Mo`;

async function compressDoc() {
  const dlg = $("#compress-dlg");
  $("#compress-size").textContent = `Taille actuelle : ${size(doc.bytes.length)}.`;
  const ok = await new Promise(done => { dlg.onclose = () => done(dlg.returnValue === "ok"); dlg.returnValue = ""; dlg.showModal(); });
  if (!ok) return;
  const level = $("#compress-dlg input[name=level]:checked").value, before = doc.bytes.length;
  let images = 0, smaller = true;
  await edit("Compression…", b => {
    const r = core.compress(b, level);
    images = r.images;
    smaller = r.bytes.length < b.length * 0.98;
    return smaller ? r.bytes : null;
  }, () => `Taille : ${size(before)} → ${size(doc.bytes.length)} (−${Math.round(100 * (1 - doc.bytes.length / before))} %` +
           (images ? `, ${plural(images, "image")} allégée${images > 1 ? "s" : ""})` : ")") + ". Enregistrez pour garder cette version.");
  if (!smaller) say(`Ce PDF est déjà optimisé (${size(before)}) : rien à gagner à ce niveau.`);
}

function flattenDoc() {
  if (!doc.annots.length && !doc.fieldList.length) return say("Rien à aplatir : ce document n'a ni commentaire ni champ de formulaire.");
  if (confirm("Aplatir le document ? Commentaires, tampons, signatures image et champs remplis feront partie de la page : ils ne pourront plus être modifiés (Ctrl+Z pour annuler)."))
    edit("Aplatissement…", b => core.flatten(b), "Document aplati : tout est fixé dans les pages.");
}

async function exportImage(format) {
  const data = core.pageImage(doc.mu, current, { dpi: 150, format });
  say(await download(data, `${doc.name}-page${current + 1}.${format === "jpeg" ? "jpg" : "png"}`, `image/${format}`));
}

$("#images-file").onchange = async e => {
  const files = [...e.target.files];
  e.target.value = "";
  const list = await Promise.all(files.map(async f => new Uint8Array(await f.arrayBuffer())));
  if (list.some(b => !core.imageType(b))) return say("Choisissez des images PNG ou JPEG.", true);
  if (list.length) openImages(list, files[0].name.replace(/\.[^.]+$/, ""));
};

// ------------------------------------------------------------ organiser les pages

const blankPage = () => edit("Ajout d'une page…", b => core.insertBlankPage(b, current), () => `Page blanche ajoutée (page ${current + 2}).`);

// Insérer d'autres PDF après la page affichée, ou à la fin (fusion).
let insertAtEnd = false;
function pickInsert(atEnd) {
  insertAtEnd = atEnd;
  $("#insert-file").value = "";
  $("#insert-file").click();
}
$("#insert-file").onchange = async e => {
  const files = [...e.target.files];
  if (!doc || !files.length) return;
  if (files.some(f => !/\.pdf$/i.test(f.name) && f.type !== "application/pdf")) return say("Choisissez des fichiers PDF.", true);
  const list = await Promise.all(files.map(async f => new Uint8Array(await f.arrayBuffer())));
  const after = insertAtEnd ? doc.pages.length - 1 : current;
  let added = 0;
  await edit(insertAtEnd ? "Fusion…" : "Insertion…", async b => {
    for (const other of list.reverse()) {
      try { added += core.pageInfo(other).length; } catch { throw new Error("un des fichiers n'est pas un PDF lisible"); }
      b = await core.insertPdf(b, other, after);
    }
    return b;
  }, () => `${plural(added, "page")} ajoutée${added > 1 ? "s" : ""} ${insertAtEnd ? "à la fin" : `après la page ${after + 1}`}.`);
};

async function extractPages() {
  const text = await askText(`Pages à extraire dans un nouveau PDF (exemple : 1-3, 5 ; ce document en a ${doc.pages.length}) :`, "Extraire");
  if (!text.trim()) return;
  let indices;
  try { indices = core.parseRange(text, doc.pages.length); } catch (e) { return say("Extraction impossible : " + e.message + ".", true); }
  const bytes = await busy("Extraction…", () => core.extractPages(doc.bytes, indices));
  if (bytes) await openBytes(bytes, `${doc.name} (pages ${text.trim().replace(/\s+/g, "")})`);
}

async function numberPages() {
  const dlg = $("#number-dlg");
  $("#num-from").max = doc.pages.length;
  const ok = await new Promise(done => { dlg.onclose = () => done(dlg.returnValue === "ok"); dlg.returnValue = ""; dlg.showModal(); });
  if (!ok) return;
  const from = Math.min(Math.max(+$("#num-from").value || 1, 1), doc.pages.length) - 1;
  const opts = { position: $("#num-pos").value, format: $("#num-format").value, from, first: Math.max(+$("#num-first").value || 0, 0) };
  edit("Numérotation…", b => core.numberPages(b, opts), "Pages numérotées.");
}

async function addWatermark() {
  const text = (await askText("Texte du filigrane (exemple : CONFIDENTIEL, COPIE, BROUILLON) :", "Poser le filigrane")).trim();
  if (text) edit("Filigrane…", b => core.watermark(b, text), `Filigrane « ${text} » posé sur toutes les pages.`);
}

// Glisser-déposer des miniatures pour changer l'ordre des pages.
function dragThumbs(b, i) {
  b.draggable = true;
  b.ondragstart = e => { e.dataTransfer.setData("text/x-mim-page", String(i)); e.dataTransfer.effectAllowed = "move"; b.classList.add("dragging"); };
  b.ondragend = () => { b.classList.remove("dragging"); $$("#thumbs button").forEach(x => x.classList.remove("drop-before", "drop-after")); };
  const after = e => { const r = b.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
  b.ondragover = e => {
    if (!e.dataTransfer.types.includes("text/x-mim-page")) return;
    e.preventDefault();
    b.classList.toggle("drop-after", after(e)); b.classList.toggle("drop-before", !after(e));
  };
  b.ondragleave = () => b.classList.remove("drop-before", "drop-after");
  b.ondrop = e => {
    e.preventDefault(); e.stopPropagation();
    const from = +e.dataTransfer.getData("text/x-mim-page");
    let to = i + (after(e) ? 1 : 0);
    if (from < to) to--;
    b.classList.remove("drop-before", "drop-after");
    if (Number.isNaN(from) || from === to) return;
    edit("Déplacement…", bytes => core.movePage(bytes, from, to), `Page ${from + 1} déplacée en position ${to + 1}.`).then(() => goTo(to));
  };
}

// Coordonnées écran -> points PDF tels qu'affichés.
function toPage(img, p, e) {
  const r = img.getBoundingClientRect();
  return { x: (e.clientX - r.left) * p.w / r.width, y: (e.clientY - r.top) * p.h / r.height };
}

function askText(label = "Texte à écrire :", ok = "Écrire") {
  const dlg = $("#write"), area = $("#write-text");
  area.value = ""; $("#write label").textContent = label; $("#write [value=ok]").textContent = ok;
  return new Promise(done => {
    dlg.onclose = () => done(dlg.returnValue === "ok" ? area.value : "");
    dlg.showModal(); area.focus();
  });
}

// Outils « glisser » (on trace une zone ou un trait) et outils « clic » (on pose quelque chose).
const DRAG = ["erase", "highlight", "underline", "strike", "ink", "rect", "ellipse", "arrow"];
const SVG = "http://www.w3.org/2000/svg";
const drawColor = () => $("#draw-color").value, drawWidth = () => +$("#draw-width").value;
const textSize = () => Math.min(Math.max(+$("#size").value || 12, 4), 96);

function attachTools(div, i, p) {
  const img = div.querySelector("img");
  img.addEventListener("click", e => {
    if (!DRAG.includes(mode) && mode !== "read") place(i, p, toPage(img, p, e));
  });
  let pts = null, svg = null, shape = null;
  img.addEventListener("pointerdown", e => {
    if (!DRAG.includes(mode)) return;
    e.preventDefault(); img.setPointerCapture(e.pointerId);
    const pt = toPage(img, p, e);
    pts = [[pt.x, pt.y]];
    svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "draft"); svg.setAttribute("viewBox", `0 0 ${p.w} ${p.h}`);
    svg.setAttribute("preserveAspectRatio", "none");
    const tag = { ink: "polyline", arrow: "line", ellipse: "ellipse" }[mode] || "rect";
    shape = svg.appendChild(document.createElementNS(SVG, tag));
    const color = mode === "erase" ? "#dc2626" : mode === "highlight" ? $("#hl-color").value : drawColor();
    const marker = ["highlight", "underline", "strike", "erase"].includes(mode);
    shape.setAttribute("fill", marker ? color : "none");
    shape.setAttribute("fill-opacity", ".3");
    shape.setAttribute("stroke", color);
    shape.setAttribute("stroke-width", marker ? 1 : drawWidth());
    if (marker) shape.setAttribute("stroke-dasharray", "4 3");
    shape.setAttribute("stroke-linecap", "round"); shape.setAttribute("stroke-linejoin", "round");
    div.appendChild(svg);
  });
  img.addEventListener("pointermove", e => {
    if (!pts) return;
    const pt = toPage(img, p, e);
    if (mode === "ink") pts.push([pt.x, pt.y]); else pts[1] = [pt.x, pt.y];
    const [a, b = a] = [pts[0], pts[pts.length - 1]];
    const set = (o) => Object.entries(o).forEach(([k, v]) => shape.setAttribute(k, v));
    if (mode === "ink") set({ points: pts.map(q => q.join(",")).join(" ") });
    else if (mode === "arrow") set({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
    else if (mode === "ellipse") set({ cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, rx: Math.abs(b[0] - a[0]) / 2, ry: Math.abs(b[1] - a[1]) / 2 });
    else set({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]) });
  });
  const finish = e => {
    if (!pts) return;
    const all = pts, [a, b = a] = [pts[0], pts[pts.length - 1]];
    pts = null; svg.remove();
    const tiny = Math.abs(a[0] - b[0]) < 3 && Math.abs(a[1] - b[1]) < 3;
    if (e.type === "pointercancel" || (tiny && mode !== "highlight" && mode !== "underline" && mode !== "strike")) return;
    if (mode === "erase")
      return edit("Effacement…", bytes => core.whiteout(bytes, i, a[0], a[1], b[0], b[1]), "Zone effacée.");
    const spec = { kind: mode, color: drawColor(), width: drawWidth() };
    if (["highlight", "underline", "strike"].includes(mode))
      Object.assign(spec, { from: a, to: b, color: mode === "highlight" ? $("#hl-color").value : drawColor() });
    else if (mode === "ink") spec.strokes = [all];
    else if (mode === "arrow") Object.assign(spec, { from: a, to: b });
    else spec.rect = [...a, ...b];
    edit("Ajout…", bytes => core.annotate(bytes, i, spec), "Commentaire ajouté. Retrouvez-le dans Commenter › Liste.");
  };
  img.addEventListener("pointerup", finish);
  img.addEventListener("pointercancel", finish);
}

// Outils « clic » : `pt` = point cliqué, en points PDF tels qu'affichés.
async function place(i, p, pt) {
  const at = [pt.x, pt.y];
  if (mode === "text") {
    const text = await askText();
    if (text.trim()) edit("Écriture…", b => core.addText(b, i, pt.x, pt.y, text, textSize(), $("#color").value), "Texte ajouté.");
  } else if (mode === "note") {
    const text = await askText("Votre note :", "Ajouter");
    if (text.trim()) edit("Ajout…", b => core.annotate(b, i, { kind: "note", at, text }), "Note ajoutée (survolez l'icône pour la lire).");
  } else if (mode === "textbox") {
    const text = await askText("Texte de la zone :", "Ajouter");
    if (text.trim()) edit("Ajout…", b => core.annotate(b, i, { kind: "textbox", at, text, size: textSize(), color: drawColor() }), "Zone de texte ajoutée.");
  } else if (mode === "stamp") {
    edit("Ajout…", b => core.annotate(b, i, { kind: "stamp", at, text: $("#stamp").value, color: drawColor() }), "Tampon ajouté.");
  } else if (mode === "date") {
    const text = new Date().toLocaleDateString("fr-FR");
    edit("Ajout…", b => core.annotate(b, i, { kind: "date", at: [pt.x, pt.y - 7], text, size: 11 }), "Date ajoutée.");
  } else if (mode === "sign" || mode === "initials") {
    const kind = mode === "sign" ? "signature" : "paraphe";
    const sig = signatures[kind] || await editSignature(kind);
    if (!sig) return;
    const w = Math.min(kind === "signature" ? 160 : 60, p.w / 2), h = w * sig.h / sig.w;
    const rect = [pt.x - w / 2, pt.y - h / 2, pt.x + w / 2, pt.y + h / 2];
    edit("Signature…", b => core.annotate(b, i, { kind: "image", rect, png: sig.png, text: kind === "signature" ? "Signature" : "Paraphe" }),
         kind === "signature" ? "Signature posée. Ctrl+Z pour annuler." : "Paraphe posé.");
  }
}

// ------------------------------------------------------------ signature et paraphe

const STORE = { signature: "lecteur-pdf.signature", paraphe: "lecteur-pdf.paraphe" };
const signatures = {};
for (const [kind, key] of Object.entries(STORE)) {
  try { const v = JSON.parse(localStorage.getItem(key)); if (v) signatures[kind] = { ...v, png: dataToBytes(v.data) }; } catch {}
}
function dataToBytes(url) {
  const bin = atob(url.split(",")[1]);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

// Rogne le dessin au plus juste (fond transparent) et renvoie { data, png, w, h }.
function cropCanvas(canvas) {
  const ctx = canvas.getContext("2d"), { width: W, height: H } = canvas;
  const px = ctx.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[(y * W + x) * 4 + 3] > 20) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  const m = 6, w = x1 - x0 + 1 + 2 * m, h = y1 - y0 + 1 + 2 * m;
  const out = Object.assign(document.createElement("canvas"), { width: w, height: h });
  out.getContext("2d").drawImage(canvas, x0 - m, y0 - m, w, h, 0, 0, w, h);
  const data = out.toDataURL("image/png");
  return { data, png: dataToBytes(data), w, h };
}

const INK = "#0b1f6b";
let sigTab = "draw";
function setupSignatureDialog() {
  const draw = $("#sig-canvas"), ctx = draw.getContext("2d");
  let last = null;
  const at = e => { const r = draw.getBoundingClientRect(); return [(e.clientX - r.left) * draw.width / r.width, (e.clientY - r.top) * draw.height / r.height]; };
  draw.onpointerdown = e => { draw.setPointerCapture(e.pointerId); last = at(e); };
  draw.onpointermove = e => {
    if (!last) return;
    const q = at(e);
    Object.assign(ctx, { strokeStyle: INK, lineWidth: 5, lineCap: "round", lineJoin: "round" });
    ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...q); ctx.stroke(); last = q;
  };
  draw.onpointerup = draw.onpointercancel = () => last = null;
  $("#sig-clear").onclick = () => ctx.clearRect(0, 0, draw.width, draw.height);
  const typed = () => {
    const c = $("#sig-preview"), g = c.getContext("2d"), text = $("#sig-text").value.trim();
    g.clearRect(0, 0, c.width, c.height);
    if (!text) return;
    let size = 150;
    do { g.font = `italic ${size}px ${$("#sig-font").value}`; size -= 6; } while (g.measureText(text).width > c.width - 40 && size > 20);
    Object.assign(g, { fillStyle: INK, textBaseline: "middle", textAlign: "center" });
    g.fillText(text, c.width / 2, c.height / 2);
  };
  $("#sig-text").oninput = $("#sig-font").onchange = typed;
  $("#sig-file").onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    const bmp = await createImageBitmap(file), c = $("#sig-image"), g = c.getContext("2d");
    const k = Math.min(c.width / bmp.width, c.height / bmp.height);
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(bmp, (c.width - bmp.width * k) / 2, (c.height - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
    const im = g.getImageData(0, 0, c.width, c.height), d = im.data;   // fond blanc du scan -> transparent
    for (let j = 0; j < d.length; j += 4) if (d[j] > 215 && d[j + 1] > 215 && d[j + 2] > 215) d[j + 3] = 0;
    g.putImageData(im, 0, 0);
  };
  $$("[data-sig]").forEach(b => b.onclick = () => {
    sigTab = b.dataset.sig;
    $$("[data-sig]").forEach(x => x.classList.toggle("on", x === b));
    $$("[data-sigpane]").forEach(x => x.hidden = x.dataset.sigpane !== sigTab);
  });
}
setupSignatureDialog();

function editSignature(kind) {
  const dlg = $("#sign-dlg");
  $("#sign-title").textContent = kind === "signature" ? "Ma signature" : "Mon paraphe (initiales)";
  $("#sig-text").placeholder = kind === "signature" ? "Votre nom" : "Vos initiales";
  ["#sig-canvas", "#sig-preview", "#sig-image"].forEach(c => $(c).getContext("2d").clearRect(0, 0, 900, 300));
  $("#sig-text").value = "";
  return new Promise(done => {
    dlg.onclose = () => {
      if (dlg.returnValue !== "ok") return done(null);
      const sig = cropCanvas($({ draw: "#sig-canvas", type: "#sig-preview", image: "#sig-image" }[sigTab]));
      if (!sig) { say("Signature vide : rien n'a été enregistré.", true); return done(null); }
      signatures[kind] = sig;
      try {
        if ($("#sig-remember").checked) localStorage.setItem(STORE[kind], JSON.stringify({ data: sig.data, w: sig.w, h: sig.h }));
        else localStorage.removeItem(STORE[kind]);
      } catch {}
      say(kind === "signature" ? "Signature enregistrée : cliquez sur la page pour la poser." : "Paraphe enregistré : cliquez sur la page pour le poser.");
      done(sig);
    };
    dlg.showModal();
  });
}

async function initialsEverywhere() {
  const sig = signatures.paraphe || await editSignature("paraphe");
  if (!sig) return;
  edit("Paraphe de toutes les pages…", bytes => {
    doc.pages.forEach((p, i) => {
      const w = Math.min(60, p.w / 4), h = w * sig.h / sig.w;
      bytes = core.annotate(bytes, i, { kind: "image", rect: [p.w - 36 - w, p.h - 30 - h, p.w - 36, p.h - 30], png: sig.png, text: "Paraphe" });
    });
    return bytes;
  }, `Paraphe posé en bas à droite des ${doc.pages.length} page(s).`);
}

// ------------------------------------------------------------ liste des commentaires

const LABELS = { Highlight: "Surlignage", Underline: "Soulignement", StrikeOut: "Texte barré", Text: "Note",
                 FreeText: "Zone de texte", Ink: "Dessin", Square: "Rectangle", Circle: "Ellipse", Line: "Flèche", Stamp: "Image" };
function refreshList() {
  const box = $("#list-items");
  if ($("#list").hidden || !doc) return;
  box.innerHTML = "";
  if (!doc.annots.length) { box.innerHTML = '<div class="empty">Aucun commentaire dans ce document.</div>'; return; }
  for (const a of doc.annots) {
    const label = ["Tampon", "Date", "Signature", "Paraphe"].includes(a.subject) ? a.subject : LABELS[a.type];
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `<div class="what"><span>${label} · page ${a.page + 1}</span><span class="acts"></span></div><div class="txt"></div>`;
    item.querySelector(".txt").textContent = a.text;
    const acts = item.querySelector(".acts");
    if (a.type === "Text" || (a.type === "FreeText" && !a.subject)) {
      const b = acts.appendChild(Object.assign(document.createElement("button"), { textContent: "Modifier", title: "Modifier le texte" }));
      b.onclick = async e => {
        e.stopPropagation();
        const dlg = askText("Nouveau texte :", "Enregistrer");
        $("#write-text").value = a.text;
        const text = await dlg;
        if (text.trim()) edit("Modification…", bytes => core.setAnnotationText(bytes, a.page, a.index, text), "Commentaire modifié.");
      };
    }
    const del = acts.appendChild(Object.assign(document.createElement("button"), { textContent: "🗑", title: "Supprimer" }));
    del.onclick = e => { e.stopPropagation(); edit("Suppression…", bytes => core.deleteAnnotation(bytes, a.page, a.index), `${label} supprimé(e).`); };
    item.onclick = () => goTo(a.page);
    box.appendChild(item);
  }
}
function toggleList(show = $("#list").hidden) {
  $("#list").hidden = !show;
  refreshList();
  if (doc && typeof zoom !== "number") layout();
}

// ------------------------------------------------------------ OCR

async function ocr() {
  await loadScript(LIBS.tesseract);
  let current = 0;
  say("Préparation de la reconnaissance du texte…");
  const worker = await Tesseract.createWorker(["fra", "eng"], 1, {
    workerPath: vendorUrl("worker.min.js"), corePath: vendorUrl("core"), langPath: vendorUrl("lang"),
    logger: m => m.status === "recognizing text" && say(`Reconnaissance du texte : page ${current + 1} / ${doc.pages.length} (${Math.round(m.progress * 100)} %)…`),
  });
  // Mode 3 (mise en page automatique) : lit aussi les tableaux, contrairement au mode par défaut.
  await worker.setParameters({ tessedit_pageseg_mode: "3" });
  const pages = [];
  try {
    for (; current < doc.pages.length; current++) {
      const png = core.renderPage(doc.mu, current, OCR_ZOOM);
      const { data } = await worker.recognize(new Blob([png], { type: "image/png" }));
      pages.push({ index: current, zoom: OCR_ZOOM, words: data.words.filter(w => w.confidence > 20) });
    }
  } finally { await worker.terminate(); }
  if (!pages.some(p => p.words.length)) throw new Error("aucun texte reconnu");
  return core.addOcrLayer(doc.bytes, pages);
}

// ------------------------------------------------------------ enregistrement

// Dans l'application Windows, la fenêtre d'enregistrement de Windows remplace le téléchargement.
async function download(data, name, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const api = window.pywebview?.api;
  if (api?.enregistrer) {
    const b64 = await new Promise(ok => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(",")[1]);
      r.readAsDataURL(blob);
    });
    return (await api.enregistrer(name, b64)).message;
  }
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return "Fichier enregistré dans vos téléchargements.";
}

async function save(fmt) {
  const rows = () => {
    const r = core.extractRows(doc.bytes);
    if (!r.some(p => p.length)) throw new Error("aucun texte dans ce PDF. Si c'est un scan, lancez d'abord la reconnaissance du texte (OCR)");
    return r;
  };
  await busy(fmt === "pdf" ? "Enregistrement…" : "Conversion en cours…", async () => {
    let done;
    if (fmt === "pdf") {
      const kept = !doc.signed || (!doc.protection && core.keepsOriginal(doc.original, doc.bytes));
      if (!kept && !confirm("Ce document était signé électroniquement. La copie enregistrée ne sera plus considérée comme signée " +
                            "(le fichier d'origine reste intact). Enregistrer quand même ?")) return say("Enregistrement annulé.");
      const out = doc.protection ? core.protect(doc.bytes, doc.protection) : doc.bytes;
      done = await download(out, `${doc.name}-modifie.pdf`, "application/pdf");
      if (!/annulé/.test(done)) { doc.savedAt = doc.history.length; drawTabs(); }
      if (doc.signed && kept && done && !/annulé/.test(done)) done += " La signature électronique d'origine reste valable.";
    }
    if (fmt === "txt") done = await download(core.toText(rows()), `${doc.name}.txt`, "text/plain;charset=utf-8");
    if (fmt === "xlsx") {
      await loadScript(LIBS.xlsx);
      done = await download(core.toXlsx(XLSX, rows()), `${doc.name}.xlsx`,
                            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    }
    if (fmt === "docx") {
      await loadScript(LIBS.docx);
      done = await download(await core.toDocx(docx, rows()), `${doc.name}.docx`);
    }
    say(done);
  });
}

// ------------------------------------------------------------ boutons

const HINTS = { read: "Mode lecture.", text: "Cliquez sur la page à l'endroit où écrire.",
                erase: "Tracez un rectangle sur la zone à effacer (son contenu sera réellement supprimé).",
                highlight: "Faites glisser sur le texte à surligner.", underline: "Faites glisser sur le texte à souligner.",
                strike: "Faites glisser sur le texte à barrer.", note: "Cliquez à l'endroit où poser la note.",
                textbox: "Cliquez à l'endroit où ajouter la zone de texte.", ink: "Dessinez à main levée sur la page.",
                rect: "Tracez le rectangle.", ellipse: "Tracez l'ellipse.", arrow: "Tracez la flèche, de son départ vers sa pointe.",
                stamp: "Cliquez à l'endroit où poser le tampon.", date: "Cliquez à l'endroit où écrire la date du jour.",
                sign: "Cliquez à l'endroit où poser votre signature.", initials: "Cliquez à l'endroit où poser votre paraphe." };
function setMode(m) {
  mode = m;
  $$("[data-mode]").forEach(x => x.classList.toggle("on", x.dataset.mode === m));
  document.body.className = "mode-" + mode + (DRAG.includes(m) ? " drawing" : "");
  say(HINTS[mode] + (m === "read" ? "" : " Échap pour revenir à la lecture."));
}
$$("[data-mode]").forEach(b => b.onclick = () => setMode(b.dataset.mode));
$$("[data-tab]").forEach(t => t.onclick = () => {
  $$("[data-tab]").forEach(x => { x.classList.toggle("on", x === t); x.setAttribute("aria-selected", x === t); });
  $$("[data-panel]").forEach(p => p.hidden = p.dataset.panel !== t.dataset.tab);
});
$("#replace").onclick = () => {
  const old = $("#old").value, neu = $("#new").value;
  if (!old) return say("Indiquez le texte à remplacer.", true);
  let count = 0;
  edit("Remplacement…", async b => {
    const r = await core.replaceText(b, old, neu);
    count = r.count;
    if (!count) throw new Error(`« ${old} » introuvable. Si le PDF est un scan, lancez d'abord la reconnaissance du texte (OCR)`);
    return r.bytes;
  }, () => `${count} remplacement(s).`);
};
function undo() {
  if (!doc?.history.length) return;
  doc.future.push(doc.bytes);
  setBytes(doc.history.pop()); setButtons(false); say("Annulé."); showInfo(); drawTabs();
}
function redo() {
  if (!doc?.future.length) return;
  doc.history.push(doc.bytes);
  setBytes(doc.future.pop()); setButtons(false); say("Rétabli."); showInfo(); drawTabs();
}
$("#undo").onclick = undo;
$("#stamp").innerHTML = core.STAMPS.map(t => `<option>${t}</option>`).join("");
$("#toggle-list").onclick = () => toggleList();
$("#close-list").onclick = () => toggleList(false);
$("#edit-sign").onclick = () => editSignature("signature").then(s => s && setMode("sign"));
$("#edit-initials").onclick = () => editSignature("paraphe").then(s => s && setMode("initials"));
$("#initials-all").onclick = initialsEverywhere;
$("#legal-more").onclick = () => $("#legal-dlg").showModal();
$("#redo").onclick = redo;
$("#zoom").onchange = e => setZoom(isNaN(+e.target.value) ? e.target.value : +e.target.value);
$("#zoom-in").onclick = () => zoomStep(1);
$("#zoom-out").onclick = () => zoomStep(-1);
$("#prev").onclick = () => goTo(current - 1);
$("#next").onclick = () => goTo(current + 1);
$("#goto").onchange = e => goTo(+e.target.value - 1);
$("#rotate-left").onclick = () => rotate(current, 270);
$("#rotate-right").onclick = () => rotate(current, 90);
$("#delete-page").onclick = () => removePage(current);
$("#blank-page").onclick = blankPage;
$("#protect").onclick = protectDoc;
$("#compress").onclick = compressDoc;
$("#flatten").onclick = flattenDoc;
$("#export-png").onclick = () => exportImage("png");
$("#export-jpg").onclick = () => exportImage("jpeg");
$("#from-images").onclick = () => $("#images-file").click();
$("#insert-pdf").onclick = () => pickInsert(false);
$("#append-pdf").onclick = () => pickInsert(true);
$("#extract-pages").onclick = extractPages;
$("#number-pages").onclick = numberPages;
$("#watermark").onclick = addWatermark;
$("#close").onclick = () => closeDoc();
$("#two-pages").onclick = () => {
  twoPages = !twoPages;
  $("#two-pages").classList.toggle("on", twoPages);
  $("#pages").classList.toggle("two", twoPages);
  if (doc) setZoom(twoPages && typeof zoom === "number" ? "width" : zoom);
};
$("#fullscreen").onclick = toggleFullscreen;
function toggleFullscreen() {
  const api = window.pywebview?.api;
  if (api?.plein_ecran) return api.plein_ecran();
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.();
}
// Ctrl + molette : zoom (comme dans Nitro, Word, les navigateurs…).
let wheeling = 0;
addEventListener("wheel", e => {
  if (!e.ctrlKey || !doc) return;
  e.preventDefault();
  const now = Date.now();
  if (now - wheeling < 120) return;
  wheeling = now;
  zoomStep(e.deltaY < 0 ? 1 : -1);
}, { passive: false });
// Hauteur du bandeau du haut (onglets, ruban, messages) : les panneaux latéraux se placent dessous.
new ResizeObserver(() => document.body.style.setProperty("--head", $("header").offsetHeight + "px")).observe($("header"));
let scrolling = 0;
addEventListener("scroll", () => { cancelAnimationFrame(scrolling); scrolling = requestAnimationFrame(trackCurrent); });
let resizing = 0;
addEventListener("resize", () => { clearTimeout(resizing); resizing = setTimeout(() => doc && typeof zoom !== "number" && layout(), 150); });
document.addEventListener("keydown", e => {
  const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (ctrl && k === "f") {
    e.preventDefault();
    $('[data-tab="accueil"]').click(); $("#find").focus(); $("#find").select();
    return;
  }
  if (ctrl && k === "p") { e.preventDefault(); printDoc(); return; }
  if (ctrl && k === "w") { e.preventDefault(); closeDoc(); return; }
  if (ctrl && e.key === "Tab" && docs.length > 1) {
    e.preventDefault();
    activate(docs[(docs.indexOf(doc) + (e.shiftKey ? -1 : 1) + docs.length) % docs.length]);
    return;
  }
  if (e.key === "F11") { e.preventDefault(); toggleFullscreen(); return; }
  if (e.key === "F3") { e.preventDefault(); find(e.shiftKey ? -1 : 1); return; }
  if (e.target.matches("input, textarea, select") && e.key !== "Escape") return;
  if (ctrl && k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (ctrl && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
  else if (ctrl && k === "s" && doc) { e.preventDefault(); save("pdf"); }
  else if (ctrl && k === "o") { e.preventDefault(); window.pywebview?.api?.ouvrir ? window.pywebview.api.ouvrir() : $("#file").click(); }
  else if (e.key === "Escape") setMode("read");
});
$("#find").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); find(e.shiftKey ? -1 : 1); } };
$("#find").oninput = () => { if (!$("#find").value.trim()) find(); };
$("#find-next").onclick = () => find(1);
$("#find-prev").onclick = () => find(-1);
$$("[data-print]").forEach(b => b.onclick = printDoc);
$("#side-toggle").onclick = () => $("#side").hidden ? openSide() : closeSide();
$("#side-close").onclick = closeSide;
$$("[data-side]").forEach(b => b.onclick = () => openSide(b.dataset.side));
$("#ocr").onclick = () => edit("Reconnaissance du texte…", ocr,
  "Texte reconnu : le PDF est maintenant sélectionnable et convertible. Vérifiez les chiffres importants.");
$$("[data-dl]").forEach(b => b.onclick = () => save(b.dataset.dl));
$$("label.btn input[type=file]").forEach(i => i.onchange = e => { openFiles(e.target.files); e.target.value = ""; });
$$("[data-sample]").forEach(b => b.onclick = async () => {
  const r = await fetch(`exemples/${b.dataset.sample}.pdf`);
  openBytes(new Uint8Array(await r.arrayBuffer()), b.dataset.sample);
});
const drop = $("#drop");
["dragover", "dragenter"].forEach(t => document.addEventListener(t, e => { e.preventDefault(); drop.classList.add("over"); }));
document.addEventListener("dragleave", () => drop.classList.remove("over"));
document.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); openFiles(e.dataTransfer.files); });

// ------------------------------------------------------------ mise à jour (application Windows)

window.mimMiseAJour = version => {
  $("#maj-version").textContent = version;
  $("#maj").hidden = false;
};
$("#maj-installer").onclick = async () => {
  if (docs.some(modified) && !confirm("Redémarrer sans enregistrer les modifications ?")) return;
  say((await window.pywebview.api.installer_mise_a_jour()).message);
};
async function versionBureau() {
  const etat = await window.pywebview?.api?.mise_a_jour?.();
  if (!etat) return;
  $("#version").textContent = " " + etat.actuelle;
  if (etat.prete) window.mimMiseAJour(etat.prete);
}
if (window.pywebview?.api?.mise_a_jour) versionBureau();
else addEventListener("pywebviewready", versionBureau, { once: true });

// Fichier ouvert depuis Windows (« Ouvrir avec Mim PDF », double-clic sur un PDF) : l'application
// le garde en attente et appelle cette fonction ; on l'ouvre dès que le lecteur est prêt.
let demandeEnCours = false, autreDemande = false;
window.mimFichiersDemandes = async () => {
  if (!ready || !window.pywebview?.api?.fichiers_demandes) return;
  if (demandeEnCours) return void (autreDemande = true);
  demandeEnCours = true;
  try {
    for (const f of await window.pywebview.api.fichiers_demandes()) {   // chacun dans son onglet
      const r = await fetch(f.url);
      if (!r.ok) { say(`Impossible de lire « ${f.nom} ».`, true); continue; }
      await openAny(new Uint8Array(await r.arrayBuffer()), f.nom);
    }
  } catch (e) {
    console.error(e); say("Erreur : " + (e.message || e), true);
  } finally {
    demandeEnCours = false;
    if (autreDemande) { autreDemande = false; window.mimFichiersDemandes(); }
  }
};
addEventListener("pywebviewready", () => { window.mimFichiersDemandes(); showRecents(); }, { once: true });

// Documents récents (application Windows : elle connaît le chemin des fichiers ouverts).
async function showRecents() {
  const api = window.pywebview?.api;
  if (!api?.recents) return;
  const list = await api.recents();
  const box = $("#recents"), sel = $("#recent");
  box.innerHTML = ""; box.hidden = !list.length;
  sel.innerHTML = '<option value="">Documents récents…</option>';
  sel.parentElement.closest(".group").hidden = !list.length;
  if (!list.length) return;
  box.innerHTML = "<strong>Documents récents</strong>";
  for (const r of list) {
    const b = document.createElement("button");
    b.className = "recent"; b.title = r.chemin;
    b.innerHTML = `<span></span><small></small>`;
    b.querySelector("span").textContent = r.nom;
    b.querySelector("small").textContent = r.dossier;
    b.onclick = () => api.ouvrir_recent(r.chemin);
    box.appendChild(b);
    sel.appendChild(Object.assign(document.createElement("option"), { value: r.chemin, textContent: r.nom, title: r.chemin }));
  }
}
$("#recent").onchange = e => { if (e.target.value) window.pywebview.api.ouvrir_recent(e.target.value); e.target.value = ""; };
// Dans l'application Windows, « Ouvrir » passe par la fenêtre de Windows : le chemin du fichier
// est connu, il rejoint les documents récents (plusieurs fichiers possibles, un onglet chacun).
$$("label.btn:has(input[type=file])").forEach(l => l.addEventListener("click", e => {
  const api = window.pywebview?.api;
  if (!api?.ouvrir || e.target.matches("input")) return;
  e.preventDefault();
  api.ouvrir();
}));

// ------------------------------------------------------------ démarrage

document.body.className = "mode-read";
setButtons(false);
try {
  const [mupdf] = await Promise.all([import(LIBS.mupdf), loadScript(LIBS.pdflib)]);
  core.init({ mupdf, PDFLib });
  ready = true;
  say("Ouvrez un PDF pour commencer.");
  window.mimFichiersDemandes();
} catch (e) {
  console.error(e);
  say("Le lecteur n'a pas pu se charger. Vérifiez votre connexion Internet puis rechargez la page.", true);
}
