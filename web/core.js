// Traitements PDF de la version en ligne, exécutés entièrement dans le navigateur :
// le fichier ne quitte jamais l'ordinateur de l'utilisateur.
//   MuPDF (AGPL)  : affichage, lecture du texte, effacement réel (« redaction »),
//                   commentaires (surlignage, notes, dessins, tampons) et signatures.
//   pdf-lib (MIT) : écriture de texte, couche de texte OCR, rotation et suppression de pages.
// Toutes les fonctions prennent les octets du PDF et renvoient de nouveaux octets,
// ce qui permet d'annuler en gardant simplement les versions précédentes.

let mupdf, PDFLib;
export function init(libs) { ({ mupdf, PDFLib } = libs); }

// ------------------------------------------------------------ outils

// Les coordonnées « affichées » (origine en haut à gauche, rotation de la page
// appliquée) sont celles de MuPDF ; pdf-lib travaille dans l'espace PDF d'origine.
const invert = ([a, b, c, d, e, f]) => {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};
const apply = ([a, b, c, d, e, f], x, y) => [a * x + c * y + e, b * x + d * y + f];

function openMu(bytes) {
  return mupdf.Document.openDocument(bytes, "application/pdf");
}

// Un PDF signé électroniquement est enregistré « à la suite » (incrémental) : les octets
// signés restent identiques, la signature d'origine reste donc valable.
function saveMu(doc, bytes) {
  if (bytes && isSigned(bytes)) {
    try { return doc.saveToBuffer("incremental").asUint8Array().slice(); } catch {}
  }
  return doc.saveToBuffer("garbage=compact,compress").asUint8Array().slice();
}

function withMu(bytes, fn) {
  const doc = openMu(bytes);
  try { return fn(doc); } finally { doc.destroy(); }
}

async function withPdfLib(bytes, fn) {
  const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
  const result = await fn(doc);
  return { bytes: await doc.save(), result };
}

function hexToRgb(hex) {
  const h = (hex || "#000000").replace("#", "");
  return PDFLib.rgb(...[0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255));
}

// Helvetica (police standard) couvre les accents, €, œ… ; les autres caractères deviennent « ? ».
function safeText(font, text) {
  let out = "";
  for (const ch of text) {
    try { font.encodeText(ch); out += ch; } catch { out += "?"; }
  }
  return out;
}

// ------------------------------------------------------------ informations / affichage

export function pageInfo(bytes) {
  return withMu(bytes, doc => {
    const pages = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      const [x0, y0, x1, y1] = page.getBounds();
      const text = page.toStructuredText().asText().trim();
      pages.push({ w: x1 - x0, h: y1 - y0, hasText: text.length > 0 });
      page.destroy();
    }
    return pages;
  });
}

export function needsOcr(pages) {
  return pages.length > 0 && pages.every(p => !p.hasText);
}

// Image d'une page préparée pour la reconnaissance du texte (OCR), en PNG : noir et blanc
// (seuil d'Otsu après un léger lissage qui efface les trames grises) et sans les traits
// des tableaux, qui empêchent sinon l'OCR de lire les chiffres des cases.
export function renderForOcr(doc, index, zoom) {
  const page = doc.loadPage(index);
  const pix = page.toPixmap(mupdf.Matrix.scale(zoom, zoom), mupdf.ColorSpace.DeviceGray, false, true);
  page.destroy();
  const w = pix.getWidth(), h = pix.getHeight(), stride = pix.getStride(), px = pix.getPixels();
  // Moyenne 3×3 (image intégrale).
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) { s += px[y * stride + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + s; }
  }
  const g = new Uint8Array(w * h), hist = new Float64Array(256);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.max(0, x - 1), x1 = Math.min(w, x + 2), y0 = Math.max(0, y - 1), y1 = Math.min(h, y + 2);
    const v = (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    g[y * w + x] = v;
    hist[g[y * w + x]]++;
  }
  // Seuil d'Otsu, borné pour les pages presque vides.
  let sum = 0, wB = 0, sB = 0, best = -1, thr = 160;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  for (let t = 0; t < 255; t++) {
    wB += hist[t]; sB += t * hist[t];
    const wF = w * h - wB;
    if (!wB || !wF) continue;
    const v = wB * wF * (sB / wB - (sum - sB) / wF) ** 2;
    if (v > best) { best = v; thr = t + 1; }
  }
  thr = Math.min(Math.max(thr, 100), 200);
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) dark[i] = g[i] < thr ? 1 : 0;
  const out = dark.map(d => d ? 0 : 255);
  // Traits : segments sombres d'au moins 30 pt (horizontaux) ou 22 pt (verticaux), petits trous
  // tolérés ; effacés avec un pixel de bord de chaque côté.
  const gap = Math.round(zoom), minH = Math.round(zoom * 30), minV = Math.round(zoom * 22);
  const runs = (n, len, at) => {
    const res = [];
    let s = -1, last = -1;
    for (let i = 0; i < n; i++) if (at(i)) {
      if (s < 0 || i - last > gap + 1) { if (s >= 0 && last - s + 1 >= len) res.push([s, last]); s = i; }
      last = i;
    }
    if (s >= 0 && last - s + 1 >= len) res.push([s, last]);
    return res;
  };
  for (let y = 0; y < h; y++) for (const [a, b] of runs(w, minH, x => dark[y * w + x]))
    for (let x = a; x <= b; x++) for (let d = -1; d <= 1; d++) if (y + d >= 0 && y + d < h) out[(y + d) * w + x] = 255;
  for (let x = 0; x < w; x++) for (const [a, b] of runs(h, minV, y => dark[y * w + x]))
    for (let y = a; y <= b; y++) for (let d = -1; d <= 1; d++) if (x + d >= 0 && x + d < w) out[y * w + x + d] = 255;
  for (let y = 0; y < h; y++) px.set(out.subarray(y * w, (y + 1) * w), y * stride);
  const png = pix.asPNG().slice();
  pix.destroy();
  return png;
}

// Rendu d'une page en PNG ; `zoom` = pixels par point.
export function renderPage(doc, index, zoom) {
  const page = doc.loadPage(index);
  const pix = page.toPixmap(mupdf.Matrix.scale(zoom, zoom), mupdf.ColorSpace.DeviceRGB, false, true);
  const png = pix.asPNG().slice();
  pix.destroy(); page.destroy();
  return png;
}

export { openMu };

// ------------------------------------------------------------ lecture : signets, recherche, texte

// Signets du PDF à plat : [{ title, page, level }] (page = -1 si le signet ne mène à aucune page).
export function outline(doc) {
  const out = [];
  const walk = (items, level) => {
    for (const it of items || []) {
      let page = it.page ?? -1;
      if (page < 0 && it.uri) try { page = doc.resolveLink(it.uri); } catch {}
      out.push({ title: (it.title || "").replace(/\s+/g, " ").trim() || "(sans titre)", page, level });
      walk(it.down, level + 1);
    }
  };
  try { walk(doc.loadOutline(), 0); } catch {}
  return out;
}

// Occurrences de `needle` sur une page, sans tenir compte des majuscules ni des accents :
// [[x0, y0, x1, y1], …] par occurrence (plusieurs rectangles si elle passe à la ligne).
export function search(doc, index, needle) {
  if (!needle.trim()) return [];
  const page = doc.loadPage(index);
  try {
    return page.search(needle, "ignore-case,ignore-diacritics").map(quads => quads.map(q =>
      [Math.min(q[0], q[4]), Math.min(q[1], q[3]), Math.max(q[2], q[6]), Math.max(q[5], q[7])]));
  } finally { page.destroy(); }
}

// Lignes de texte d'une page avec leur position, pour pouvoir les sélectionner et les copier.
export function pageText(doc, index) {
  const page = doc.loadPage(index);
  try {
    return textLines(page).filter(l => !l.wmode).map(l => ({
      text: l.text, x: l.bbox.x, y: l.bbox.y, w: l.bbox.w, h: l.bbox.h, size: l.font.size, family: l.font.family }));
  } finally { page.destroy(); }
}

// Signature électronique présente (Docusign, certificat…) ?
const latin1 = new TextDecoder("latin1");
export function isSigned(bytes) {
  return /\/ByteRange\s*\[/.test(latin1.decode(bytes));
}

// Vrai si `bytes` commence par les octets de `original` (enregistrement incrémental) :
// dans ce cas une signature d'origine est toujours valable.
export function keepsOriginal(original, bytes) {
  if (bytes.length < original.length) return false;
  for (let i = 0; i < original.length; i++) if (bytes[i] !== original[i]) return false;
  return true;
}

// Nombre de champs de formulaire à remplir (hors champs de signature).
export function formFields(doc) {
  let n = 0;
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    try { if (page.getWidgets) n += page.getWidgets().filter(w => w.getFieldType() !== "signature").length; }
    finally { page.destroy(); }
  }
  return n;
}

// Transformation affichage -> espace PDF et rotation de chaque page.
function geometry(bytes) {
  return withMu(bytes, doc => {
    const out = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      out.push({ toPdf: invert(page.getTransform()) });
      page.destroy();
    }
    return out;
  });
}

// ------------------------------------------------------------ édition

// Écrit `text` sur la page, (x, y) étant le coin haut-gauche tel qu'affiché.
export async function addText(bytes, index, x, y, text, size = 12, color = "#000000") {
  const geo = geometry(bytes)[index];
  return (await withPdfLib(bytes, async doc => {
    const page = doc.getPage(index);
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const rotate = PDFLib.degrees(page.getRotation().angle);
    text.split("\n").forEach((line, i) => {
      const [px, py] = apply(geo.toPdf, x, y + size * (0.85 + i * 1.2));
      page.drawText(safeText(font, line), { x: px, y: py, size, font, color: hexToRgb(color), rotate });
    });
  })).bytes;
}

function redact(page, rects, { text = true, images, lineArt }) {
  for (const r of rects) page.createAnnotation("Redact").setRect(r);
  page.applyRedactions(false,
    images ? mupdf.PDFPage.REDACT_IMAGE_PIXELS : mupdf.PDFPage.REDACT_IMAGE_NONE,
    lineArt ? mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED : mupdf.PDFPage.REDACT_LINE_ART_NONE,
    text ? mupdf.PDFPage.REDACT_TEXT_REMOVE : mupdf.PDFPage.REDACT_TEXT_NONE);
}

// Efface définitivement une zone (texte, images, traits) : elle redevient blanche.
export function whiteout(bytes, index, x0, y0, x1, y1) {
  return withMu(bytes, doc => {
    const page = doc.loadPage(index);
    redact(page, [[Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]],
           { images: true, lineArt: true });
    page.destroy();
    return saveMu(doc, bytes);
  });
}

// Remplace toutes les occurrences de `old` : l'ancien texte est réellement supprimé,
// le nouveau est écrit en Helvetica à la même taille. Renvoie { bytes, count }.
export async function replaceText(bytes, old, neu) {
  const writes = [];
  const cleaned = withMu(bytes, doc => {
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      const hits = page.search(old).filter(h => h.length === 1).map(h => h[0]);
      if (hits.length) {
        const lines = textLines(page);
        const textRects = [], imageRects = [];
        for (const q of hits) {
          const x0 = Math.min(q[0], q[4]), x1 = Math.max(q[2], q[6]);
          const y0 = Math.min(q[1], q[3]), y1 = Math.max(q[5], q[7]);
          const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
          const line = lines.find(l => cx >= l.bbox.x && cx <= l.bbox.x + l.bbox.w &&
                                       cy >= l.bbox.y && cy <= l.bbox.y + l.bbox.h);
          // La hauteur du repère est fiable même pour la couche OCR (texte comprimé).
          const fromQuad = (y1 - y0) / 1.37;
          const size = line && Math.abs(line.font.size - fromQuad) < fromQuad * 0.35 ? line.font.size : fromQuad;
          writes.push({ page: i, x: x0, base: line ? line.y : y1 - size * 0.3, size,
                        bold: !!line && line.font.weight === "bold" });
          // Texte : zone resserrée pour ne pas toucher les lettres voisines ;
          // image (scan) : zone élargie pour ne laisser aucun reste de l'ancien texte.
          const inset = Math.min(size * 0.08, (x1 - x0) / 4), pad = size * 0.15;
          textRects.push([x0 + inset, y0, x1 - inset, y1]);
          imageRects.push([x0 - pad, y0 - pad, x1 + pad, y1 + pad]);
        }
        redact(page, textRects, { images: false, lineArt: false });
        redact(page, imageRects, { text: false, images: true, lineArt: false });
      }
      page.destroy();
    }
    return writes.length ? saveMu(doc, bytes) : bytes;
  });
  if (!writes.length || !neu) return { bytes: cleaned, count: writes.length };
  const geo = geometry(cleaned);
  const out = await withPdfLib(cleaned, async doc => {
    const regular = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    for (const w of writes) {
      const page = doc.getPage(w.page);
      const font = w.bold ? bold : regular;
      const [x, y] = apply(geo[w.page].toPdf, w.x, w.base);
      page.drawText(safeText(font, neu), { x, y, size: w.size, font,
        rotate: PDFLib.degrees(page.getRotation().angle) });
    }
  });
  return { bytes: out.bytes, count: writes.length };
}

