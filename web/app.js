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
let doc = null;               // { name, bytes, pages, history, mu, version }
let mode = "read";
let zoom = 1;                 // 1 = 100 % ; ou "width" / "page" (ajusté à la fenêtre)
let current = 0;              // page affichée (la plus visible)

function say(text, err) { const m = $("#msg"); m.textContent = text; m.className = err ? "err" : ""; }
function setButtons(disabled) {
  $$(".ribbon button, .ribbon input, .ribbon select").forEach(b => b.disabled = disabled || !doc);
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
  doc.version++;
  render();
}

async function openBytes(bytes, name) {
  if (!ready) return say("Patientez, le lecteur se charge…");
  await busy("Ouverture…", async () => {
    try { core.pageInfo(bytes); } catch { throw new Error("ce fichier n'est pas un PDF lisible"); }
    doc?.mu?.destroy();
    doc = { name, history: [], future: [], version: 0 };
    current = 0;
    setBytes(bytes);
    $("#drop").hidden = true;
    $("#docname").textContent = name + ".pdf";
  });
  if (doc) say(`${doc.name} : ${doc.pages.length} page(s).` + (core.needsOcr(doc.pages)
    ? " Ce PDF semble être une image (scan) : cliquez sur « Reconnaître le texte (OCR) » pour pouvoir le modifier ou le convertir." : ""));
}

async function openFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return say("Choisissez un fichier PDF.", true);
  await openBytes(new Uint8Array(await file.arrayBuffer()), file.name.replace(/\.pdf$/i, ""));
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
    say(typeof done === "function" ? done() : done);
  });
}

// ------------------------------------------------------------ affichage

const observer = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) drawPage(e.target);
}, { rootMargin: "800px" });

// Pixels écran par point PDF pour la page `p`, selon le zoom choisi.
function scaleFor(p) {
  const box = $("#pages"), width = box.clientWidth - 30, height = window.innerHeight - box.getBoundingClientRect().top - 40;
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
}

function layout() {
  $$("#pages .page").forEach(div => {
    const p = doc.pages[+div.dataset.index];
    div.style.width = Math.round(p.w * scaleFor(p)) + "px";
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
  current = best;
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
    box.appendChild(div);
    observer.observe(div);
  });
  $("#goto").max = doc.pages.length;
  $("#count").textContent = "/ " + doc.pages.length;
  trackCurrent();
}

const rotate = (i, angle) => edit("Rotation…", b => core.rotatePage(b, i, angle), `Page ${i + 1} pivotée.`);
function removePage(i) {
  if (doc.pages.length === 1) return say("Impossible de supprimer la seule page du document.", true);
  if (confirm(`Supprimer la page ${i + 1} ?`)) edit("Suppression…", b => core.deletePage(b, i), "Page supprimée.");
}

// Coordonnées écran -> points PDF tels qu'affichés.
function toPage(img, p, e) {
  const r = img.getBoundingClientRect();
  return { x: (e.clientX - r.left) * p.w / r.width, y: (e.clientY - r.top) * p.h / r.height };
}

function askText() {
  const dlg = $("#write"), area = $("#write-text");
  area.value = "";
  return new Promise(ok => {
    dlg.onclose = () => ok(dlg.returnValue === "ok" ? area.value : "");
    dlg.showModal(); area.focus();
  });
}

