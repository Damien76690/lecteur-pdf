// Tests de la version en ligne : npm ci && npm test (lancés aussi avant chaque publication)
import test from "node:test";
import assert from "node:assert/strict";
import * as mupdf from "mupdf";
import * as PDFLib from "pdf-lib";
import XLSX from "xlsx";
import * as docx from "docx";
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

test("Word : un document est produit", async () => {
  const blob = await core.toDocx(docx, core.extractRows(facture()));
  assert.ok(blob.size > 1000);
});

test("nombres à la française", () => {
  assert.equal(core.toNumber("1 234,56 €"), 1234.56);
  assert.equal(core.toNumber("1.234,56"), 1234.56);
  assert.equal(core.toNumber("0612345678"), "0612345678");
  assert.equal(core.toNumber("Papier A4"), "Papier A4");
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