// Pivote la page de `angle` degrés dans le sens des aiguilles d'une montre (90, 180 ou 270).
export async function rotatePage(bytes, index, angle = 90) {
  return (await withPdfLib(bytes, doc => {
    const page = doc.getPage(index);
    page.setRotation(PDFLib.degrees((page.getRotation().angle + angle) % 360));
  })).bytes;
}

export async function deletePage(bytes, index) {
  return (await withPdfLib(bytes, doc => doc.removePage(index))).bytes;
}

// ------------------------------------------------------------ formulaires

// Champs à remplir de chaque page : { page, index, name, type, value, options, rect, multiline, maxLen, checked }.
// type : text | checkbox | radiobutton | combobox | listbox (les boutons d'action et les signatures sont ignorés).
export function fields(doc) {
  const out = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    try {
      (page.getWidgets?.() || []).forEach((w, index) => {
        const type = w.getFieldType();
        if (!["text", "checkbox", "radiobutton", "combobox", "listbox"].includes(type) || w.isReadOnly()) return;
        const value = w.getValue();
        out.push({ page: i, index, name: w.getName(), label: w.getLabel(), type, value, rect: w.getRect(),
          options: w.isChoice() ? w.getOptions() : [], multiline: type === "text" && w.isMultiline(), maxLen: type === "text" ? w.getMaxLen() : 0,
          checked: (type === "checkbox" || type === "radiobutton") && isOn(w) });
      });
    } finally { page.destroy(); }
  }
  return out;
}

// Une case est cochée quand l'apparence affichée n'est pas « Off ».
function isOn(w) {
  const as = w.getObject().get("AS");
  return as.isName() && as.asName() !== "Off";
}

// Remplit un champ : texte ou choix d'une liste ; pour une case à cocher ou un bouton radio, `value` (vrai/faux)
// indique s'il doit être coché.
export function setField(bytes, page, index, value) {
  return withMu(bytes, doc => {
    const p = doc.loadPage(page);
    try {
      const w = p.getWidgets()[index];
      if (!w) throw new Error("champ introuvable");
      const type = w.getFieldType();
      if (type === "text") w.setTextValue(String(value));
      else if (type === "combobox" || type === "listbox") w.setChoiceValue(String(value));
      else if (type === "checkbox" || type === "radiobutton") { if (isOn(w) !== !!value) w.toggle(); }
      else throw new Error("ce champ ne se remplit pas");
      w.update();
    } finally { p.destroy(); }
    return saveMu(doc, bytes);
  });
}

// ------------------------------------------------------------ protection par mot de passe

export const needsPassword = bytes => withMu(bytes, doc => doc.needsPassword());

// Ouvre un PDF protégé : renvoie une copie sans mot de passe, ou lève une erreur si le mot de passe est faux.
export function unlock(bytes, password) {
  return withMu(bytes, doc => {
    if (doc.needsPassword() && !doc.authenticatePassword(password)) throw new Error("mot de passe incorrect");
    return doc.saveToBuffer("encrypt=none").asUint8Array().slice();
  });
}

// Protège le PDF (chiffrement AES 256 bits). `password` est demandé à l'ouverture (peut être vide si seules
// des restrictions sont voulues) ; `owner` permet de lever les restrictions (généré s'il manque).
// Les restrictions (imprimer, copier, modifier) sont respectées par les lecteurs PDF conformes.
export function protect(bytes, { password = "", owner = "", print = true, copy = true, modify = true } = {}) {
  for (const p of [password, owner]) if (/[,=]/.test(p)) throw new Error("le mot de passe ne peut pas contenir de virgule ni de signe =");
  if (!owner) owner = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, "0")).join("");
  // Droits PDF : 4 imprimer, 8 modifier, 16 copier, 32 annoter, 1024 assembler, 2048 imprimer en haute qualité.
  let perms = -4;
  if (!print) perms &= ~(4 | 2048);
  if (!modify) perms &= ~(8 | 32 | 1024);
  if (!copy) perms &= ~16;
  return withMu(bytes, doc => doc.saveToBuffer(
    `encrypt=aes-256,user-password=${password},owner-password=${owner},permissions=${perms},garbage=compact,compress`).asUint8Array().slice());
}

// ------------------------------------------------------------ compresser, aplatir, images

// Niveaux de compression : résolution maximale des images (points par pouce) et qualité JPEG.
export const COMPRESSION = {
  ecran: { dpi: 96, quality: 55 },
  standard: { dpi: 150, quality: 72 },
  haute: { dpi: 220, quality: 85 },
};

// Réduit le poids du PDF : les grandes images sont réduites et recompressées en JPEG, puis le fichier est
// réécrit sans les objets inutiles ni doublons. Renvoie { bytes, images } (nombre d'images allégées).
export function compress(bytes, level = "standard") {
  const { dpi, quality } = COMPRESSION[level] || level;
  return withMu(bytes, doc => {
    let side = 0;
    for (let i = 0; i < doc.countPages(); i++) {
      const [x0, y0, x1, y1] = doc.loadPage(i).getBounds();
      side = Math.max(side, x1 - x0, y1 - y0);
    }
    const maxPx = Math.round(side / 72 * dpi);
    let images = 0;
    for (let n = 1; n < doc.countObjects(); n++) {
      const obj = doc.newIndirect(n);   // un flux se lit et s'écrit par sa référence
      if (!obj.isStream() || obj.get("Subtype").asName?.() !== "Image") continue;
      if (obj.get("ImageMask").asBoolean?.() || !obj.get("Mask").isNull() || obj.get("BitsPerComponent").asNumber?.() === 1) continue;
      try { images += shrinkImage(doc, obj, maxPx, quality); } catch (e) { /* image illisible : laissée telle quelle */ }
    }
    try { doc.subsetFonts(); } catch {}
    return { bytes: doc.saveToBuffer("garbage=deduplicate,compress,compress-fonts,compress-images").asUint8Array().slice(), images };
  });
  function shrinkImage(doc, obj, maxPx, quality) {
    const image = doc.loadImage(obj), w = image.getWidth(), h = image.getHeight();
    const old = obj.readRawStream().length;
    const k = Math.min(1, maxPx / Math.max(w, h));
    if (k === 1 && /DCT/.test(String(obj.get("Filter")))) return 0;   // déjà en JPEG à la bonne taille
    let pix = image.toPixmap();
    const gray = pix.getNumberOfComponents() - pix.getAlpha() === 1;
    pix = pix.convertToColorSpace(gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, false);
    const nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k));
    if (k < 1) pix = pix.warp([[0, 0], [w, 0], [w, h], [0, h]], nw, nh);
    const jpeg = pix.asJPEG(quality);
    if (jpeg.length >= old * 0.9) return 0;
    obj.writeRawStream(jpeg);
    obj.put("Filter", doc.newName("DCTDecode"));
    obj.delete("DecodeParms"); obj.delete("Decode"); obj.delete("Intent");
    obj.put("Width", nw); obj.put("Height", nh); obj.put("BitsPerComponent", 8);
    obj.put("ColorSpace", doc.newName(gray ? "DeviceGray" : "DeviceRGB"));
    return 1;
  }
}

// Aplatit le document : commentaires, tampons, signatures image et champs remplis deviennent du contenu
// de la page (ils ne peuvent plus être déplacés ni modifiés).
export function flatten(bytes) {
  return withMu(bytes, doc => { doc.bake(true, true); return saveMu(doc); });
}

// Image de la page (PNG ou JPEG) à `dpi` points par pouce.
export function pageImage(doc, index, { dpi = 150, format = "png" } = {}) {
  const page = doc.loadPage(index);
  try {
    const pix = page.toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, false, true);
    pix.setResolution(dpi, dpi);
    return format === "jpeg" ? pix.asJPEG(90) : pix.asPNG();
  } finally { page.destroy(); }
}

// Type d'image reconnu à ses premiers octets (null si ce n'est ni un PNG ni un JPEG).
export function imageType(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return null;
}

