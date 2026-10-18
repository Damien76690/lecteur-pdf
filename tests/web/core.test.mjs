// Tests de la version en ligne : npm ci && npm test (lancés aussi avant chaque publication)
import test from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import * as PDFLib from "pdf-lib";
import XLSX from "xlsx";
import * as docx from "docx";
import forge from "node-forge";
import * as core from "../../web/core.js";
import { makeExamples } from "../../scripts/exemples.mjs";

core.init({ mupdf, PDFLib });
const examples = await makeExamples();
const facture = () => examples["facture.pdf"];
const text = bytes => core.toText(core.extractRows(bytes));

test("remplacer supprime vraiment l'ancien texte", async () => {
  const { bytes, count } = await core.replaceText(facture(), "Dupont", "Martin");
  assert.equal(count, 1);
  assert.match(text(bytes), /Société Martin/);
  assert.doesNotMatch(text(bytes), /Dupont/);
});

test("écrire du texte avec accents et €", async () => {
  const bytes = await core.addText(facture(), 0, 72, 300, "Payé – 105 €\nDeuxième ligne", 12, "#ff0000");
  assert.match(text(bytes), /Payé – 105 €\nDeuxième ligne/);
});

test("effacer une zone supprime son contenu", () => {
  const bytes = core.whiteout(facture(), 0, 70, 140, 460, 235);
  assert.doesNotMatch(text(bytes), /Papier/);
  assert.match(text(bytes), /Total à payer/);
});

test("pivoter puis écrire reste lisible à l'horizontale", async () => {
  let bytes = await core.rotatePage(facture(), 0);
  assert.equal(core.pageInfo(bytes)[0].w, 842);
  bytes = await core.addText(bytes, 0, 50, 50, "Après rotation", 14);
  assert.match(text(bytes), /^Après rotation$/m);
});

test("Excel : tableau en colonnes et vrais nombres", () => {
  const wb = XLSX.read(core.toXlsx(XLSX, core.extractRows(facture())));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets["Page 1"], { header: 1 });
  assert.deepEqual(rows[2], ["Article", "Quantité", "Prix unitaire", "Total"]);
  assert.deepEqual(rows[3], ["Papier A4", 10, 4.5, 45]);
});

// Formulaire de type bilan : montants alignés à droite avec espaces des milliers,
// libellé sur deux lignes, cadre du tableau tracé en traits.
async function bilan() {
  const d = await PDFLib.PDFDocument.create();
  const font = await d.embedFont(PDFLib.StandardFonts.TimesRoman);
  const page = d.addPage([595, 842]);
  const put = (t, x, y, size = 9) => page.drawText(t, { x, y, size, font });
  const right = (t, end, y) => put(t, end - font.widthOfTextAtSize(t, 9), y);
  put("Brut", 300, 760); put("Net", 420, 760); put("Net N-1", 500, 760);
  const lines = [["Concessions, brevets et droits similaires", "AF", "6 900", "4 558", "(5 095)"],
                 ["Autres immobilisations incorporelles", "AJ", "69 583", "69 583", "41 016"],
                 ["Disponibilités (1)", "CF", "735 694", "735 694", "566 409"]];
  lines.forEach(([label, code, ...v], i) => {
    const y = 730 - i * 22;
    put(label, 40, y); put(code, 250, y);
    right(v[0], 340, y); right(v[1], 460, y); right(v[2], 560, y);
  });
  put("Installations techniques, matériel", 40, 668); put("et outillage industriels", 40, 659);
  put("AR", 250, 663); right("250 190", 340, 663); right("24 519", 460, 663); right("50 647", 560, 663);
  for (let y = 650; y <= 775; y += 22) page.drawLine({ start: { x: 30, y }, end: { x: 570, y }, thickness: 1 });
  return d.save();
}

