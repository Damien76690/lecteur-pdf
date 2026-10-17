// Traitements PDF de la version en ligne, exécutés entièrement dans le navigateur :
// le fichier ne quitte jamais l'ordinateur de l'utilisateur.
//   MuPDF (AGPL)  : affichage, lecture du texte, effacement réel (« redaction »).
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

function saveMu(doc) {
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
    return saveMu(doc);
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
    return writes.length ? saveMu(doc) : bytes;
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