// Crée un PDF à partir d'images (photos, scans) : une page A4 par image, dans le sens de l'image.
export async function imagesToPdf(list) {
  const out = await PDFLib.PDFDocument.create();
  for (const bytes of list) {
    const type = imageType(bytes);
    if (!type) throw new Error("seules les images PNG et JPEG peuvent être converties en PDF");
    const img = type === "png" ? await out.embedPng(bytes) : await out.embedJpg(bytes);
    const [W, H] = img.width > img.height ? [842, 595] : [595, 842];
    const k = Math.min((W - 40) / img.width, (H - 40) / img.height);
    const w = img.width * k, h = img.height * k;
    out.addPage([W, H]).drawImage(img, { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
  }
  return out.save();
}

// ------------------------------------------------------------ signature par certificat

const binary = u8 => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return s; };
const fromBinary = str => Uint8Array.from(str, c => c.charCodeAt(0));
const SIG_SIZE = 16384;   // octets réservés pour la signature (certificats compris)

// Lit un certificat personnel (.p12 / .pfx) : { key, cert, chain, name, email, issuer, from, to }.
export function readCertificate(forge, p12, password) {
  let pkcs;
  try { pkcs = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(binary(p12)), password); }
  catch (e) {
    if (/password|MAC|Invalid|decrypt/i.test(e.message)) throw new Error("mot de passe du certificat incorrect");
    throw new Error("ce fichier n'est pas un certificat .p12 / .pfx lisible");
  }
  const keyBag = [...(pkcs.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
                  ...(pkcs.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [])][0];
  const certs = (pkcs.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []).map(b => b.cert).filter(Boolean);
  if (!keyBag?.key) throw new Error("ce certificat ne contient pas de clé privée (il faut le fichier .p12 / .pfx complet)");
  // Le certificat du signataire est celui dont la clé publique correspond à la clé privée.
  const cert = certs.find(c => c.publicKey.n?.equals?.(keyBag.key.n)) || certs[0];
  if (!cert) throw new Error("aucun certificat dans ce fichier");
  const field = (c, name) => c.subject.getField(name)?.value || "";
  return { key: keyBag.key, cert, chain: certs.filter(c => c !== cert),
    name: field(cert, "CN") || field(cert, "O"), email: field(cert, "E") || "",
    issuer: cert.issuer.getField("CN")?.value || cert.issuer.getField("O")?.value || "",
    from: cert.validity.notBefore, to: cert.validity.notAfter };
}

const pdfDate = d => {
  const p = n => String(n).padStart(2, "0"), off = -d.getTimezoneOffset();
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    (off >= 0 ? "+" : "-") + `${p(Math.floor(Math.abs(off) / 60))}'${p(Math.abs(off) % 60)}'`;
};
const pdfText = t => "(" + t.replace(/[\\()]/g, "\\$&") + ")";
const latin = t => [...t].map(c => c.charCodeAt(0) < 256 ? c : "?").join("")
  .replace(/[\\()]/g, "\\$&").replace(/[\x80-\xff]/g, c => "\\" + c.charCodeAt(0).toString(8));

// Signe le PDF avec un certificat (signature électronique PAdES de base, adbe.pkcs7.detached, SHA-256).
// `rect` : cadre visible [x0, y0, x1, y1] tel qu'affiché sur la page `page`, ou null pour une signature invisible.
// L'enregistrement est incrémental : les signatures déjà présentes restent valables.
export function signPdf(forge, bytes, id, { page = 0, rect = null, reason = "", location = "", date = new Date() } = {}) {
  const placeholder = "1111111111";
  let signedBytes = withMu(bytes, doc => {
    if (doc.canBeSavedIncrementally && !doc.canBeSavedIncrementally()) return null;
    return prepare(doc);
  });
  if (!signedBytes) signedBytes = withMu(withMu(bytes, d => d.saveToBuffer("garbage=compact").asUint8Array().slice()), prepare);
  return finish(signedBytes);

  function prepare(doc) {
    const pageObj = doc.findPage(page), mupage = doc.loadPage(page);
    const toPdf = invert(mupage.getTransform());
    const nSig = doc.countObjects();
    const v = doc.addObject({ Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: "adbe.pkcs7.detached",
      ByteRange: [0, +placeholder, +placeholder, +placeholder], Contents: doc.newByteString(new Uint8Array(SIG_SIZE)),
      M: pdfText(pdfDate(date)), Name: doc.newString(id.name), Reason: doc.newString(reason), Location: doc.newString(location) });
    let box = [0, 0, 0, 0];
    if (rect) {
      const [ax, ay] = apply(toPdf, rect[0], rect[1]), [bx, by] = apply(toPdf, rect[2], rect[3]);
      box = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
    }
    const widget = doc.addObject({ Type: "Annot", Subtype: "Widget", FT: "Sig", F: 132, T: doc.newString(`Signature ${nSig}`),
      Rect: box, V: v, P: pageObj });
    if (rect) widget.put("AP", { N: appearance(doc, box, mupage.getTransform(), id, reason, location, date) });
    mupage.destroy();
    let annots = pageObj.get("Annots");
    if (annots.isNull()) { annots = doc.newArray(); pageObj.put("Annots", annots); }
    annots.push(widget);
    const root = doc.getTrailer().get("Root");
    let form = root.get("AcroForm");
    if (form.isNull()) { form = doc.addObject({ Fields: [] }); root.put("AcroForm", form); }
    let fieldsArr = form.get("Fields");
    if (fieldsArr.isNull()) { fieldsArr = doc.newArray(); form.put("Fields", fieldsArr); }
    fieldsArr.push(widget);
    form.put("SigFlags", 3);
    return doc.saveToBuffer("incremental").asUint8Array().slice();
  }

  // Cadre visible : nom du signataire, date, motif, avec un liseré bleu.
  function appearance(doc, [x0, y0, x1, y1], ctm, id, reason, location, date) {
    const w = x1 - x0, h = y1 - y0;
    // Le contenu suit la rotation de la page pour être lu à l'horizontale.
    const rot = Math.round(Math.atan2(ctm[1], ctm[0]) * 180 / Math.PI + 360) % 360;
    const [bw, bh] = rot % 180 ? [h, w] : [w, h];
    const lines = [[`Signé numériquement par ${id.name}`, 1], [`Date : ${date.toLocaleString("fr-FR")}`, 0],
      ...(reason ? [[`Motif : ${reason}`, 0]] : []), ...(location ? [[`Lieu : ${location}`, 0]] : [])];
    const size = Math.max(4, Math.min(10, bh / (lines.length * 1.3 + 0.6), ...lines.map(([t]) => (bw - 8) / (t.length * 0.5))));
    let ops = `q 0.15 0.39 0.92 RG 1 w 0.5 0.5 ${bw - 1} ${bh - 1} re S `;
    lines.forEach(([t, bold], k) => { ops += `BT /${bold ? "HeB" : "He"} ${size.toFixed(2)} Tf 4 ${(bh - size * (1.15 + k * 1.3)).toFixed(2)} Td (${latin(t)}) Tj ET `; });
    ops += "Q";
    const matrix = { 0: [1, 0, 0, 1, 0, 0], 90: [0, 1, -1, 0, w, 0], 180: [-1, 0, 0, -1, w, h], 270: [0, -1, 1, 0, 0, h] }[rot] || [1, 0, 0, 1, 0, 0];
    const font = name => doc.addSimpleFont(new mupdf.Font(name), "Latin");
    return doc.addStream(ops, { Type: "XObject", Subtype: "Form", BBox: [0, 0, bw, bh], Matrix: rot ? matrix.map((n, i) => i < 4 ? n : 0) : [1, 0, 0, 1, 0, 0],
      Resources: { Font: { He: font("Helvetica"), HeB: font("Helvetica-Bold") } } });
  }

  function finish(out) {
    const str = latin1.decode(out);
    const br = [...str.matchAll(new RegExp(`/ByteRange\\s*\\[\\s*0\\s+${placeholder}\\s+${placeholder}\\s+${placeholder}\\s*\\]`, "g"))].pop();
    const contents = [...str.matchAll(new RegExp(`/Contents\\s*<(0{${SIG_SIZE * 2}})>`, "g"))].pop();
    if (!br || !contents) throw new Error("préparation de la signature impossible pour ce PDF");
    const start = contents.index + contents[0].indexOf("<"), end = start + SIG_SIZE * 2 + 2;
    const range = [0, start, end, out.length - end];
    const text = `/ByteRange [${range.join(" ")}]`;
    if (text.length > br[0].length) throw new Error("préparation de la signature impossible pour ce PDF");
    out.set(new TextEncoder().encode(text.padEnd(br[0].length, " ")), br.index);
    const data = new Uint8Array(range[1] + range[3]);
    data.set(out.subarray(0, range[1]), 0); data.set(out.subarray(range[2]), range[1]);
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(binary(data));
    p7.addCertificate(id.cert);
    id.chain.forEach(c => p7.addCertificate(c));
    p7.addSigner({ key: id.key, certificate: id.cert, digestAlgorithm: forge.pki.oids.sha256,
      authenticatedAttributes: [{ type: forge.pki.oids.contentType, value: forge.pki.oids.data },
        { type: forge.pki.oids.messageDigest }, { type: forge.pki.oids.signingTime, value: date }] });
    p7.sign({ detached: true });
    const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
    if (der.length > SIG_SIZE) throw new Error("certificat trop volumineux pour la place réservée");
    const hex = forge.util.bytesToHex(der).padEnd(SIG_SIZE * 2, "0");
    out.set(new TextEncoder().encode(hex), start + 1);
    return out;
  }
}

// Signatures électroniques du document : signataire, émetteur du certificat, date, motif,
// intact (le contenu signé n'a pas changé : vrai, faux, ou null si le format n'est pas reconnu)
// et covers (la signature couvre tout le fichier : rien n'a été ajouté après elle).
// La chaîne de confiance du certificat n'est pas vérifiée.
export function signatures(forge, bytes) {
  const hashes = { [forge.pki.oids.sha256]: forge.md.sha256, [forge.pki.oids.sha1]: forge.md.sha1,
    [forge.pki.oids.sha384]: forge.md.sha384, [forge.pki.oids.sha512]: forge.md.sha512 };
  return withMu(bytes, doc => {
    const out = [];
    for (let n = 1; n < doc.countObjects(); n++) {
      const obj = doc.newIndirect(n).resolve();
      if (!obj.isDictionary() || !obj.get("ByteRange").isArray() || !obj.get("Contents").isString()) continue;
      const range = [0, 1, 2, 3].map(k => obj.get("ByteRange").get(k).asNumber());
      const sig = { name: str(obj.get("Name")), reason: str(obj.get("Reason")), location: str(obj.get("Location")),
        date: pdfDateToIso(str(obj.get("M"))), covers: range[2] + range[3] === bytes.length, intact: null, issuer: "" };
      try {
        const asn = forge.asn1.fromDer(binary(obj.get("Contents").asByteString()), { strict: false, parseAllBytes: false });
        try {
          const cert = forge.pkcs7.messageFromAsn1(asn).certificates?.[0];
          sig.name ||= cert?.subject.getField("CN")?.value || "";
          sig.issuer = cert?.issuer.getField("CN")?.value || cert?.issuer.getField("O")?.value || "";
        } catch { /* certificat non RSA : nom lu dans le PDF */ }
        const digest = findAttr(forge, asn, forge.pki.oids.messageDigest);
        const md = hashes[findOid(forge, asn, oid => oid in hashes)];
        if (digest && md) {
          const h = md.create();
          h.update(binary(bytes.subarray(range[0], range[0] + range[1])));
          h.update(binary(bytes.subarray(range[2], range[2] + range[3])));
          sig.intact = h.digest().getBytes() === digest.value;
        }
        const t = !sig.date && findAttr(forge, asn, forge.pki.oids.signingTime);
        if (t) sig.date = (t.type === forge.asn1.Type.UTCTIME ? forge.asn1.utcTimeToDate(t.value) : forge.asn1.generalizedTimeToDate(t.value)).toISOString();
      } catch { /* format de signature non reconnu : on affiche ce qu'on sait */ }
      out.push(sig);
    }
    return out;
  });
  function str(o) { try { return o.isString() ? o.asString() : ""; } catch { return ""; } }
}

// « D:20261018143000+02'00' » -> date ISO (ou "" si illisible).
function pdfDateToIso(d) {
  const m = /^D:(\d{4})(\d\d)?(\d\d)?(\d\d)?(\d\d)?(\d\d)?([+\-Z])?(\d\d)?'?(\d\d)?/.exec(d);
  if (!m) return "";
  const [, y, mo = "01", da = "01", h = "00", mi = "00", se = "00", sign, oh = "00", om = "00"] = m;
  const tz = !sign || sign === "Z" ? "Z" : `${sign}${oh}:${om}`;
  const date = new Date(`${y}-${mo}-${da}T${h}:${mi}:${se}${tz}`);
  return isNaN(date) ? "" : date.toISOString();
}

// Premier OID du message qui satisfait `test`, et valeur d'un attribut signé (SEQUENCE { OID, SET { valeur } }).
function findOid(forge, node, test) {
  if (node.type === forge.asn1.Type.OID && node.tagClass === forge.asn1.Class.UNIVERSAL) {
    const oid = forge.asn1.derToOid(node.value);
    return test(oid) ? oid : null;
  }
  if (!Array.isArray(node.value)) return null;
  for (const child of node.value) { const r = findOid(forge, child, test); if (r) return r; }
  return null;
}
function findAttr(forge, node, want) {
  if (!Array.isArray(node.value)) return null;
  const [oid, set] = node.value;
  if (oid?.type === forge.asn1.Type.OID && !Array.isArray(oid.value) && forge.asn1.derToOid(oid.value) === want
      && set?.type === forge.asn1.Type.SET && set.value?.[0]) return set.value[0];
  for (const child of node.value) { const r = findAttr(forge, child, want); if (r) return r; }
  return null;
}

// ------------------------------------------------------------ organiser les pages

// « 1-3, 5, 8-fin » -> [0, 1, 2, 4, 7, …] (pages numérotées à partir de 1, dans l'ordre donné).
export function parseRange(text, count) {
  const out = [];
  for (const part of String(text).split(/[,;]/).map(p => p.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*(?:-\s*(\d+|fin|end))?$/i);
    if (!m) throw new Error(`« ${part} » n'est pas un numéro de page ni un intervalle (exemple : 1-3, 5)`);
    const a = +m[1], b = m[2] ? (/^\d+$/.test(m[2]) ? +m[2] : count) : a;
    if (a < 1 || b < 1 || a > count || b > count) throw new Error(`le document n'a que ${count} page(s)`);
    for (let i = a; a <= b ? i <= b : i >= b; i += a <= b ? 1 : -1) out.push(i - 1);
  }
  if (!out.length) throw new Error("indiquez les pages, par exemple 1-3, 5");
  return out;
}

// Déplace la page `from` pour qu'elle devienne la page `to`.
export async function movePage(bytes, from, to) {
  if (from === to) return bytes;
  const order = [...Array(pageCount(bytes)).keys()];
  order.splice(to, 0, ...order.splice(from, 1));
  return reorder(bytes, order);
}

// Nouveau PDF fait des pages `indices` (dans cet ordre) : extraire, réorganiser.
export async function reorder(bytes, indices) {
  const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
  const out = await PDFLib.PDFDocument.create();
  for (const p of await out.copyPages(src, indices)) out.addPage(p);
  return out.save();
}
export const extractPages = reorder;

// Insère toutes les pages de `other` après la page `after` (-1 : au début ; dernier indice : à la fin).
export async function insertPdf(bytes, other, after) {
  const add = await PDFLib.PDFDocument.load(other, { ignoreEncryption: true });
  return (await withPdfLib(bytes, async doc => {
    const pages = await doc.copyPages(add, add.getPageIndices());
    pages.forEach((p, k) => doc.insertPage(after + 1 + k, p));
  })).bytes;
}

// Fusionne plusieurs PDF, dans l'ordre.
export async function mergePdfs(list) {
  let bytes = list[0];
  for (const other of list.slice(1)) bytes = await insertPdf(bytes, other, pageCount(bytes) - 1);
  return bytes;
}

// Page blanche (du format de la page `after`) insérée après elle.
export async function insertBlankPage(bytes, after) {
  return (await withPdfLib(bytes, doc => {
    const ref = doc.getPage(Math.max(after, 0));
    const { width, height } = ref.getSize();
    const page = doc.insertPage(after + 1, [width, height]);
    page.setRotation(ref.getRotation());
  })).bytes;
}

const pageCount = bytes => withMu(bytes, doc => doc.countPages());

// Texte posé à l'horizontale (tel qu'affiché) de chaque page : numéros, filigrane…
// `place(w, h, textWidth)` renvoie { x, y, angle } en coordonnées affichées (y vers le bas, angle en degrés
// dans le sens inverse des aiguilles d'une montre), ou null pour ne rien écrire sur cette page.
async function stampPages(bytes, textFor, place, { size = 11, color = "#000000", opacity = 1, bold = false } = {}) {
  const geo = geometry(bytes), info = pageInfo(bytes);
  return (await withPdfLib(bytes, async doc => {
    const font = await doc.embedFont(bold ? PDFLib.StandardFonts.HelveticaBold : PDFLib.StandardFonts.Helvetica);
    doc.getPages().forEach((page, i) => {
      const text = safeText(font, textFor(i, info.length));
      if (!text) return;
      const sz = typeof size === "function" ? size(font.widthOfTextAtSize(text, 1), info[i].w, info[i].h) : size;
      const tw = font.widthOfTextAtSize(text, sz);
      const at = place(info[i].w, info[i].h, tw, sz);
      if (!at) return;
      const [x, y] = apply(geo[i].toPdf, at.x, at.y);
      page.drawText(text, { x, y, size: sz, font, color: hexToRgb(color), opacity,
        rotate: PDFLib.degrees(page.getRotation().angle + (at.angle || 0)) });
    });
  })).bytes;
}

// Numérote les pages. position : bas-centre | bas-droite | bas-gauche | haut-centre | haut-droite | haut-gauche ;
// format : « {n} », « Page {n} / {total} »… ; first : numéro de la première page ; from : première page numérotée (indice).
export function numberPages(bytes, { position = "bas-centre", format = "Page {n} / {total}", first = 1, from = 0, size = 10 } = {}) {
  const margin = 24;
  return stampPages(bytes, (i, total) => i < from ? "" : format.replace("{n}", first + i - from).replace("{total}", first + total - 1 - from),
    (w, h, tw) => ({
      x: position.endsWith("gauche") ? margin : position.endsWith("droite") ? w - margin - tw : (w - tw) / 2,
      y: position.startsWith("haut") ? margin + size : h - margin,
    }), { size });
}

// Filigrane en diagonale au centre de chaque page (texte semi-transparent).
// Sans taille imposée, le texte occupe environ 75 % de la diagonale à 45° qui tient dans la page.
export function watermark(bytes, text, { color = "#9ca3af", opacity = 0.3, size } = {}) {
  const s = size || ((unit, w, h) => Math.min(0.75 * Math.SQRT2 * Math.min(w, h) / unit, Math.min(w, h) / 4));
  const c = Math.SQRT1_2;
  return stampPages(bytes, () => text, (w, h, tw, sz) => ({
    // Départ du texte pour que son milieu tombe au centre de la page, en montant à 45°.
    x: w / 2 - c * tw / 2 + c * sz * 0.35, y: h / 2 + c * tw / 2 + c * sz * 0.35, angle: 45,
  }), { size: s, color, opacity, bold: true });
}

// Mots de l'OCR à garder : assez sûrs, et pas ces signes très hauts et étroits que donne
// un texte vertical de la marge (« ACTIF IMMOBILISÉ » couché le long d'un tableau).
export function keepOcrWords(words) {
  // Les « | » et crochets isolés sont des restes de bordures de tableau, les points de suite des pointillés.
  const sure = words.filter(w => w.confidence > 20 && w.text.trim() && !/^([|¦!\[\]]+|[.…_·]+)$/.test(w.text.trim()));
  const heights = sure.filter(w => w.text.trim().length >= 3).map(w => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
  const typical = heights[Math.floor(heights.length / 2)] || Infinity;
  // Texte vertical lu lettre à lettre : une pile de signes courts, les uns collés sous les autres.
  const piled = new Set(), short = sure.filter(w => w.text.trim().length <= 2).sort((a, b) => a.bbox.y0 - b.bbox.y0);
  for (const w of short) {
    if (piled.has(w)) continue;
    const run = [w];
    for (const o of short) {
      const last = run[run.length - 1];
      if (o.bbox.y0 > last.bbox.y0 && Math.abs(o.bbox.x0 - w.bbox.x0) < typical * 0.5
          && o.bbox.y0 - last.bbox.y1 < typical * 0.9) run.push(o);
    }
    if (run.length >= 4) run.forEach(o => piled.add(o));
  }
  // Les lettres de la même pile que l'OCR a mal découpée (un « 2 » isolé en marge) suivent.
  for (let grew = true; grew;) {
    grew = false;
    for (const o of short) if (!piled.has(o) && [...piled].some(p => Math.abs(p.bbox.x0 - o.bbox.x0) < typical * 0.5
        && Math.max(p.bbox.y0 - o.bbox.y1, o.bbox.y0 - p.bbox.y1) < typical * 8)) { piled.add(o); grew = true; }
  }
  // Petit signe lu sur un mot bien plus grand (accent ou trait de lettre d'un titre) : un débris.
  const inside = w => {
    const cx = (w.bbox.x0 + w.bbox.x1) / 2, cy = (w.bbox.y0 + w.bbox.y1) / 2;
    return w.text.trim().length <= 2 && !LINKS.has(w.text.trim()) && sure.some(o => o !== w && o.bbox.y1 - o.bbox.y0 > Math.max(w.bbox.y1 - w.bbox.y0, typical) * 1.6
      && o.bbox.x0 <= cx && cx <= o.bbox.x1 && o.bbox.y0 <= cy && cy <= o.bbox.y1);
  };
  return sure.filter(w => !piled.has(w) && !inside(w) && !(w.text.trim().length <= 3 && w.bbox.y1 - w.bbox.y0 > typical * 1.8))
    // Capitales grasses collées par l'OCR : « TOTALGENERAL », « RESULTATDE L'EXERCICE ».
    .map(w => ({ ...w, text: w.text.replace(/^(TOTAL|RESULTAT)(?=[A-ZÀ-Ý(])/, "$1 ") }));
}

// Montants mal lus à la première lecture (un « 1 » pris pour « | », un chiffre gras avalé,
// un nombre jugé peu sûr) : on repère chaque suite de chiffres d'une ligne pour la relire
// seule, en n'acceptant que des chiffres. `numberZones` donne les rectangles à relire,
// `mergeNumberReads` remet les relectures à la place des mots d'origine.
const digitish = t => {
  const signs = t.replace(/[^\p{L}\p{N}]/gu, ""), digits = (signs.match(/\d/g) || []).length;
  return digits > 0 && signs.length - digits <= Math.min(1, digits - 1);
};
const wellRead = t => /^[-(]?\d{1,3}( \d{3})*([.,]\d+)?\)?%?$|^[-(]?\d+([.,]\d+)?\)?%?$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(t);

export function numberZones(words, size) {
  const items = words.map((w, i) => ({ w, i, t: w.text.trim(), h: w.bbox.y1 - w.bbox.y0, cy: (w.bbox.y0 + w.bbox.y1) / 2 }))
    .filter(x => x.t).sort((a, b) => a.cy - b.cy);
  const lines = [];
  for (const x of items) {
    const line = lines.find(l => Math.abs(l.cy - x.cy) < Math.min(l.h, x.h) * 0.5);
    if (line) line.items.push(x); else lines.push({ cy: x.cy, h: x.h, items: [x] });
  }
  const zones = [];
  for (const line of lines) {
    const row = line.items.sort((a, b) => a.w.bbox.x0 - b.w.bbox.x0);
    let run = [];
    const flush = () => {
      if (run.some(x => digitish(x.t))) zones.push(run);
      run = [];
    };
    row.forEach((x, k) => {
      const next = row[k + 1], prev = run[run.length - 1];
      const near = (a, b) => b.w.bbox.x0 - a.w.bbox.x1 < Math.max(a.h, b.h) * 0.8;
      // Un « | » collé à gauche d'un nombre est presque toujours un « 1 ».
      const bar = /^[|!lI]$/.test(x.t) && next && digitish(next.t) && near(x, next) && x.h > next.h * 0.7;
      if (!(digitish(x.t) || bar)) return flush();
      if (prev && !near(prev, x)) flush();
      run.push(x);
    });
    flush();
  }
  return zones.map(run => {
    const xs = run.map(x => x.w.bbox), h = Math.max(...run.map(x => x.h));
    const x0 = Math.min(...xs.map(b => b.x0)), x1 = Math.max(...xs.map(b => b.x1));
    const y0 = Math.min(...xs.map(b => b.y0)), y1 = Math.max(...xs.map(b => b.y1));
    const left = Math.max(0, Math.floor(x0 - h * 0.4)), top = Math.max(0, Math.floor(y0 - h * 0.3));
    const right = Math.min(size?.width ?? Infinity, Math.ceil(x1 + h * 0.4)), bottom = Math.min(size?.height ?? Infinity, Math.ceil(y1 + h * 0.3));
    return { ids: run.map(x => x.i), bbox: { x0, y0, x1, y1 }, rect: { left, top, width: right - left, height: bottom - top } };
  });
}

export function mergeNumberReads(words, zones, reads) {
  const drop = new Set(), add = new Map();
  zones.forEach((z, k) => {
    // Date des cases d'un formulaire (« 31122025 ») : écrite comme une date.
    const text = (reads[k]?.text || "").trim().replace(/\s+/g, " ")
      .replace(/^(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])((19|20)\d\d)$/, "$1/$2/$3");
    const digits = text.replace(/\D/g, "").length, sure = reads[k]?.confidence ?? 0;
    if (!wellRead(text) || (digits < 3 && sure < 50)) return;
    const kept = z.ids.map(i => words[i].text.trim()).join(" ").replace(/[.,;:]$/, "");
    const was = kept.replace(/\D/g, "").length, parens = t => (t.match(/\(/g) || []).length - (t.match(/\)/g) || []).length;
    // Une relecture qui perd des chiffres d'un nombre déjà bien lu, ou qui en change le nombre
    // sans en être sûre, est écartée ; une relecture identique confirme des mots jugés peu sûrs.
    const date = /\//.test(text) && sure >= 50;
    if (parens(text) || (kept !== text && !date && wellRead(kept) && was !== digits && (sure < 80 || was > digits))) return;
    z.ids.forEach(i => drop.add(i));
    const first = Math.min(...z.ids);
    add.set(first, { ...words[first], text, confidence: Math.max(sure, 21), bbox: z.bbox });
  });
  // Chaque relecture prend la place du premier de ses mots, pour garder l'ordre de lecture.
  return words.flatMap((w, i) => add.has(i) ? [add.get(i)] : drop.has(i) ? [] : [w]);
}

// Libellés mal lus à la première lecture (« TOTAL (Im », « laméthode », « 1aSans ») : chaque
// suite de mots d'une ligne est relue seule, en mode ligne. `textZones` donne les rectangles à
// relire (les suites déjà sûres sont laissées), `mergeTextReads` ne garde une relecture que si
// elle est sûre et proche de l'original : une relecture plus libre invente plus qu'elle ne corrige.
export function textZones(words, size) {
  const items = words.map((w, i) => ({ w, i, t: w.text.trim(), h: w.bbox.y1 - w.bbox.y0, cy: (w.bbox.y0 + w.bbox.y1) / 2 }))
    .filter(x => x.t).sort((a, b) => a.cy - b.cy);
  const lines = [];
  for (const x of items) {
    const line = lines.find(l => Math.abs(l.cy - x.cy) < Math.min(l.h, x.h) * 0.5);
    if (line) line.items.push(x); else lines.push({ cy: x.cy, h: x.h, items: [x] });
  }
  const zones = [];
  for (const line of lines) {
    let run = [];
    const flush = () => {
      // Un trou plus large qu'une espace laisse soupçonner un petit mot perdu (« Charges payer »).
      const gap = run.some((x, k) => k && x.w.bbox.x0 - run[k - 1].w.bbox.x1 > Math.max(x.h, run[k - 1].h) * 0.7);
      if (run.some(x => /\p{L}/u.test(x.t)) && (gap || run.some(x => x.w.confidence < 95))) zones.push(run);
      run = [];
    };
    for (const x of line.items.sort((a, b) => a.w.bbox.x0 - b.w.bbox.x0)) {
      const prev = run[run.length - 1];
      if (digitish(x.t)) { flush(); continue; }
      if (prev && x.w.bbox.x0 - prev.w.bbox.x1 > Math.max(prev.h, x.h) * 1.2) flush();
      run.push(x);
    }
    flush();
  }
  return zones.map(run => {
    const xs = run.map(x => x.w.bbox), h = Math.max(...run.map(x => x.h));
    const x0 = Math.min(...xs.map(b => b.x0)), x1 = Math.max(...xs.map(b => b.x1));
    const y0 = Math.min(...xs.map(b => b.y0)), y1 = Math.max(...xs.map(b => b.y1));
    const left = Math.max(0, Math.floor(x0 - h * 0.3)), top = Math.max(0, Math.floor(y0 - h * 0.25));
    const right = Math.min(size?.width ?? Infinity, Math.ceil(x1 + h * 0.3)), bottom = Math.min(size?.height ?? Infinity, Math.ceil(y1 + h * 0.25));
    return { ids: run.map(x => x.i), bbox: { x0, y0, x1, y1 }, rect: { left, top, width: right - left, height: bottom - top } };
  });
}

// Petits mots qu'une première lecture colle à leur voisin (« laméthode », « expriméen »).
const LINKS = new Set("à a au aux de des du d en et la le les l un une sur par pour plus ou an ans".split(" "));
const distance = (a, b) => {
  let row = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
};

const plain = t => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
// Un mot sûr de la première lecture ne doit pas disparaître : la relecture peut lui changer un
// accent ou une lettre en chiffre (« (ébis) » → « (6bis) »), pas lui ôter ou lui changer une lettre.
const keeps = (t, fresh) => t.length <= 2 || fresh.some(f => plain(f) === plain(t)
  || (f.length === t.length && [...f].filter((c, i) => c !== t[i]).length === 1 && [...f].every((c, i) => c === t[i] || /\d/.test(c))));

export function mergeTextReads(words, zones, reads) {
  const drop = new Set(), add = new Map();
  zones.forEach((z, k) => {
    const read = reads[k] || {}, sure = read.confidence ?? 0;
    const old = z.ids.map(i => words[i]), oldT = old.map(w => w.text.trim()), kept = oldT.join(" ").replace(/\s+/g, " ").trim();
    // Crochets et guillemets isolés ajoutés par la relecture : des bords de case.
    const fresh = (read.words || []).map(w => ({ ...w, text: w.text.trim().replace(/^\{/, "(").replace(/\}$/, ")") }))
      .filter(w => w.text && !(/^([|¦!\[\](){}]+|[.…_·‘’“”"]+)$/.test(w.text) && !oldT.includes(w.text)));
    const text = (read.words ? fresh.map(w => w.text).join(" ") : (read.text || "").trim()).replace(/\s+/g, " ");
    const mean = old.reduce((n, w) => n + w.confidence, 0) / old.length;
    let ok;
    if (!(read.text || "").trim()) ok = sure === 0 && mean < 40; // Tache prise pour du texte : la relecture n'y voit rien.
    else if (!text || text === kept || kept.length <= 3) ok = false; // Codes de cases (« CJ », « 1A ») : trop courts pour trancher.
    else if (text.replace(/ /g, "") === kept.replace(/ /g, "")) {
      // Seules les espaces changent : on sépare un petit mot collé, on recolle un mot coupé en morceaux.
      const a = kept.split(" "), b = text.split(" "), added = b.filter(t => !a.includes(t));
      ok = b.length > a.length ? added.some(t => LINKS.has(t.toLowerCase())) && added.every(t => t.length > 3 || LINKS.has(t.toLowerCase()))
        : a.filter(t => !b.includes(t)).every(t => !LINKS.has(t.toLowerCase()));
    } else {
      const now = text.split(" "), changed = fresh.filter(w => !oldT.includes(w.text));
      const marks = t => (t.normalize("NFD").match(/\p{M}/gu) || []).length;
      ok = sure >= 85 && changed.every(w => w.confidence >= 80) && marks(text) >= marks(kept)
        && old.every(w => w.confidence < 85 || keeps(w.text.trim(), now))
        // Relecture bien plus sûre qu'une première lecture confuse (« tanaupus » → « 1 an au plus »).
        && ((sure >= 90 && sure >= mean + 15)
          || (sure >= mean - 10 && distance(kept, text) <= Math.max(kept.length, text.length) * 0.25));
    }
    if (!ok) return;
    z.ids.forEach(i => drop.add(i));
    // Un mot de la zone rangé sur une autre ligne (« à » un peu plus bas) a été relu avec elle.
    if (text.split(" ").length !== old.length) words.forEach((w, i) => {
      const cx = (w.bbox.x0 + w.bbox.x1) / 2, cy = (w.bbox.y0 + w.bbox.y1) / 2;
      if (!digitish(w.text.trim()) && cx > z.bbox.x0 && cx < z.bbox.x1 && cy > z.bbox.y0 && cy < z.bbox.y1) drop.add(i);
    });
    const first = Math.min(...z.ids);
    // Les cadres des mots relus en mode ligne sont moins justes : on garde ceux de la première lecture.
    const now = text ? text.split(" ") : [];
    add.set(first, now.length === old.length ? old.map((w, i) => ({ ...w, text: now[i], confidence: Math.max(w.confidence, sure, 21) }))
      : now.length ? [{ ...words[first], text, confidence: Math.max(sure, 21), bbox: z.bbox }] : []);
  });
  return words.flatMap((w, i) => add.has(i) ? add.get(i) : drop.has(i) ? [] : [w]);
}

// Ajoute une couche de texte invisible à partir des mots reconnus par l'OCR :
// la page garde son aspect mais devient sélectionnable, modifiable et convertible.
// `pages` = [{ index, zoom, words: [{ text, bbox: {x0,y0,x1,y1}, baseline?: {y0,y1} }] }]
// (coordonnées en pixels de l'image envoyée à l'OCR, rendue avec `zoom`).
export async function addOcrLayer(bytes, pages) {
  const geo = geometry(bytes);
  const op = PDFLib;
  return (await withPdfLib(bytes, async doc => {
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    for (const { index, zoom, words } of pages) {
      const page = doc.getPage(index);
      const rotate = PDFLib.degrees(page.getRotation().angle);
      for (const w of words) {
        const text = safeText(font, w.text.trim());
        if (!text) continue;
        const { x0, y0, x1, y1 } = w.bbox;
        const size = Math.max((y1 - y0) / zoom, 1);
        const base = w.baseline && w.baseline.y0 > y0 ? (w.baseline.y0 + w.baseline.y1) / 2 : y1 - (y1 - y0) * 0.2;
        const natural = font.widthOfTextAtSize(text, size);
        const squeeze = natural > 0 ? Math.min(Math.max(100 * (x1 - x0) / zoom / natural, 10), 1000) : 100;
        const [x, y] = apply(geo[index].toPdf, x0 / zoom, base / zoom);
        page.pushOperators(op.pushGraphicsState(),
          op.setTextRenderingMode(op.TextRenderingMode.Invisible), op.setCharacterSqueeze(squeeze));
        // L'espace qui suit chaque mot garde les mots séparés à la copie et à la conversion.
        page.drawText(text + " ", { x, y, size, font, rotate });
        page.pushOperators(op.popGraphicsState());
      }
    }
  })).bytes;
}

// ------------------------------------------------------------ commentaires et signatures

// Annotations PDF standard (MuPDF) : elles s'affichent dans tous les lecteurs PDF,
// restent modifiables et n'altèrent pas le contenu de la page.
const COMMENT_TYPES = ["Highlight", "Underline", "StrikeOut", "Text", "FreeText", "Ink", "Square", "Circle", "Line", "Stamp"];
export const STAMPS = ["APPROUVÉ", "PAYÉ", "REÇU", "BROUILLON", "CONFIDENTIEL", "COPIE", "REFUSÉ"];

const rgb = hex => [0, 2, 4].map(i => parseInt((hex || "#000000").replace("#", "").slice(i, i + 2), 16) / 255);
const box = ([x0, y0], [x1, y1]) => [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];

// Ajoute une annotation sur la page `index` ; coordonnées en points, telles qu'affichées.
// spec.kind : highlight | underline | strike (texte entre spec.from et spec.to),
//   note (spec.at, spec.text), textbox (spec.rect, spec.text, spec.size), ink (spec.strokes),
//   rect | ellipse (spec.rect), arrow (spec.from, spec.to), stamp (spec.at, spec.text),
//   image (spec.rect, spec.png : signature ou paraphe), date (spec.at, spec.text, spec.size).
export function annotate(bytes, index, spec) {
  return withMu(bytes, doc => {
    const page = doc.loadPage(index);
    try {
      const color = rgb(spec.color), width = spec.width ?? 2;
      let a;
      const make = type => { a = page.createAnnotation(type); a.setCreationDate(new Date()); return a; };
      switch (spec.kind) {
        case "highlight": case "underline": case "strike": {
          const st = page.toStructuredText();
          const quads = st.highlight(spec.from, spec.to, 1000);
          const words = st.copy(spec.from, spec.to).replace(/\s+/g, " ").trim();
          st.destroy();
          if (!quads.length) throw new Error("aucun texte sélectionné à cet endroit. Si le PDF est un scan, lancez d'abord la reconnaissance du texte (OCR)");
          make({ highlight: "Highlight", underline: "Underline", strike: "StrikeOut" }[spec.kind]);
          a.setColor(color); a.setQuadPoints(quads); a.setContents(words);
          break;
        }
        case "note": {
          const [x, y] = spec.at;
          make("Text"); a.setRect([x, y, x + 20, y + 20]); a.setIcon("Comment");
          a.setColor(spec.color ? color : [1, 0.84, 0]); a.setContents(spec.text);
          break;
        }
        case "textbox": case "date": {
          const size = spec.size || 12;
          const lines = spec.text.split("\n");
          const w = Math.max(...lines.map(l => l.length)) * size * 0.55 + 8;
          const [x, y] = spec.rect ? spec.rect : spec.at;
          make("FreeText"); a.setRect(spec.rect ? box(spec.rect.slice(0, 2), spec.rect.slice(2)) : [x, y, x + w, y + lines.length * size * 1.25 + 6]);
          a.setDefaultAppearance("Helv", size, color); a.setContents(spec.text);
          a.setBorderWidth(spec.kind === "date" ? 0 : 1);
          if (spec.kind === "date") a.setSubject("Date");
          break;
        }
        case "stamp": {
          const size = 18, w = spec.text.length * size * 0.72 + 20, h = size * 1.45;
          const [x, y] = spec.at;
          make("FreeText"); a.setRect([x - w / 2, y - h / 2, x + w / 2, y + h / 2]);
          a.setDefaultAppearance("Helv", size, color); a.setContents(spec.text); a.setQuadding(1);
          a.setBorderWidth(2.5); a.setSubject("Tampon");
          break;
        }
        case "ink": {
          make("Ink"); a.setColor(color); a.setBorderWidth(width);
          a.setInkList(spec.strokes.filter(s => s.length > 1));
          break;
        }
        case "rect": case "ellipse": {
          make(spec.kind === "rect" ? "Square" : "Circle"); a.setColor(color); a.setBorderWidth(width);
          a.setRect(box(spec.rect.slice(0, 2), spec.rect.slice(2)));
          break;
        }
        case "arrow": {
          make("Line"); a.setColor(color); a.setBorderWidth(width);
          a.setLine(spec.from, spec.to); a.setLineEndingStyles("None", "OpenArrow");
          break;
        }
        case "image": {
          make("Stamp"); a.setRect(spec.rect); a.setStampImage(new mupdf.Image(spec.png));
          a.setContents(spec.text || "Signature"); a.setSubject(spec.text || "Signature");
          break;
        }
        default: throw new Error("type d'annotation inconnu : " + spec.kind);
      }
      a.update();
      return saveMu(doc, bytes);
    } finally { page.destroy(); }
  });
}

// Liste des commentaires : [{ page, index, type, text, bounds: [x0, y0, x1, y1] }]
// (`index` = rang parmi les annotations de la page, pour modifier ou supprimer).
export function listAnnotations(bytes) {
  return withMu(bytes, doc => {
    const out = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      page.getAnnotations().forEach((a, k) => {
        const type = a.getType();
        if (COMMENT_TYPES.includes(type))
          out.push({ page: i, index: k, type, text: a.getContents() || "", subject: a.hasSubject() ? a.getSubject() : "",
                     bounds: a.getBounds() });
      });
      page.destroy();
    }
    return out;
  });
}

function withAnnotation(bytes, pageIndex, index, fn) {
  return withMu(bytes, doc => {
    const page = doc.loadPage(pageIndex);
    try {
      const a = page.getAnnotations()[index];
      if (!a) throw new Error("commentaire introuvable");
      fn(page, a);
      return saveMu(doc, bytes);
    } finally { page.destroy(); }
  });
}

export const deleteAnnotation = (bytes, page, index) => withAnnotation(bytes, page, index, (p, a) => p.deleteAnnotation(a));

export const setAnnotationText = (bytes, page, index, text) =>
  withAnnotation(bytes, page, index, (p, a) => { a.setContents(text); a.update(); });

// ------------------------------------------------------------ lecture du texte

function textLines(page) {
  const st = page.toStructuredText("preserve-whitespace");
  const json = JSON.parse(st.asJSON());
  st.destroy();
  const lines = [];
  for (const b of json.blocks) for (const l of (b.lines || [])) if (l.text.trim()) lines.push(l);
  return lines;
}

// Morceaux de texte de la page : une ligne horizontale est coupée là où l'écart entre deux
// caractères dépasse ~0,6 fois la taille du texte (case de tableau voisine, mot isolé…).
// Une ligne inclinée ou verticale reste d'un seul tenant.
// Deux montants de colonnes voisines écrits à une seule espace l'un de l'autre (« -39 979 -113 »,
// fréquent avec une police à chasse fixe), ou un montant suivi du code de la case voisine d'une
// liasse fiscale (« 0 KH ») : deux morceaux, chacun à sa place. De même pour un code posé au bout
// d'un libellé, un peu plus loin que l'espace entre deux mots (« dont composants L9 »).
const AMOUNT = "[-(]?\\d{1,3}(?:[ \\u00a0\\u202f]\\d{3})*(?:[.,]\\d+)?\\)?";
const CODE = "(?=[A-Z0-9Ø]{2}\\s*$)[0-9]?[A-ZØ][A-Z0-9Ø]?";
function splitAt(chunk, at) {
  const left = chunk.chars.filter(c => c.at < at), right = chunk.chars.filter(c => c.at >= at);
  const x = right[0].x0, end = left[left.length - 1].x1;
  return [{ ...chunk, text: chunk.text.slice(0, at).trimEnd(), bbox: { ...chunk.bbox, w: end - chunk.x }, chars: left },
    { ...chunk, x, text: chunk.text.slice(at), bbox: { ...chunk.bbox, x, w: chunk.x + chunk.bbox.w - x },
      chars: right.map(c => ({ ...c, at: c.at - at })), cut: true }];
}
function splitAmounts(chunk) {
  if (!chunk.chars) return [chunk];
  const amount = chunk.text.match(new RegExp(`^\\s*${AMOUNT} +(?=-${AMOUNT}\\s*$|${CODE})`));
  const m = amount || chunk.text.match(new RegExp(`^.*\\p{L}.*? +(?=${CODE})`, "u"));
  if (!m) return [chunk];
  const at = m[0].length, i = chunk.chars.findIndex(c => c.at >= at);
  if (i < 1 || (!amount && chunk.chars[i].x0 - chunk.chars[i - 1].x1 < chunk.size * 0.45)) return [chunk];
  return splitAt(chunk, at);
}

function textChunks(page) {
  const st = page.toStructuredText("preserve-whitespace");
  const chunks = [];
  let cur = null, last = null, flat = true, spaces = [];
  const close = () => {
    if (cur && cur.text.trim()) chunks.push(...splitAmounts(cur));
    cur = null; last = null;
  };
  st.walk({
    beginLine(bbox, wmode, dir) { close(); flat = Math.abs(dir[1]) < 0.5; },
    onChar(c, origin, font, size, quad) {
      // Texte minuscule et invisible (repères de mise en page d'un logiciel comptable) : ignoré.
      if (size < 1.2) return;
      const x0 = Math.min(quad[0], quad[4]), x1 = Math.max(quad[2], quad[6]);
      const y0 = Math.min(quad[1], quad[3]), y1 = Math.max(quad[5], quad[7]);
      if (!c.trim()) { if (cur) { cur.text += c; spaces.push(x1 - x0); } return; }
      // (Une seule espace, aussi large soit-elle — police à chasse fixe —, sépare deux mots, pas deux cases.)
      const gap = flat && cur && last !== null ? x0 - last : 0;
      if (gap > Math.max(cur?.size ?? 0, size) * 0.6 && !(spaces.length === 1 && gap < spaces[0] * 1.2)) close();
      spaces = [];
      if (!cur) cur = { x: x0, y: origin[1], text: "", size, bold: font.isBold(), bbox: { x: x0, y: y0, w: 0, h: 0 }, top: y0, bottom: y1, chars: [] };
      cur.chars.push({ at: cur.text.length, x0, x1 });
      cur.text += c;
      cur.size = Math.max(cur.size, size);
      cur.top = Math.min(cur.top, y0); cur.bottom = Math.max(cur.bottom, y1);
      if (flat) cur.bbox.w = Math.max(cur.bbox.w, x1 - cur.x);
      last = x1;
    },
    endLine: close,
  });
  close();
  st.destroy();
  return chunks;
}

// Regroupe le texte de chaque page en lignes visuelles composées de cellules
// (un tableau donne une cellule par case), avec des colonnes alignées.
// Renvoie [[{ cells: [{ col, text, size, bold }] }]] (une liste de lignes par page).
// Avec `area` = { page, rect: [x0, y0, x1, y1] } (points tels qu'affichés), seul le texte
// de cette zone est lu : un tableau encadré à la souris, exporté seul.
export function extractRows(bytes, area) {
  return withMu(bytes, doc => {
    const pages = [];
    for (let i = 0; i < doc.countPages(); i++) {
      if (area && i !== area.page) continue;
      const page = doc.loadPage(i);
      let chunks = textChunks(page);
      if (area) {
        const [x0, y0, x1, y1] = box([area.rect[0], area.rect[1]], [area.rect[2], area.rect[3]]);
        chunks = chunks.filter(c => {
          const cx = c.x + c.bbox.w / 2, cy = (c.top + c.bottom) / 2;
          return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
        });
      }
      pages.push(layoutRows(chunks));
      page.destroy();
    }
    return pages;
  });
}

// Débris : ni chiffre, ni mot de plus de deux lettres, hors codes en capitales comme « AB »
// (restes de traits, de trames ou de textes verticaux de la marge lus par l'OCR).
const isDebris = t => {
  const letters = (t.match(/\p{L}/gu) || []).length;
  return !/\p{N}/u.test(t) && !LINKS.has(t) && !/^\(?[€%$£]\)?$/.test(t) && !/^\([A-Z]\)$/.test(t) && (letters < 2 || (letters === 2 && t.length <= 3 && !/^[A-ZØ]{2}$/.test(t.replace(/[^\p{L}\d]/gu, ""))));
};
const isAmount = t => typeof toNumber(t) === "number";
// « 250 » suivi de « 190 » : un même montant écrit avec une espace entre les milliers.
const continuesAmount = (a, b) => /^[-+(]?\d{1,3}( \d{3})*$/.test(a) && /^\d{3}([.,]\d+)?\)?$/.test(b);

// Confusions de l'OCR propres aux liasses fiscales et annexes : chiffres romains des totaux
// (« TOTAL (Im » pour « TOTAL (II) »), durées (« plus de Sans » pour « plus de 5 ans »).
export function fixOcrLabel(t) {
  return t
    .replace(/\((?:[1lI] ?[aà]|l[aà]) ([IVX]+)(D?)\)/g, (m, r, d) => `(I à ${r}${d && "I"})`)
    .replace(/\b(TOTAL \()([IVX]*)(?:D|m)(?=\s|$)/g, "$1$2I)")
    .replace(/\b(TOTAL \()([IVX]+)p(?=\s|$)/g, "$1$2)")
    .replace(/\bTOTAL \(\)/g, "TOTAL (I)")
    .replace(/(^|\s)[aà] ?[l1] ?an ?au ?plus\b/g, "$1à 1 an au plus")
    .replace(/\b1 ?[aà] ?[S5] ?ans\b/g, "1 à 5 ans")
    .replace(/\bentre ?[l1] ?et ?[S5] ?ans\b/g, "entre 1 et 5 ans")
    .replace(/(^|\s)[aà] ?plus ?de ?[S5] ?ans\b/g, "$1à plus de 5 ans")
    .replace(/\bplus ?de ?[S5] ?ans\b/g, "plus de 5 ans")
    .replace(/\bR[éèe]a[lt]ement\b/g, "Règlement")
    .replace(/^\([ée]?(bis|ter)\)$/, "(6$1)")
    .replace(/\(article [s5]3 ?[aA]\b/, "(article 53 A")
    .replace(/\(([IVX]+) ([A-Z]{2})$/, "($1) $2")
    // Lettres que l'OCR confond (« rn » / « m », « ti » / « b ») dans les mots des notices.
    .replace(/\bconcemant\b/g, "concernant").replace(/\b(?:nonce|nobce|nobice) n°/g, "notice n°")
    .replace(/\bexplicat[bo]ns\b/g, "explications").replace(/\bcelte\b/g, "cette").replace(/\bCodc\b/g, "Code")
    .replace(/\baffrentes\b/g, "afférentes").replace(/\bficultatives\b/g, "facultatives");
}

function layoutRows(lines) {
  const items = lines.map(l => ({ x: l.x, end: l.bbox.x + l.bbox.w, y: l.y, text: l.text.trim(), size: l.size, bold: l.bold, cut: l.cut }))
    .filter(c => !isDebris(c.text));
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  // Lignes : d'abord les textes posés sur la même ligne de base, puis les lignes à peine décalées
  // se rejoignent, les plus proches d'abord (« corporelles », fin d'un libellé sur deux lignes, ne
  // prend pas les montants de la ligne d'en dessous, posés sur la même base que leur libellé).
  let rows = [];
  for (const cell of items) {
    const row = rows.filter(r => Math.abs(r.y - cell.y) < Math.max(r.size, cell.size) * 0.15)
      .sort((a, b) => Math.abs(a.y - cell.y) - Math.abs(b.y - cell.y))[0];
    if (row) row.cells.push(cell); else rows.push({ y: cell.y, size: cell.size, cells: [cell] });
  }
  rows.sort((a, b) => a.y - b.y);
  for (;;) {
    const gaps = rows.slice(1).map((r, i) => ({ i, d: r.y - rows[i].y }))
      .filter(({ i, d }) => d < Math.min(rows[i].size, rows[i + 1].size) * 0.5).sort((a, b) => a.d - b.d);
    if (!gaps.length) break;
    const [a, b] = rows.splice(gaps[0].i, 2);
    rows.splice(gaps[0].i, 0, { ...a, cells: [...a.cells, ...b.cells] });
  }
  for (const r of rows) {
    r.cells.sort((a, b) => a.x - b.x);
    // Morceaux trop proches, ou suite d'un montant : même cellule.
    r.cells = r.cells.reduce((acc, c) => {
      const prev = acc[acc.length - 1];
      const gap = prev ? c.x - prev.end : Infinity, size = prev ? Math.max(prev.size, c.size) : 0;
      if (prev && !c.cut && (gap < size * 0.6 || (gap < size * 1.2 && continuesAmount(prev.text, c.text)))) {
        // Un écart négatif est un texte posé au-dessus (titre de colonne sur deux lignes) : on garde l'espace.
        prev.text = prev.text + (gap > size * 0.1 || gap < -size * 0.3 ? " " : "") + c.text; prev.end = Math.max(prev.end, c.end);
      } else acc.push(c);
      return acc;
    }, []);
  }
  // Titres de colonnes sur plusieurs lignes (« Valeur brute à » / « l'ouverture de » / « l'exercice (A) »,
  // « Variation » / « (€) ») : les morceaux posés juste au-dessus ou au-dessous de la ligne de titres,
  // hors de la colonne des libellés, la rejoignent.
  const textOnly = r => r.cells.every(c => !isAmount(c.text) || /^(19|20)\d\d$/.test(c.text));
  const words = r => r.cells.every(c => /\p{L}.*\p{L}|^(19|20)\d\d$|[€%]/u.test(c.text));
  const small = r => Math.min(...r.cells.map(c => c.size));
  for (let i = 0; i < rows.length; i++) {
    const main = rows[i];
    if (main.cells.length < 3 || !textOnly(main) || !words(main)) continue;
    const fits = (o, prev) => o && textOnly(o) && Math.abs(o.y - prev.y) < Math.min(small(o), small(prev)) * 2
      && o.cells.length < main.cells.length && o.cells.every(c => c.x > main.cells[0].end);
    const parts = [];
    for (const step of [-1, 1]) for (let k = i + step, prev = main; Math.abs(k - i) <= 2 && fits(rows[k], prev); k += step) parts.push(prev = rows[k]);
    if (!parts.length) continue;
    // Chaque titre de la ligne principale garde sa colonne ; un morceau rejoint celle qu'il recouvre le plus.
    const cols = main.cells.map(c => ({ ...c, y: main.y, parts: [{ ...c, y: main.y }] }));
    const overlap = (a, b) => Math.min(a.end, b.end) - Math.max(a.x, b.x);
    for (const c of parts.flatMap(r => r.cells.map(c => ({ ...c, y: r.y })))) {
      const col = cols.filter(k => overlap(k, c) > 0).sort((a, b) => overlap(b, c) - overlap(a, c))[0];
      if (col) { col.parts.push(c); col.x = Math.min(col.x, c.x); col.end = Math.max(col.end, c.end); }
      else cols.push({ ...c, parts: [c] });
    }
    cols.sort((a, b) => a.x - b.x);
    main.cells = cols.map(({ parts: p, ...k }) => ({ ...k, text: p.sort((a, b) => a.y - b.y).map(c => c.text).join(" ") }));
    rows = rows.filter(r => !parts.includes(r));
    i = rows.indexOf(main);
  }
  // Marque isolée en tête de ligne, loin du libellé qui suit (numéro de marge, puce lue par l'OCR…).
  for (const r of rows) {
    const [a, b] = r.cells;
    if (b && a.text.replace(/\s/g, "").length <= 2 && (b.text.match(/\p{L}/gu) || []).length >= 3
        && b.x - a.end > Math.max(a.size, b.size) * 0.8) r.cells.shift();
  }
  // Ligne de texte justifiée (espaces élargies) : une seule cellule, pas une case par mot.
  for (const r of rows) {
    const cs = r.cells;
    // (Une phrase peut porter une date ou un nombre : « clos le 31 décembre 2025 ».)
    const words = cs.filter(c => !isAmount(c.text)).length;
    if (cs.length >= 3 && (words === cs.length || (cs.length >= 6 && words >= cs.length * 0.75))
        && cs.every((c, i) => !i || c.x - cs[i - 1].end < Math.max(c.size, cs[i - 1].size) * 2.5))
      r.cells = [{ ...cs[0], text: cs.map(c => c.text).join(" "), end: cs[cs.length - 1].end }];
  }
  // Ligne faite d'un seul signe isolé (« 15] », « [4 ») : un reste de trait ou de case.
  rows = rows.filter(r => !(r.cells.length === 1 && !isAmount(r.cells[0].text)
    && r.cells[0].text.replace(/\s/g, "").length <= 3 && (r.cells[0].text.match(/\p{L}/gu) || []).length < 2));
  // Renvoi en chiffres romains lu « (1 à VI) » ou « (là V) » : « (I à VI) ».
  for (const r of rows) for (const c of r.cells) if (!isAmount(c.text)) c.text = fixOcrLabel(c.text);
  // Année du formulaire séparée de son numéro (« DGFiP N° 2051 » / « 2025 ») : un seul titre.
  for (const r of rows) r.cells = r.cells.reduce((acc, c) => {
    const prev = acc[acc.length - 1];
    if (prev && /N° ?\d{4}$/.test(prev.text) && /^(19|20)\d\d$/.test(c.text)) { prev.text += " " + c.text; prev.end = c.end; }
    else acc.push(c);
    return acc;
  }, []);
  // Bords d'une case de date (« ⌊31122025⌋ ») lus comme des « 1 » à côté de la date.
  for (const r of rows) if (r.cells.some(c => /^\d{2}\/\d{2}\/\d{4}$/.test(c.text))) r.cells = r.cells.filter(c => !/^[1I|]$/.test(c.text));
  // Chiffre mal lu par l'OCR en tête d'un montant : « S 751 781 » -> « 5 751 781 ».
  for (const r of rows) for (const c of r.cells)
    if (/^[SsOolI|]( \d{3})+([.,]\d+)?$/.test(c.text)) c.text = ({ S: "5", s: "5", O: "0", o: "0" }[c.text[0]] ?? "1") + c.text.slice(1);
  // Ligne de montants, éventuellement précédés d'une marque de quelques signes (« æ3 ») qu'on laisse tomber.
  const scrap = c => !isAmount(c.text) && c.text.length <= 3 && !/^[A-Z0-9]{2}$/.test(c.text);
  const amounts = r => r.cells.some(c => isAmount(c.text)) && r.cells.every(c => isAmount(c.text) || scrap(c));
  // Libellé sur deux lignes de part et d'autre d'une ligne de codes et de montants (liasse fiscale :
  // « Installations gales., agencts. et » / « S5 0 S6 0 … » / « aménag. ») : une seule ligne.
  const code = t => /^(?=.*[A-ZØ])[A-Z0-9Ø]{2}$/.test(t);
  const data = r => r.cells.some(c => isAmount(c.text)) && r.cells.every(c => isAmount(c.text) || code(c.text));
  for (let i = 1; i < rows.length - 1; i++) {
    const [a, r, b] = rows.slice(i - 1, i + 2);
    const half = o => Math.abs(o.y - r.y) < r.size * 0.8 && o.cells.every(c => !isAmount(c.text) && c.end < r.cells[0].x);
    if (!data(r) || !half(a) || !half(b)) continue;
    // Libellé plus long encore : les lignes voisines au même pas et au même retrait en font partie.
    const step = b.y - a.y, more = (o, n) => o && Math.abs(Math.abs(o.y - n.y) - step) < step * 0.15
      && o.cells.length === 1 && n.cells.length === 1 && Math.abs(o.cells[0].x - n.cells[0].x) < 1 && !isAmount(o.cells[0].text)
      && o.cells[0].end < r.cells[0].x;
    let top = i - 1, bottom = i + 1;
    while (more(rows[top - 1], rows[top])) top--;
    while (more(rows[bottom + 1], rows[bottom])) bottom++;
    const lines = [...rows.slice(top, i), ...rows.slice(i + 1, bottom + 1)];
    const label = lines[0].cells.map(c => ({ ...c }));
    for (const c of lines.slice(1).flatMap(o => o.cells)) {
      const k = label.find(o => Math.abs(o.x - c.x) < c.size * 1.5);
      if (k) { k.text += (/-$/.test(k.text) ? "" : " ") + c.text; k.end = Math.max(k.end, c.end); }
      else label.push(c);
    }
    r.cells = [...label.sort((p, q) => p.x - q.x), ...r.cells];
    rows = rows.filter(o => !lines.includes(o));
    i = rows.indexOf(r);
  }
  // Montants centrés entre les deux lignes d'un libellé : rattachés à la ligne de texte la plus proche.
  rows = rows.filter((r, i) => {
    if (!amounts(r)) return true;
    r = { ...r, cells: r.cells.filter(c => isAmount(c.text)) };
    const near = [rows[i - 1], rows[i + 1]].filter(o => o && !amounts(o) && Math.abs(o.y - r.y) < Math.max(o.size, r.size) * 1.3
      && !o.cells.some(a => r.cells.some(b => a.x < b.end && b.x < a.end)))
      .sort((a, b) => Math.abs(a.y - r.y) - Math.abs(b.y - r.y));
    if (!near.length) return true;
    near[0].cells.push(...r.cells); near[0].cells.sort((a, b) => a.x - b.x);
    return false;
  });
  // Libellé sur deux lignes (« Avances et acomptes sur immobilisa- » / « tions incorporelles ») : une seule
  // cellule, sur la ligne qui porte les montants s'ils sont tombés avec la seconde moitié.
  rows = rows.reduce((acc, r) => {
    const prev = acc[acc.length - 1], c = r.cells[0], p = prev?.cells[0];
    const joins = prev && (r.cells.length === 1 || prev.cells.length === 1) && /^\p{Ll}/u.test(c.text)
      && !isAmount(p.text) && Math.abs(p.x - c.x) <= p.size * 1.5 && r.y - prev.y <= Math.max(p.size, c.size) * 1.6;
    if (!joins) { acc.push(r); return acc; }
    const text = /-$/.test(p.text) ? p.text.slice(0, -1) + c.text : p.text + " " + c.text;
    if (r.cells.length === 1) { p.text = text; p.end = Math.max(p.end, c.end); }
    else { Object.assign(c, { text, x: p.x, end: Math.max(p.end, c.end) }); acc[acc.length - 1] = r; }
    return acc;
  }, []);
  // Colonnes : début des textes, fin des montants alignés à droite (un montant qui commence
  // pile sous le début d'une colonne de texte est aligné à gauche, comme dans la plupart des factures).
  const multi = rows.filter(r => r.cells.length > 1);
  const cluster = (kind, xs) => {
    const out = []; let group = null;
    for (const x of xs.sort((a, b) => a - b)) {
      if (group && x - group.max < 15) { group.max = x; group.sum += x; group.n++; }
      else out.push(group = { kind, max: x, sum: x, n: 1 });
    }
    for (const g of out) g.pos = g.sum / g.n;
    return out;
  };
  // Un montant est aligné du côté qu'il partage avec le plus de montants voisins (égalité : à droite,
  // sauf s'il commence sous une colonne de texte, comme « Quantité » / « 10 » dans une facture).
  const textCols = cluster("x", multi.flatMap(r => r.cells.filter(c => !isAmount(c.text)).map(c => c.x)));
  const nums = multi.flatMap(r => r.cells.filter(c => isAmount(c.text)));
  const share = (c, k) => nums.filter(o => Math.abs(o[k] - c[k]) < 4).length;
  const anchor = c => {
    if (!isAmount(c.text)) return { kind: "x", pos: c.x };
    const left = share(c, "x"), right = share(c, "end");
    return left > right || (left === right && textCols.some(k => Math.abs(k.pos - c.x) < 6))
      ? { kind: "x", pos: c.x } : { kind: "end", pos: c.end };
  };
  const cols = [...cluster("x", multi.flatMap(r => r.cells.map(anchor).filter(a => a.kind === "x").map(a => a.pos))),
                ...cluster("end", multi.flatMap(r => r.cells.map(anchor).filter(a => a.kind === "end").map(a => a.pos)))];
  cols.sort((a, b) => a.pos - b.pos);
  const geo = new WeakMap();
  const out = rows.map(r => {
    let next = 0;
    return {
      cells: r.cells.map(c => {
        const a = anchor(c);
        let col = -1, best = Infinity;
        cols.forEach((k, i) => {
          const d = Math.abs(k.pos - a.pos) + (k.kind === a.kind ? 0 : 1000);
          if (i >= next && d < best) { best = d; col = i; }
        });
        if (col < next) col = next;
        next = col + 1;
        const cell = { col, text: c.text, size: c.size, bold: c.bold };
        geo.set(cell, c);
        return cell;
      }),
    };
  });
  // Colonnes voisines de même nature qui ne se croisent sur aucune ligne : une seule colonne
  // (les libellés d'un formulaire, plus ou moins en retrait, restent ainsi dans la première).
  // De même pour un titre de colonne (« 31/12/2025 ») posé juste au-dessus de montants alignés à droite.
  const rowsOf = col => new Set(out.flatMap((r, i) => r.cells.some(c => c.col === col) ? [i] : []));
  const width = Math.max(0, ...out.flatMap(r => r.cells.map(c => c.col + 1)));
  const map = [], groups = [];
  // Le bandeau du haut de page (« Page : 23 ») n'empêche pas un titre de rejoindre ses montants.
  const banner = out.findIndex(r => r.cells.length > 1);
  for (let k = 0; k < width; k++) {
    const { kind, pos } = cols[Math.min(k, cols.length - 1)] ?? {}, mine = rowsOf(k), g = groups[groups.length - 1];
    const above = g && g.kind === "x" && kind === "end" && pos - g.pos < 100;
    if (g && (g.kind === kind || above) && ![...mine].some(i => g.lines.has(i) && !(above && i === banner && mine.size > 2))) {
      mine.forEach(i => g.lines.add(i));
      Object.assign(g, { kind, pos });
    } else groups.push({ kind, pos, lines: mine });
    map[k] = groups.length - 1;
  }
  for (const r of out) {
    for (const c of r.cells) c.col = map[c.col];
    r.cells = r.cells.reduce((acc, c) => {
      const prev = acc[acc.length - 1];
      if (prev && prev.col === c.col) prev.text += " " + c.text; else acc.push(c);
      return acc;
    }, []);
  }
  // Titre de colonne centré au-dessus d'une paire code + montant (« Brut » au-dessus de « AF 4 724 ») :
  // un code n'a pas de titre à lui, le titre va aux montants.
  const filled = (c, col) => c.col === col && (code(c.text) || isAmount(c.text));
  const middle = col => {
    const cs = out.flatMap(r => r.cells.filter(c => filled(c, col)));
    return { n: cs.length, nums: cs.filter(c => isAmount(c.text)).length, mid: cs.reduce((t, c) => t + (geo.get(c).x + geo.get(c).end) / 2, 0) / cs.length };
  };
  for (const r of out) {
    if (r.cells.some(c => code(c.text) || isAmount(c.text))) continue;
    for (const c of [...r.cells].reverse()) {
      const own = middle(c.col), next = middle(c.col + 1), mid = (geo.get(c).x + geo.get(c).end) / 2;
      if (next.n >= 3 && next.nums >= next.n * 0.8 && own.n >= 3 && own.nums <= own.n * 0.2
          && !r.cells.some(o => o.col === c.col + 1) && mid > own.mid) c.col++;
    }
  }
  // Titre aligné à droite au-dessus de montants que le regroupement a rangés dans la colonne voisine
  // (« Montant Brut » d'un second tableau de la page) : le titre rejoint ses montants.
  const head = r => r.cells.length >= 2 && !r.cells.some(c => code(c.text) || isAmount(c.text));
  out.forEach((r, i) => {
    if (!head(r)) return;
    let j = i + 1;
    while (j < out.length && j - i <= 60 && !head(out[j])) j++;
    const block = out.slice(i + 1, j).flatMap(o => o.cells);
    for (const c of [...r.cells].reverse()) {
      const nums = col => block.filter(o => o.col === col && isAmount(o.text)).map(o => geo.get(o));
      const below = nums(c.col + 1), g = geo.get(c);
      if (!nums(c.col).length && below.length >= 2 && !r.cells.some(o => o.col === c.col + 1)
          && g.x < Math.max(...below.map(o => o.end)) && Math.min(...below.map(o => o.x)) < g.end) c.col++;
    }
  });
  return out;
}

// « 1 234,56 € » -> 1234.56 ; renvoie le texte tel quel si ce n'est pas un nombre.
export function toNumber(text) {
  let t = text.replace(/[\s\u00a0\u202f€$£]/g, "");
  // (1 234) : montant négatif, à la manière des comptables ; « (1) » reste un renvoi.
  const neg = /^\((\d{3,}|\d.*[.,].*)\)$/.test(t);
  if (neg) t = t.slice(1, -1);
  if (/^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, "");  // 1.234.567,89 ou 41.016
  if (!/^[-+]?\d+([.,]\d+)?$/.test(t) || /^[-+]?0\d/.test(t) || (neg && /^[-+]/.test(t))) return text;
  return (neg ? -1 : 1) * parseFloat(t.replace(",", "."));
}

const rowToArray = row => {
  const out = [];
  for (const c of row.cells) out[c.col] = c.text;
  return Array.from(out, v => v ?? "");
};

export function toText(pages) {
  return pages.map(rows => rows.map(r => rowToArray(r).join("\t").replace(/\t+$/, "")).join("\n")).join("\n\n");
}

// Classeur Excel (SheetJS) : une feuille par page, nombres convertis.
export function toXlsx(XLSX, pages, names = pages.map((p, i) => `Page ${i + 1}`)) {
  const wb = XLSX.utils.book_new();
  pages.forEach((rows, i) => {
    const data = rows.map(r => rowToArray(r).map(toNumber));
    const ws = XLSX.utils.aoa_to_sheet(data.length ? data : [[""]]);
    // Montants affichés avec séparateur des milliers (1 234 567 ou 1 234,50 selon la langue d'Excel).
    // Une année (« 2025 » en titre de colonne) reste écrite sans séparateur des milliers.
    const years = new Set(rows.flatMap((r, y) => rowToArray(r).flatMap((t, x) => /^(19|20)\d\d$/.test(t) ? [XLSX.utils.encode_cell({ r: y, c: x })] : [])));
    for (const ref of Object.keys(ws)) if (ws[ref]?.t === "n") ws[ref].z = years.has(ref) ? "0" : Number.isInteger(ws[ref].v) ? "#,##0" : "#,##0.00";
    const width = Math.max(1, ...data.map(r => r.length));
    ws["!cols"] = Array.from({ length: width }, (_, k) =>
      ({ wch: Math.min(60, Math.max(8, ...data.map(r => String(r[k] ?? "").length + 2))) }));
    XLSX.utils.book_append_sheet(wb, ws, names[i]);
  });
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}

// Document Word (docx) : paragraphes, et vrais tableaux pour les lignes à plusieurs cases.
export async function toDocx(docx, pages) {
  const children = [];
  const run = c => new docx.TextRun({ text: c.text, bold: c.bold, size: Math.round(Math.min(c.size, 40) * 2) });
  pages.forEach((rows, p) => {
    if (p > 0) children.push(new docx.Paragraph({ children: [new docx.PageBreak()] }));
    for (let i = 0; i < rows.length;) {
      if (rows[i].cells.length < 2) {
        children.push(new docx.Paragraph({ children: rows[i].cells.map(run) }));
        i++; continue;
      }
      const block = [];
      while (i < rows.length && rows[i].cells.length >= 2) block.push(rows[i++]);
      const width = Math.max(...block.flatMap(r => r.cells.map(c => c.col + 1)));
      children.push(new docx.Table({
        width: { size: 100, type: docx.WidthType.PERCENTAGE },
        rows: block.map(r => new docx.TableRow({
          children: Array.from({ length: width }, (_, k) => {
            const c = r.cells.find(x => x.col === k);
            return new docx.TableCell({ children: [new docx.Paragraph({ children: c ? [run(c)] : [] })] });
          }),
        })),
      }));
    }
  });
  return docx.Packer.toBlob(new docx.Document({ sections: [{ children }] }));
}

// ------------------------------------------------------------ résumer, découper, signatures

// Texte de tout le document pour un assistant (Copilot…) : une partie par page, cases d'un
// tableau séparées par « | », pour qu'il garde les montants sur leur ligne.
export function documentText(pages) {
  return pages.map((rows, i) => {
    const lines = rows.map(r => rowToArray(r).filter(t => t.trim()).join(" | ")).filter(Boolean);
    return lines.length ? `--- Page ${i + 1} ---\n${lines.join("\n")}` : "";
  }).filter(Boolean).join("\n\n");
}

// Parties d'un document découpé par signets : chaque signet choisi (indices dans `outline`)
// ouvre une partie qui va jusqu'au signet choisi suivant. Les pages avant le premier forment
// une partie « Début ». Renvoie [{ title, from, to }] (pages numérotées à partir de 0).
export function bookmarkParts(outline, count, chosen = outline.map((o, k) => k)) {
  const starts = [];
  for (const k of chosen) {
    const o = outline[k];
    if (!o || o.page < 0 || o.page >= count) continue;
    const title = o.title.replace(/^[\s\-_–—=.*]+|[\s\-_–—=.*]+$/g, "").replace(/\s+/g, " ") || `Page ${o.page + 1}`;
    const same = starts.find(s => s.from === o.page);
    if (same) same.title += " - " + title;   // deux signets sur la même page : une seule partie
    else starts.push({ title, from: o.page });
  }
  starts.sort((a, b) => a.from - b.from);
  if (!starts.length) return [];
  if (starts[0].from > 0) starts.unshift({ title: "Début", from: 0 });
  return starts.map((s, k) => ({ ...s, to: (starts[k + 1]?.from ?? count) - 1 }));
}

// Nom de fichier Windows acceptable : « 03 - Bilan Actif.pdf ».
export function fileName(title, max = 80) {
  return title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).replace(/[ .]+$/, "") || "document";
}

// Archive ZIP (sans compression : des PDF sont déjà compressés) de [{ name, bytes }].
const CRC = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc32 = bytes => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
export function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.bytes), n = f.bytes.length;
    const head = (sig, extra) => {
      const h = new DataView(new ArrayBuffer(extra));
      h.setUint32(0, sig, true);
      return h;
    };
    const local = head(0x04034b50, 30);
    // version 2.0, drapeau 0x0800 : noms en UTF-8 (accents), méthode 0 : stockés tels quels
    [[4, 20], [6, 0x0800], [8, 0], [10, time], [12, date]].forEach(([o, v]) => local.setUint16(o, v, true));
    [[14, crc], [18, n], [22, n]].forEach(([o, v]) => local.setUint32(o, v, true));
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, f.bytes);
    const c = head(0x02014b50, 46);
    [[4, 20], [6, 20], [8, 0x0800], [10, 0], [12, time], [14, date]].forEach(([o, v]) => c.setUint16(o, v, true));
    [[16, crc], [20, n], [24, n], [42, offset]].forEach(([o, v]) => c.setUint32(o, v, true));
    c.setUint16(28, name.length, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + n;
  }
  const size = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

// Bilan des signatures électroniques (voir signatures()) pour le bandeau affiché à l'ouverture :
// { level: "ok" | "warn" | "bad", text }.
export function signatureSummary(sigs) {
  if (!sigs.length) return { level: "warn", text: "Ce document contient une signature électronique que Mim PDF ne sait pas lire." };
  const who = [...new Set(sigs.map(s => s.name || "signataire inconnu"))].join(", ");
  const dates = sigs.map(s => s.date).filter(Boolean).sort();
  const when = dates.length ? ` le ${new Date(dates[dates.length - 1]).toLocaleDateString("fr-FR")}` : "";
  const intro = `Signé électroniquement par ${who}${when}`;
  if (sigs.some(s => s.intact === false))
    return { level: "bad", text: `${intro}, mais le contenu a été modifié après la signature : elle n'est plus valable.` };
  if (sigs.some(s => s.intact === null))
    return { level: "warn", text: `${intro}. Mim PDF ne sait pas contrôler ce format de signature : vérifiez-la dans Adobe Acrobat Reader.` };
  const added = !sigs.some(s => s.covers);
  return { level: "ok", text: `${intro} : document intact${added ? " (des commentaires ont été ajoutés après la signature)" : ""}.` };
}

// --- Synthèse sur ce PC (rien n'est envoyé) ---

const STOP = new Set(("les des une est que qui dans pour par sur avec aux ses son sont pas plus ont ces cette " +
  "été être avoir fait leur leurs nous vous ils elles mais ou donc car tout tous toute toutes comme entre " +
  "sans sous ainsi elle lui aussi peut même dont the and for are this that with from have").split(" "));
const AMOUNT = /\d[\d\s  .]*,\d{2}\s?(?:€|eur)|\d{1,3}(?:[\s  ]\d{3})+(?:,\d+)?|\d+(?:,\d+)?\s?(?:€|%)/i;
const DATE = /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d{1,2}(?:er)?\s+(?:janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\s+\d{4}\b/i;
const KEY = /total|montant|net à payer|net a payer|solde|échéance|echeance|résultat|resultat|chiffre d.affaires|capital|capitaux propres|prix|tva|date limite|à payer|a payer/i;

// Résumé rapide d'un texte (voir documentText) sans intelligence artificielle : les phrases qui
// portent les mots les plus fréquents du document, et les lignes avec des montants ou des dates.
export function quickSummary(text, count = 8) {
  const lines = text.split("\n").filter(l => !/^--- Page \d+ ---$/.test(l)).map(l => l.replace(/ \| /g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  const sentences = [];
  for (const l of lines)
    for (const s of l.split(/(?<=[.!?;])\s+(?=[A-ZÀ-Ý«"])/)) if (s.length >= 40 && s.length <= 400 && /[a-zà-ÿ]{3}/.test(s)) sentences.push(s);
  const words = s => (plain(s).match(/[a-z]{3,}/g) || []).filter(w => !STOP.has(w));
  const freq = new Map();
  for (const s of sentences) for (const w of new Set(words(s))) freq.set(w, (freq.get(w) || 0) + 1);
  const scored = sentences.map((s, k) => {
    const ws = words(s);
    return { s, k, score: ws.reduce((t, w) => t + (freq.get(w) || 0), 0) / Math.sqrt(ws.length || 1) + (k < 3 ? 2 : 0) };
  });
  const seen = new Set();
  const points = scored.sort((a, b) => b.score - a.score).filter(x => {
    const key = plain(x.s).slice(0, 60);
    return !seen.has(key) && seen.add(key);
  }).slice(0, count).sort((a, b) => a.k - b.k).map(x => x.s);
  const figures = [];
  for (const l of lines) {
    if (figures.length >= 12) break;
    if (l.length > 160 || points.includes(l) || figures.includes(l)) continue;
    if ((KEY.test(l) && /\d/.test(l)) || (AMOUNT.test(l) && /[a-zà-ÿ]{3}/i.test(l)) || DATE.test(l)) figures.push(l);
  }
  return { points, figures };
}

export function summaryText({ points, figures }) {
  const list = items => items.map(t => `• ${t}`).join("\n");
  return [points.length ? `Points clés :\n${list(points)}` : "",
          figures.length ? `Chiffres et dates repérés :\n${list(figures)}` : ""].filter(Boolean).join("\n\n");
}

// Découpe un texte (voir documentText) en morceaux d'au plus `max` caractères, de préférence
// entre deux pages, sinon entre deux lignes.
export function summaryChunks(text, max = 6000) {
  const chunks = [];
  let cur = "";
  const push = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ""; };
  for (const page of text.split(/\n\n(?=--- Page \d+ ---)/)) {
    if (cur && cur.length + page.length + 2 > max) push();
    if (page.length <= max) { cur += (cur ? "\n\n" : "") + page; continue; }
    for (const line of page.split("\n")) {
      if (cur && cur.length + line.length + 1 > max) push();
      cur += (cur ? "\n" : "") + line.slice(0, max);
    }
  }
  push();
  return chunks;
}

const SYSTEM = "Tu es un assistant qui résume des documents en français. Tu t'appuies uniquement sur le texte fourni, " +
  "sans rien inventer, et tu recopies les montants et les dates exactement.";
const FINAL = "Rédige une synthèse claire en français : l'objet du document en une phrase, puis les points clés, " +
  "les chiffres importants (montants, dates, échéances) et ce qui demande une action ou une vigilance. Utilise des puces.";

// Messages pour le modèle de langue : un résumé par morceau, puis une synthèse des résumés.
export function summaryMessages(name, chunk, part = 1, parts = 1) {
  const ask = parts === 1 ? `${FINAL}\n\nDocument « ${name} » :\n\n${chunk}`
    : `Voici la partie ${part} sur ${parts} du document « ${name} ». Résume-la en quelques puces ` +
      `(points clés, montants, dates, échéances), sans introduction.\n\n${chunk}`;
  return [{ role: "system", content: SYSTEM }, { role: "user", content: ask }];
}

export function finalMessages(name, partials) {
  const all = partials.map((p, k) => `Partie ${k + 1} :\n${p}`).join("\n\n");
  return [{ role: "system", content: SYSTEM },
          { role: "user", content: `Voici les résumés successifs des parties du document « ${name} ».\n\n${all}\n\n${FINAL}` }];
}