test("Excel : bilan avec montants alignés à droite et libellé sur deux lignes", async () => {
  const wb = XLSX.read(core.toXlsx(XLSX, core.extractRows(await bilan())), { cellNF: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets["Page 1"], { header: 1 }).map(r => Array.from(r, v => v ?? ""));
  assert.deepEqual(rows[0].filter(Boolean), ["Brut", "Net", "Net N-1"]);
  const row = label => rows.find(r => r[0].startsWith(label));
  assert.deepEqual(row("Concessions").filter(v => v !== ""), ["Concessions, brevets et droits similaires", "AF", 6900, 4558, -5095]);
  assert.deepEqual(row("Disponibilités").filter(v => v !== ""), ["Disponibilités (1)", "CF", 735694, 735694, 566409]);
  const inst = row("Installations");
  assert.equal(inst[0], "Installations techniques, matériel et outillage industriels");
  // Chaque montant tombe dans la colonne de son exercice, comme sur la ligne « Concessions ».
  const cols = r => [6900, 250190].includes(r.find(v => typeof v === "number")) && r.map(v => typeof v === "number");
  assert.deepEqual(cols(inst), cols(row("Concessions")));
  assert.equal(wb.Sheets["Page 1"][XLSX.utils.encode_cell({ r: rows.indexOf(inst), c: inst.indexOf(250190) })].z, "#,##0");
});

test("OCR : l'image préparée n'a plus les traits du tableau", async () => {
  const doc = core.openMu(await bilan());
  const png = core.renderForOcr(doc, 0, 2);
  const pix = new mupdf.Image(png).toPixmap();
  const w = pix.getWidth(), px = pix.getPixels(), n = pix.getNumberOfComponents() + (pix.getAlpha() ? 1 : 0);
  const dark = (x, y) => px[(y * w + x) * n] < 128;
  const lineY = Math.round((842 - 650) * 2);
  assert.ok(![...Array(200).keys()].some(i => dark(400 + i, lineY)), "trait effacé");
  assert.ok([...Array(300).keys()].some(i => [...Array(20).keys()].some(j => dark(80 + i, Math.round((842 - 730) * 2) - j))), "texte gardé");
});

test("OCR : signes hauts et étroits d'un texte vertical écartés", () => {
  const word = (text, h, confidence = 90) => ({ text, confidence, bbox: { x0: 0, y0: 0, x1: 10, y1: h } });
  const kept = core.keepOcrWords([word("Capital", 20), word("souscrit", 21), word("AA", 20), word("8", 60), word("ACT", 70), word("bruit", 22, 10)]);
  assert.deepEqual(kept.map(w => w.text), ["Capital", "souscrit", "AA"]);
});

test("OCR : texte vertical de la marge écarté, même lu par morceaux", () => {
  const word = (text, x, y, h = 25) => ({ text, confidence: 90, bbox: { x0: x, y0: y, x1: x + 20, y1: y + h } });
  const pile = ["A", "C", "T", "I", "F"].map((t, i) => word(t, 10, 100 + i * 30));
  const kept = core.keepOcrWords([word("Capital", 100, 100), ...pile, word("2", 12, 330), word("AB", 300, 100), word("AC", 300, 150)]);
  assert.deepEqual(kept.map(w => w.text), ["Capital", "AB", "AC"]);
});

test("OCR : chaque montant est relu seul, en chiffres", () => {
  const word = (text, x0, x1, confidence = 90) => ({ text, confidence, bbox: { x0, y0: 100, x1, y1: 126 } });
  const words = [word("Emprunts", 0, 100), word("|", 300, 305), word("123,87", 315, 400), word("2", 500, 515, 0), word("258,35", 525, 610, 0),
    word("(3)", 700, 730), word("31122025", 800, 960), word("5", 1000, 1015), word("000,00", 1025, 1100)];
  const zones = core.numberZones(words, { width: 1200, height: 300 });
  assert.equal(zones.length, 5);
  assert.ok(zones.every(z => z.rect.left >= 0 && z.rect.left + z.rect.width <= 1200));
  const reads = [["1 123,87", 64], ["2 258,35", 0], ["3)", 80], ["31122025", 83], ["000,00", 96]].map(([text, confidence]) => ({ text, confidence }));
  const kept = core.keepOcrWords(core.mergeNumberReads(words, zones, reads));
  // « | » relu « 1 », montant peu sûr confirmé, renvoi « (3) » et « 5 000,00 » gardés, date des cases écrite en date.
  assert.deepEqual(kept.map(w => w.text), ["Emprunts", "1 123,87", "2 258,35", "(3)", "31/12/2025", "5", "000,00"]);
});

test("Excel d'un scan : titre de colonne sur ses montants, mots séparés, cases parasites écartées", async () => {
  const d = await PDFLib.PDFDocument.create();
  d.addPage([595, 842]);
  const word = (text, x0, y0, x1) => ({ text, bbox: { x0, y0, x1, y1: y0 + 12 } });
  const words = [word("Etat", 50, 100, 75), word("31/12/2025", 300, 100, 360),
    word("Clients", 50, 130, 90), word("1", 330, 130, 336), word("234", 340, 130, 370),
    word("Stocks", 50, 160, 85), word("56", 330, 160, 342), word("789", 346, 160, 370), word("15]", 50, 190, 66),
    word("TOTAL", 50, 220, 85), word("GENERAL", 86, 220, 140), word("58", 330, 220, 342), word("023", 346, 220, 370)];
  const rows = core.extractRows(await core.addOcrLayer(await d.save(), [{ index: 0, zoom: 1, words }]))[0]
    .map(r => r.cells.map(c => ({ col: c.col, text: c.text })));
  assert.deepEqual(rows.map(r => r[0].text), ["Etat", "Clients", "Stocks", "TOTAL GENERAL"]);
  const col = text => rows.flat().find(c => c.text === text).col;
  assert.equal(col("31/12/2025"), col("1 234"));
  assert.equal(col("58 023"), col("56 789"));
});

test("Word : un document est produit", async () => {
  const blob = await core.toDocx(docx, core.extractRows(facture()));
  assert.ok(blob.size > 1000);
});

test("nombres à la française", () => {
  assert.equal(core.toNumber("1 234,56 €"), 1234.56);
  assert.equal(core.toNumber("1.234,56"), 1234.56);
  assert.equal(core.toNumber("0612345678"), "0612345678");
  assert.equal(core.toNumber("Papier A4"), "Papier A4");
  assert.equal(core.toNumber("(5 095)"), -5095);
  assert.equal(core.toNumber("(1)"), "(1)");
  assert.equal(core.toNumber("41.016"), 41016);
});

test("un scan est détecté comme ayant besoin de l'OCR", () => {
  const scan = examples["facture-scannee.pdf"];
  assert.ok(core.needsOcr(core.pageInfo(scan)));
  assert.ok(!core.needsOcr(core.pageInfo(facture())));
});

test("surligner, souligner, barrer : seul le texte sélectionné est marqué", () => {
  let bytes = core.annotate(facture(), 0, { kind: "highlight", from: [72, 105], to: [300, 112], color: "#ffd400" });
  bytes = core.annotate(bytes, 0, { kind: "underline", from: [72, 255], to: [200, 262], color: "#0000ff" });
  bytes = core.annotate(bytes, 0, { kind: "strike", from: [77, 175], to: [140, 180], color: "#ff0000" });
  const list = core.listAnnotations(bytes);
  assert.deepEqual(list.map(a => a.type), ["Highlight", "Underline", "StrikeOut"]);
  assert.match(list[0].text, /Société Dupont/);
  assert.match(text(bytes), /Société Dupont/, "le texte reste intact");
  assert.throws(() => core.annotate(facture(), 0, { kind: "highlight", from: [300, 600], to: [400, 650] }), /aucun texte/);
});

test("notes, zone de texte, dessins et tampon, puis modification et suppression", () => {
  let bytes = facture();
  const specs = [
    { kind: "note", at: [400, 300], text: "À vérifier" },
    { kind: "textbox", at: [72, 320], text: "Livré le 3 mars – 105 €", size: 12, color: "#c00000" },
    { kind: "ink", strokes: [[[100, 400], [150, 430], [200, 400]]], color: "#0000ff" },
    { kind: "rect", rect: [300, 450, 400, 500], color: "#008000" },
    { kind: "ellipse", rect: [420, 450, 520, 500], color: "#008000" },
    { kind: "arrow", from: [100, 500], to: [250, 520], color: "#ff0000" },
    { kind: "stamp", at: [450, 650], text: "PAYÉ", color: "#c00000" },
  ];
  for (const s of specs) bytes = core.annotate(bytes, 0, s);
  let list = core.listAnnotations(bytes);
  assert.deepEqual(list.map(a => a.type), ["Text", "FreeText", "Ink", "Square", "Circle", "Line", "FreeText"]);
  assert.equal(list[0].text, "À vérifier");
  assert.equal(list[6].text, "PAYÉ");
  bytes = core.setAnnotationText(bytes, 0, list[0].index, "Vérifié");
  bytes = core.deleteAnnotation(bytes, 0, list[3].index);
  list = core.listAnnotations(bytes);
  assert.equal(list.length, 6);
  assert.equal(list[0].text, "Vérifié");
  assert.ok(!list.some(a => a.type === "Square"));
  // Les commentaires survivent aux autres modifications (pdf-lib) et à la conversion.
  return core.rotatePage(bytes, 0).then(b => assert.equal(core.listAnnotations(b).length, 6));
});

test("signature image posée sur la page", () => {
  const png = mupdf.Document.openDocument(facture(), "application/pdf").loadPage(0)
    .toPixmap(mupdf.Matrix.scale(0.2, 0.2), mupdf.ColorSpace.DeviceRGB, true).asPNG();
  const bytes = core.annotate(facture(), 0, { kind: "image", rect: [350, 700, 500, 760], png, text: "Signature" });
  const [sig] = core.listAnnotations(bytes);
  assert.equal(sig.type, "Stamp");
  assert.equal(sig.text, "Signature");
  assert.ok(sig.bounds[0] >= 349 && sig.bounds[2] <= 501);
});

// ------------------------------------------------------------ lecture

const open = bytes => mupdf.Document.openDocument(bytes, "application/pdf");

test("rechercher sans tenir compte des majuscules ni des accents", () => {
  const d = open(facture());
  assert.equal(core.search(d, 0, "papier").length, 1);
  assert.equal(core.search(d, 0, "societe dupont").length, 1);
  assert.deepEqual(core.search(d, 0, "   "), []);
  const [[r]] = core.search(d, 0, "Papier");
  assert.ok(r[0] < r[2] && r[1] < r[3], "rectangle de l'occurrence");
});

test("le texte de la page est disponible pour être sélectionné", () => {
  const lines = core.pageText(open(facture()), 0);
  const title = lines.find(l => l.text.startsWith("Facture n°"));
  assert.ok(title && title.w > 50 && title.size === 20);
});

test("signets du document", () => {
  const d = open(facture());
  const it = d.outlineIterator();
  it.insert({ title: "Facture", uri: "#page=1", open: true });
  const bytes = d.saveToBuffer("").asUint8Array().slice();
  assert.deepEqual(core.outline(open(bytes)), [{ title: "Facture", page: 0, level: 0 }]);
  assert.deepEqual(core.outline(open(facture())), []);
});

// PDF portant une signature électronique (structure /Sig avec /ByteRange, comme Docusign).
async function signedPdf() {
  const d = await PDFLib.PDFDocument.load(facture());
  d.context.register(d.context.obj({ Type: "Sig", Filter: "Adobe.PPKLite", ByteRange: [0, 10, 20, 30],
    Contents: PDFLib.PDFHexString.of("00") }));
  return d.save({ useObjectStreams: false });
}

test("un PDF signé garde sa signature quand on le commente", async () => {
  const signed = await signedPdf();
  assert.ok(core.isSigned(signed));
  assert.ok(!core.isSigned(facture()));
  const commented = core.annotate(signed, 0, { kind: "note", at: [400, 300], text: "Vu" });
  assert.ok(core.keepsOriginal(signed, commented), "enregistrement à la suite du fichier signé");
  assert.equal(core.listAnnotations(commented).length, 1);
  const rotated = await core.rotatePage(signed, 0);
  assert.ok(!core.keepsOriginal(signed, rotated), "une rotation réécrit le fichier");
});

test("aucun champ de formulaire dans la facture", () => {
  assert.equal(core.formFields(open(facture())), 0);
});

// ------------------------------------------------------------ pages

const pages = bytes => core.pageInfo(bytes).length;
async function numbered(n) {
  const d = await PDFLib.PDFDocument.create();
  const font = await d.embedFont(PDFLib.StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) d.addPage([400, 500]).drawText(`Contenu ${i}`, { x: 50, y: 400, size: 20, font });
  return d.save();
}

test("lire une liste de pages", () => {
  assert.deepEqual(core.parseRange("1-3, 5", 8), [0, 1, 2, 4]);
  assert.deepEqual(core.parseRange("7-fin", 8), [6, 7]);
  assert.deepEqual(core.parseRange("3-1", 8), [2, 1, 0]);
  assert.throws(() => core.parseRange("9", 8), /8 page/);
  assert.throws(() => core.parseRange("a", 8), /n'est pas/);
  assert.throws(() => core.parseRange(" ", 8), /indiquez/);
});

test("déplacer, extraire, insérer, fusionner, page blanche", async () => {
  const doc = await numbered(4);
  const order = b => text(b).match(/Contenu \d/g).join(",");
  assert.equal(order(await core.movePage(doc, 0, 2)), "Contenu 2,Contenu 3,Contenu 1,Contenu 4");
  assert.equal(order(await core.movePage(doc, 3, 0)), "Contenu 4,Contenu 1,Contenu 2,Contenu 3");
  assert.equal(order(await core.extractPages(doc, [3, 1])), "Contenu 4,Contenu 2");
  const merged = await core.mergePdfs([doc, facture()]);
  assert.equal(pages(merged), 5);
  assert.match(text(merged), /Contenu 4[\s\S]*Société Dupont/);
  const inserted = await core.insertPdf(doc, facture(), 0);
  assert.match(text(inserted), /Contenu 1[\s\S]*Société Dupont[\s\S]*Contenu 2/);
  const blank = await core.insertBlankPage(doc, 1);
  assert.equal(pages(blank), 5);
  assert.deepEqual(core.pageInfo(blank)[2].w, 400);
  assert.equal(order(blank), "Contenu 1,Contenu 2,Contenu 3,Contenu 4");
});

test("numéroter les pages et poser un filigrane", async () => {
  const doc = await numbered(3);
  const n = await core.numberPages(doc);
  assert.match(text(n), /Page 1 \/ 3/);
  assert.match(text(n), /Page 3 \/ 3/);
  const skip = await core.numberPages(doc, { format: "{n}", from: 1, first: 1, position: "haut-droite" });
  // La première page n'est pas numérotée : les deux suivantes portent 1 et 2.
  assert.match(text(skip), /^1$/m);
  assert.match(text(skip), /^2$/m);
  assert.doesNotMatch(text(skip), /^3$/m);
  const w = await core.watermark(doc, "CONFIDENTIEL");
  assert.match(text(w), /CONFIDENTIEL/);
  assert.match(text(w), /Contenu 1/);
});

// ------------------------------------------------------------ formulaires et protection

async function formPdf() {
  const d = await PDFLib.PDFDocument.create(); const p = d.addPage([400, 500]); const f = d.getForm();
  f.createTextField("nom").addToPage(p, { x: 50, y: 400, width: 200, height: 24 });
  f.createCheckBox("accepte").addToPage(p, { x: 50, y: 350, width: 16, height: 16 });
  const v = f.createDropdown("ville"); v.addOptions(["Rouen", "Paris", "Évreux"]); v.addToPage(p, { x: 50, y: 300, width: 150, height: 22 });
  const r = f.createRadioGroup("choix");
  r.addOptionToPage("oui", p, { x: 50, y: 250, width: 14, height: 14 });
  r.addOptionToPage("non", p, { x: 90, y: 250, width: 14, height: 14 });
  return d.save();
}

test("remplir un formulaire", async () => {
  let bytes = await formPdf();
  const list = core.fields(open(bytes));
  assert.deepEqual(list.map(f => f.type), ["text", "checkbox", "combobox", "radiobutton", "radiobutton"]);
  assert.deepEqual(list[2].options, ["Rouen", "Paris", "Évreux"]);
  assert.equal(core.formFields(open(bytes)), 5);
  bytes = core.setField(bytes, 0, 0, "Durand – 105 €");
  bytes = core.setField(bytes, 0, 1, true);
  bytes = core.setField(bytes, 0, 2, "Évreux");
  bytes = core.setField(bytes, 0, 4, true);
  let after = core.fields(open(bytes));
  assert.equal(after[0].value, "Durand – 105 €");
  assert.deepEqual(after.map(f => f.checked), [false, true, false, false, true]);
  assert.equal(after[2].value, "Évreux");
  bytes = core.setField(bytes, 0, 3, true);
  bytes = core.setField(bytes, 0, 1, false);
  after = core.fields(open(bytes));
  assert.deepEqual(after.map(f => f.checked), [false, false, false, true, false], "un seul bouton radio coché");
});

test("protéger par mot de passe puis rouvrir", async () => {
  const locked = core.protect(facture(), { password: "secret", print: false });
  assert.ok(core.needsPassword(locked));
  assert.ok(!core.needsPassword(facture()));
  assert.throws(() => core.unlock(locked, "faux"), /incorrect/);
  const back = core.unlock(locked, "secret");
  assert.ok(!core.needsPassword(back));
  assert.match(text(back), /Société Dupont/);
  // Restrictions seules : s'ouvre sans mot de passe.
  assert.ok(!core.needsPassword(core.protect(facture(), { copy: false })));
  assert.throws(() => core.protect(facture(), { password: "a,b" }), /virgule/);
});

// ------------------------------------------------------------ compresser, aplatir, images

// Photo de 2400 × 1800 pixels (dégradé bruité) enregistrée en PNG, donc lourde.
function photoPng(w = 2400, h = 1800) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const px = pix.getPixels();
  for (let y = 0, k = 0; y < h; y++) for (let x = 0; x < w; x++, k += 3) {
    const n = (x * 7919 + y * 104729) % 23;
    px[k] = (x * 255 / w + n) | 0; px[k + 1] = (y * 255 / h + n) | 0; px[k + 2] = 128 + n;
  }
  return pix.asPNG();
}

test("créer un PDF à partir d'images, puis le compresser", async () => {
  const png = photoPng();
  assert.equal(core.imageType(png), "png");
  assert.equal(core.imageType(facture()), null);
  const pdf = await core.imagesToPdf([png, open(facture()).loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false).asJPEG(80)]);
  const info = core.pageInfo(pdf);
  assert.deepEqual(info.map(p => [p.w, p.h]), [[842, 595], [595, 842]], "paysage puis portrait");
  const { bytes, images } = core.compress(pdf, "ecran");
  assert.ok(images >= 1);
  assert.ok(bytes.length < pdf.length / 3, `${pdf.length} -> ${bytes.length}`);
  assert.equal(core.pageInfo(bytes).length, 2);
  const again = core.compress(facture());
  assert.equal(again.images, 0);
  assert.match(text(again.bytes), /Société Dupont/);
});

