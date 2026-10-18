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
        page.drawText(text, { x, y, size, font, rotate });
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

// Regroupe le texte de chaque page en lignes visuelles composées de cellules
// (un tableau donne une cellule par case), avec des colonnes alignées.
// Renvoie [[{ cells: [{ col, text, size, bold }] }]] (une liste de lignes par page).
export function extractRows(bytes) {
  return withMu(bytes, doc => {
    const pages = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      pages.push(layoutRows(textLines(page)));
      page.destroy();
    }
    return pages;
  });
}

function layoutRows(lines) {
  lines.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const l of lines) {
    const cell = { x: l.x, end: l.bbox.x + l.bbox.w, text: l.text, size: l.font.size,
                   bold: l.font.weight === "bold" };
    const row = rows.find(r => Math.abs(r.y - l.y) < Math.max(r.size, cell.size) * 0.45);
    if (row) row.cells.push(cell); else rows.push({ y: l.y, size: cell.size, cells: [cell] });
  }
  rows.sort((a, b) => a.y - b.y);
  for (const r of rows) {
    r.cells.sort((a, b) => a.x - b.x);
    // Mots trop proches (souvent l'OCR) : même cellule.
    r.cells = r.cells.reduce((acc, c) => {
      const prev = acc[acc.length - 1];
      if (prev && c.x - prev.end < Math.max(prev.size, c.size) * 0.9) {
        const gap = /\s$/.test(prev.text) || /^\s/.test(c.text) || c.x - prev.end > prev.size * 0.15;
        prev.text = prev.text.trimEnd() + (gap ? " " : "") + c.text.trimStart(); prev.end = Math.max(prev.end, c.end);
      } else acc.push(c);
      return acc;
    }, []);
    for (const c of r.cells) c.text = c.text.trim();
  }
  // Colonnes : positions de départ des cellules des lignes à plusieurs cases.
  const xs = rows.filter(r => r.cells.length > 1).flatMap(r => r.cells.map(c => c.x)).sort((a, b) => a - b);
  const anchors = [];
  for (const x of xs) {
    const last = anchors[anchors.length - 1];
    if (last && x - last.max < 15) { last.max = x; last.sum += x; last.n++; } else anchors.push({ max: x, sum: x, n: 1 });
  }
  const cols = anchors.map(a => a.sum / a.n);
  return rows.map(r => {
    let next = 0;
    return {
      cells: r.cells.map(c => {
        let col = 0, best = Infinity;
        cols.forEach((x, k) => { if (k >= next && Math.abs(x - c.x) < best) { best = Math.abs(x - c.x); col = k; } });
        if (!cols.length || col < next) col = next;
        next = col + 1;
        return { col, text: c.text, size: c.size, bold: c.bold };
      }),
    };
  });
}

// « 1 234,56 € » -> 1234.56 ; renvoie le texte tel quel si ce n'est pas un nombre.
export function toNumber(text) {
  let t = text.replace(/[\s\u00a0\u202f€$£]/g, "");
  if (/^[-+]?\d{1,3}(\.\d{3})+,\d+$/.test(t)) t = t.replace(/\./g, "");
  if (!/^[-+]?\d+([.,]\d+)?$/.test(t) || /^[-+]?0\d/.test(t)) return text;
  return parseFloat(t.replace(",", "."));
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
export function toXlsx(XLSX, pages) {
  const wb = XLSX.utils.book_new();
  pages.forEach((rows, i) => {
    const data = rows.map(r => rowToArray(r).map(toNumber));
    const ws = XLSX.utils.aoa_to_sheet(data.length ? data : [[""]]);
    const width = Math.max(1, ...data.map(r => r.length));
    ws["!cols"] = Array.from({ length: width }, (_, k) =>
      ({ wch: Math.min(60, Math.max(8, ...data.map(r => String(r[k] ?? "").length + 2))) }));
    XLSX.utils.book_append_sheet(wb, ws, `Page ${i + 1}`);
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
