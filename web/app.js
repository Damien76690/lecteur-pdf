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
const SCALE = 1.5;            // taille d'affichage : pixels écran par point PDF
const OCR_ZOOM = 3.5;         // résolution envoyée à l'OCR (~250 dpi)
const MAX_UNDO = 30;

let ready = false;
let doc = null;               // { name, bytes, pages, history, mu, version }
let mode = "read";

function say(text, err) { const m = $("#msg"); m.textContent = text; m.className = err ? "err" : ""; }
function setButtons(disabled) {
  $$("header button").forEach(b => b.disabled = disabled || !doc);
  $("#undo").disabled = disabled || !doc || !doc.history.length;
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
    doc = { name, history: [], version: 0 };
    setBytes(bytes);
    $("#drop").hidden = true;
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
    setBytes(after);
    say(typeof done === "function" ? done() : done);
  });
}

// ------------------------------------------------------------ affichage

const observer = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) drawPage(e.target);
}, { rootMargin: "800px" });

function drawPage(div) {
  const i = +div.dataset.index, img = div.querySelector("img");
  if (img.dataset.version == doc.version) return;
  const zoom = Math.min(SCALE * (window.devicePixelRatio || 1), 4);
  const url = URL.createObjectURL(new Blob([core.renderPage(doc.mu, i, zoom)], { type: "image/png" }));
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = url; img.dataset.version = doc.version;
}

function render() {
  const box = $("#pages");
  observer.disconnect();
  $$("#pages .page img").forEach(img => img.src && URL.revokeObjectURL(img.src));
  box.innerHTML = "";
  doc.pages.forEach((p, i) => {
    const div = document.createElement("div");
    div.className = "page"; div.dataset.index = i;
    div.style.width = Math.round(p.w * SCALE) + "px";
    div.style.aspectRatio = `${p.w} / ${p.h}`;
    div.innerHTML = `<img draggable="false" alt="Page ${i + 1}">
      <div class="bar"><button title="Pivoter">⟳</button><button title="Supprimer la page">🗑</button></div>
      <div class="num">${i + 1} / ${doc.pages.length}</div>`;
    const [rot, del] = div.querySelectorAll(".bar button");
    rot.onclick = () => edit("Rotation…", b => core.rotatePage(b, i), "Page pivotée.");
    del.onclick = () => {
      if (doc.pages.length === 1) return say("Impossible de supprimer la seule page du document.", true);
      if (confirm(`Supprimer la page ${i + 1} ?`)) edit("Suppression…", b => core.deletePage(b, i), "Page supprimée.");
    };
    attachTools(div, i, p);
    box.appendChild(div);
    observer.observe(div);
  });
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

function download(data, name, type) {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function save(fmt) {
  const rows = () => {
    const r = core.extractRows(doc.bytes);
    if (!r.some(p => p.length)) throw new Error("aucun texte dans ce PDF. Si c'est un scan, lancez d'abord la reconnaissance du texte (OCR)");
    return r;
  };
  await busy(fmt === "pdf" ? "Enregistrement…" : "Conversion en cours…", async () => {
    if (fmt === "pdf") download(doc.bytes, `${doc.name}-modifie.pdf`, "application/pdf");
    if (fmt === "txt") download(core.toText(rows()), `${doc.name}.txt`, "text/plain;charset=utf-8");
    if (fmt === "xlsx") {
      await loadScript(LIBS.xlsx);
      download(core.toXlsx(XLSX, rows()), `${doc.name}.xlsx`,
               "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    }
    if (fmt === "docx") {
      await loadScript(LIBS.docx);
      download(await core.toDocx(docx, rows()), `${doc.name}.docx`);
    }
    say("Fichier enregistré dans vos téléchargements.");
  });
}

// ------------------------------------------------------------ boutons

$$("[data-mode]").forEach(b => b.onclick = () => {
  mode = b.dataset.mode;
  $$("[data-mode]").forEach(x => x.classList.toggle("on", x === b));
  document.body.className = "mode-" + mode;
  say({ read: "Mode lecture.", text: "Cliquez sur la page à l'endroit où écrire.",
        erase: "Tracez un rectangle sur la zone à effacer (son contenu sera réellement supprimé)." }[mode]);
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
$("#undo").onclick = () => {
  if (!doc.history.length) return;
  setBytes(doc.history.pop()); setButtons(false); say("Annulé.");
};
$("#ocr").onclick = () => edit("Reconnaissance du texte…", ocr,
  "Texte reconnu : le PDF est maintenant sélectionnable et convertible. Vérifiez les chiffres importants.");
$$("[data-dl]").forEach(b => b.onclick = () => save(b.dataset.dl));
$("#file").onchange = e => { openFile(e.target.files[0]); e.target.value = ""; };
const sample = (file, name) => async () => {
  const r = await fetch(file);
  openBytes(new Uint8Array(await r.arrayBuffer()), name);
};
$("#sample").onclick = sample("exemples/facture.pdf", "facture");
$("#sample-scan").onclick = sample("exemples/facture-scannee.pdf", "facture-scannee");
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