test("aplatir : les commentaires deviennent le contenu de la page", () => {
  const noted = core.annotate(facture(), 0, { kind: "textbox", at: [72, 320], text: "Vu le 3 mars", size: 12 });
  const flat = core.flatten(noted);
  assert.equal(core.listAnnotations(flat).length, 0);
  assert.match(text(flat), /Vu le 3 mars/);
});

test("exporter une page en image", () => {
  const png = core.pageImage(open(facture()), 0, { dpi: 72 });
  assert.equal(core.imageType(png), "png");
  assert.equal(core.imageType(core.pageImage(open(facture()), 0, { format: "jpeg" })), "jpeg");
});

// ------------------------------------------------------------ signature par certificat

// Certificat personnel de test (.p12) au nom de « Jeanne Martin ».
function testP12(password = "1234") {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 864e5); cert.validity.notAfter = new Date(Date.now() + 365 * 864e5);
  const attrs = [{ name: "commonName", value: "Jeanne Martin" }, { name: "organizationName", value: "Mim Test" }];
  cert.setSubject(attrs); cert.setIssuer(attrs); cert.sign(keys.privateKey, forge.md.sha256.create());
  const der = forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: "3des" })).getBytes();
  return Uint8Array.from(der, c => c.charCodeAt(0));
}