function attachTools(div, i, p) {
  const img = div.querySelector("img");
  img.addEventListener("click", async e => {
    if (mode !== "text") return;
    const pt = toPage(img, p, e);
    const text = await askText();
    const size = Math.min(Math.max(+$("#size").value || 12, 4), 96), color = $("#color").value;
    if (text.trim()) edit("Écriture…", b => core.addText(b, i, pt.x, pt.y, text, size, color), "Texte ajouté.");
  });
  let start = null, sel = null;
  img.addEventListener("pointerdown", e => {
    if (mode !== "erase") return;
    e.preventDefault(); img.setPointerCapture(e.pointerId);
    start = { e, pt: toPage(img, p, e) };
    sel = document.createElement("div"); sel.className = "sel"; div.appendChild(sel);
  });
  img.addEventListener("pointermove", e => {
    if (!start) return;
    const r = img.getBoundingClientRect();
    Object.assign(sel.style, {
      left: Math.min(start.e.clientX, e.clientX) - r.left + "px", top: Math.min(start.e.clientY, e.clientY) - r.top + "px",
      width: Math.abs(e.clientX - start.e.clientX) + "px", height: Math.abs(e.clientY - start.e.clientY) + "px" });
  });
  const finish = e => {
    if (!start) return;
    const a = start.pt, b = toPage(img, p, e);
    start = null; sel.remove();
    if (e.type === "pointercancel" || Math.abs(a.x - b.x) < 3 || Math.abs(a.y - b.y) < 3) return;
    edit("Effacement…", bytes => core.whiteout(bytes, i, a.x, a.y, b.x, b.y), "Zone effacée.");
  };
  img.addEventListener("pointerup", finish);
  img.addEventListener("pointercancel", finish);
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
    if (fmt === "pdf") done = await download(doc.bytes, `${doc.name}-modifie.pdf`, "application/pdf");
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
                erase: "Tracez un rectangle sur la zone à effacer (son contenu sera réellement supprimé)." };
function setMode(m) {
  mode = m;
  $$("[data-mode]").forEach(x => x.classList.toggle("on", x.dataset.mode === m));
  document.body.className = "mode-" + mode;
  say(HINTS[mode]);
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
  setBytes(doc.history.pop()); setButtons(false); say("Annulé.");
}
function redo() {
  if (!doc?.future.length) return;
  doc.history.push(doc.bytes);
  setBytes(doc.future.pop()); setButtons(false); say("Rétabli.");
}
$("#undo").onclick = undo;
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
$("#close").onclick = () => {
  if (doc.history.length && !confirm("Fermer sans enregistrer les modifications ?")) return;
  observer.disconnect();
  $$("#pages .page img").forEach(img => img.src && URL.revokeObjectURL(img.src));
  $("#pages").innerHTML = ""; doc.mu?.destroy(); doc = null;
  $("#drop").hidden = false; $("#docname").textContent = ""; $("#count").textContent = "/ 0";
  setButtons(false); say("Ouvrez un PDF pour commencer.");
};
let scrolling = 0;
addEventListener("scroll", () => { cancelAnimationFrame(scrolling); scrolling = requestAnimationFrame(trackCurrent); });
let resizing = 0;
addEventListener("resize", () => { clearTimeout(resizing); resizing = setTimeout(() => doc && typeof zoom !== "number" && layout(), 150); });
document.addEventListener("keydown", e => {
  if (e.target.matches("input, textarea, select") && e.key !== "Escape") return;
  const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (ctrl && k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (ctrl && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
  else if (ctrl && k === "s" && doc) { e.preventDefault(); save("pdf"); }
  else if (ctrl && k === "o") { e.preventDefault(); $("#file").click(); }
  else if (e.key === "Escape") setMode("read");
});
$("#ocr").onclick = () => edit("Reconnaissance du texte…", ocr,
  "Texte reconnu : le PDF est maintenant sélectionnable et convertible. Vérifiez les chiffres importants.");
$$("[data-dl]").forEach(b => b.onclick = () => save(b.dataset.dl));
$$("label.btn input[type=file]").forEach(i => i.onchange = e => { openFile(e.target.files[0]); e.target.value = ""; });
$$("[data-sample]").forEach(b => b.onclick = async () => {
  const r = await fetch(`exemples/${b.dataset.sample}.pdf`);
  openBytes(new Uint8Array(await r.arrayBuffer()), b.dataset.sample);
});
const drop = $("#drop");
["dragover", "dragenter"].forEach(t => document.addEventListener(t, e => { e.preventDefault(); drop.classList.add("over"); }));
document.addEventListener("dragleave", () => drop.classList.remove("over"));
document.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); openFile(e.dataTransfer.files[0]); });

// ------------------------------------------------------------ démarrage

setButtons(false);
try {
  const [mupdf] = await Promise.all([import(LIBS.mupdf), loadScript(LIBS.pdflib)]);
  core.init({ mupdf, PDFLib });
  ready = true;
  say("Ouvrez un PDF pour commencer.");
} catch (e) {
  console.error(e);
  say("Le lecteur n'a pas pu se charger. Vérifiez votre connexion Internet puis rechargez la page.", true);
}
