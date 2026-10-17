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