test("signer avec un certificat, vérifier, puis détecter une modification", () => {
  const p12 = testP12();
  assert.throws(() => core.readCertificate(forge, p12, "faux"), /mot de passe/);
  const id = core.readCertificate(forge, p12, "1234");
  assert.equal(id.name, "Jeanne Martin");
  const signed = core.signPdf(forge, facture(), id, { page: 0, rect: [350, 700, 550, 760], reason: "J'approuve ce document", location: "Rouen" });
  assert.ok(core.keepsOriginal(facture(), signed), "signature ajoutée à la suite du fichier");
  assert.ok(core.isSigned(signed));
  let [sig] = core.signatures(forge, signed);
  assert.equal(sig.name, "Jeanne Martin");
  assert.equal(sig.reason, "J'approuve ce document");
  assert.equal(sig.intact, true);
  assert.equal(sig.covers, true);
  assert.match(text(signed), /Société Dupont/);
  // Un commentaire ajouté ensuite garde la signature intacte, mais elle ne couvre plus tout le fichier.
  const noted = core.annotate(signed, 0, { kind: "note", at: [400, 300], text: "Vu" });
  [sig] = core.signatures(forge, noted);
  assert.equal(sig.intact, true);
  assert.equal(sig.covers, false);
  // Un octet signé modifié est détecté.
  const tampered = signed.slice();
  const k = latin1(signed).indexOf("Dupont");
  if (k > 0) tampered[k] = 0x58;
  else tampered[200] ^= 1;
  assert.equal(core.signatures(forge, tampered)[0].intact, false);
  // Deux signatures successives restent toutes deux valables.
  const twice = core.signPdf(forge, signed, id, { page: 0, rect: null, reason: "Contre-signature" });
  const both = core.signatures(forge, twice);
  assert.equal(both.length, 2);
  assert.ok(both.every(s => s.intact));
});
const latin1 = b => new TextDecoder("latin1").decode(b);
