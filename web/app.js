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
  doc.annots = core.listAnnotations(bytes);
  doc.version++;
  render();
  refreshList();
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
  setBytes(doc.history.pop()); setButtons(false); say("Annulé.");
}
function redo() {
  if (!doc?.future.length) return;
  doc.history.push(doc.bytes);
  setBytes(doc.future.pop()); setButtons(false); say("Rétabli.");
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
$("#close").onclick = () => {
  if (doc.history.length && !confirm("Fermer sans enregistrer les modifications ?")) return;
  observer.disconnect();
  $$("#pages .page img").forEach(img => img.src && URL.revokeObjectURL(img.src));
  $("#pages").innerHTML = ""; doc.mu?.destroy(); doc = null; $("#list").hidden = true;
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
