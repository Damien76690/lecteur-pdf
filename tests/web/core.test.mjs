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
  let x = 0;
  const word = (text, h, confidence = 90) => ({ text, confidence, bbox: { x0: x += 100, y0: 0, x1: x + 10, y1: h } });
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

test("OCR : chaque libellé peu sûr est relu, la relecture n'est gardée que si elle est meilleure", () => {
  const word = (text, x0, y0, confidence = 70) => ({ text, confidence, bbox: { x0, y0, x1: x0 + text.length * 12, y1: y0 + 25 } });
  const words = [word("laméthode", 10, 0), word("de", 130, 0), word("mise", 160, 0),
    word("incorporelles", 10, 100),
    word("PME", 10, 200, 92), word("innovantes", 60, 200, 90),
    word("tanaupus", 10, 300, 30), word("GE", 10, 400, 25), word("a", 50, 400, 25),
    word("CS", 10, 500, 60), word("12", 300, 500, 90)];
  const zones = core.textZones(words, { width: 1000, height: 1000 });
  assert.deepEqual(zones.map(z => z.ids.map(i => words[i].text).join(" ")),
    ["laméthode de mise", "incorporelles", "PME innovantes", "tanaupus", "GE a", "CS"]);
  const read = (text, confidence) => ({ text, confidence, words: text.split(" ").filter(Boolean).map(t => ({ text: t, confidence })) });
  const merged = core.mergeTextReads(words, zones, [read("la méthode de mise", 95), read("incorpo relles", 92),
    read("PM innovantes", 93), read("1 an au plus", 93), read("", 0), read("CJ", 90)]);
  assert.deepEqual(merged.map(w => w.text), ["la méthode de mise", "incorporelles", "PME", "innovantes", "1 an au plus", "CS", "12"]);
});

test("OCR : signe lu sur un grand titre écarté, petits mots gardés", () => {
  const word = (text, x0, y0, x1, y1, confidence = 90) => ({ text, confidence, bbox: { x0, y0, x1, y1 } });
  const kept = core.keepOcrWords([word("Créances", 875, 378, 1245, 449), word("4", 1000, 378, 1019, 398, 47),
    word("Dettes", 1371, 379, 1622, 447), word("Etat", 100, 600, 150, 625), word("exprimé", 160, 600, 260, 625),
    word("Prêts", 100, 640, 150, 665), word("Clients", 100, 680, 150, 705), word("Stocks", 300, 680, 350, 705),
    word("Désignation", 100, 700, 300, 790), word("du", 120, 720, 150, 740)]);
  assert.deepEqual(kept.map(w => w.text), ["Créances", "Dettes", "Etat", "exprimé", "Prêts", "Clients", "Stocks", "Désignation", "du"]);
});

test("OCR : confusions courantes des liasses fiscales corrigées", () => {
  const fix = core.fixOcrLabel;
  assert.equal(fix("TOTAL (Im"), "TOTAL (II)");
  assert.equal(fix("TOTAL (D"), "TOTAL (I)");
  assert.equal(fix("TOTAL GENERAL (1a VD)"), "TOTAL GENERAL (I à VI)");
  assert.equal(fix("TOTAL GENERAL (là V)"), "TOTAL GENERAL (I à V)");
  assert.equal(fix("Total des charges financières (VI GU"), "Total des charges financières (VI) GU");
  assert.equal(fix("aplus de Sans"), "à plus de 5 ans");
  assert.equal(fix("entre letSans"), "entre 1 et 5 ans");
  assert.equal(fix("alan au plus"), "à 1 an au plus");
  assert.equal(fix("1aSans"), "1 à 5 ans");
  assert.equal(fix("Rèalement ANC 2022-06"), "Règlement ANC 2022-06");
  assert.equal(fix("(ébis)"), "(6bis)");
  assert.equal(fix("Sans objet"), "Sans objet");
  assert.equal(fix("TOTAL (Dont"), "TOTAL (Dont");
});

test("Excel d'un scan : titre sur deux lignes, bords d'une case de date, année du formulaire", async () => {
  const d = await PDFLib.PDFDocument.create();
  d.addPage([595, 842]);
  const word = (text, x0, y0, x1, h = 12) => ({ text, bbox: { x0, y0, x1, y1: y0 + h } });
  const words = [word("DGFiP", 400, 40, 440), word("N°", 445, 40, 460), word("2051", 465, 40, 495), word("2025", 520, 40, 550),
    word("Matériels", 300, 80, 350, 10), word("et", 355, 80, 365, 10), word("outillages", 305, 82, 360, 16),
    word("1", 280, 110, 283), word("31/12/2025", 300, 110, 360), word("1", 375, 110, 378),
    word("Clients", 50, 140, 90), word("1", 330, 140, 336), word("234", 340, 140, 370)];
  const rows = core.extractRows(await core.addOcrLayer(await d.save(), [{ index: 0, zoom: 1, words }]))[0].map(r => r.cells.map(c => c.text));
  assert.ok(rows.some(r => r.includes("DGFiP N° 2051 2025")), JSON.stringify(rows));
  assert.ok(rows.some(r => r.includes("Matériels et outillages")), JSON.stringify(rows));
  assert.ok(rows.some(r => r.join() === "31/12/2025"), JSON.stringify(rows));
});

// Comptes annuels d'un logiciel comptable et liasse fiscale en police à chasse fixe : repères invisibles,
// titres de colonnes sur deux lignes, montants et codes collés, libellé sur deux lignes autour des montants.
async function liasse() {
  const d = await PDFLib.PDFDocument.create();
  const font = await d.embedFont(PDFLib.StandardFonts.Courier);
  const page = d.addPage([595, 842]);
  const put = (t, x, y, size = 6) => page.drawText(t, { x, y, size, font });
  const right = (t, end, y, size = 7.5) => put(t, end - font.widthOfTextAtSize(t, size), y, size);
  put("findPageTitleBilanfindPageTitleEnd", 40, 820, 0.8);
  put("Désignation de l'entreprise : AGIR PREVENTION ET SECURITE.M - SIREN : 501963698", 40, 800);
  put("Exercice", 40, 812); put("2025", 480, 812);
  put("Variation", 400, 772, 7.5); put("Postes", 40, 764, 7.5); put("Net 2025", 250, 764, 7.5); put("Net 2024", 320, 764, 7.5);
  put("(€)", 410, 756, 7.5); put("(%)", 480, 764, 7.5);
  put("Résultat", 40, 740, 7.5); right("2 000", 300, 740); right("41 979", 370, 740); right("-39 979 -113", 500, 740);
  put("Brut", 268, 712);
  [["Terrains", "KG", "0 KH", "0"], ["Matériel de transport", "KY", "4 724 KZ", "923"]].forEach(([label, code, mid, last], i) => {
    const y = 700 - i * 14;
    put(label, 40, y); put(code, 250, y, 7.5); right("0", 300, y); put(mid, 330, y, 7.5); right(last, 400, y);
  });
  put("Installations gales., agencts. et", 40, 663.5); put("aménag.", 40, 656.5);
  put("S5", 250, 660, 7.5); right("12", 300, 660); put("S6", 330, 660, 7.5); right("0", 400, 660);
  // Case cochée, et libellé sur deux lignes dans un formulaire en deux colonnes.
  put("Régime réel normal", 40, 630); put("X", 300, 630);
  put("Report à nouveau de l'exercice", 40, 613.5); put("antérieur", 40, 606.5);
  put("ØC", 235, 610, 7.5); right("-108 360", 300, 610); put("Affectations aux réserves", 330, 610);
  return d.save();
}

test("Excel : comptes annuels et liasse fiscale en texte natif", async () => {
  const wb = XLSX.read(core.toXlsx(XLSX, core.extractRows(await liasse())), { cellNF: true });
  const sheet = wb.Sheets["Page 1"];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }).map(r => Array.from(r, v => v ?? ""));
  const all = rows.flat();
  assert.ok(!all.some(v => /findPage/.test(v)), "repère invisible écarté");
  // Une seule espace entre deux mots, même large (chasse fixe) : une seule case, le SIREN reste du texte.
  assert.ok(all.some(v => /: AGIR PREVENTION ET SECURITE\.M - SIREN : 501963698$/.test(v)), JSON.stringify(rows));
  const head = rows.find(r => r.includes("Postes"));
  assert.ok(head.includes("Variation (€)") && head.includes("(%)"), JSON.stringify(head));
  const year = head.indexOf("Net 2025");
  assert.ok(year > 0);
  const row = label => rows.find(r => r[0] === label);
  // « -39 979 -113 » : deux montants, sous « Variation (€) » et « (%) ».
  const result = row("Résultat");
  assert.deepEqual(result.filter(v => v !== ""), ["Résultat", 2000, 41979, -39979, -113]);
  assert.equal(result.indexOf(-39979), head.indexOf("Variation (€)"));
  assert.equal(result.indexOf(-113), head.indexOf("(%)"));
  // Une année reste écrite 2025, sans séparateur des milliers.
  const exercice = rows.find(r => r[0] === "Exercice");
  assert.equal(sheet[XLSX.utils.encode_cell({ r: rows.indexOf(exercice), c: exercice.indexOf(2025) })].z, "0");
  assert.deepEqual(row("Terrains").filter(v => v !== ""), ["Terrains", "KG", 0, 0, "KH", 0]);
  assert.deepEqual(row("Matériel de transport").filter(v => v !== ""), ["Matériel de transport", "KY", 0, 4724, "KZ", 923]);
  const inst = row("Installations gales., agencts. et aménag.");
  assert.deepEqual(inst?.filter(v => v !== ""), ["Installations gales., agencts. et aménag.", "S5", 12, "S6", 0], JSON.stringify(rows));
  assert.deepEqual(row("Régime réel normal").filter(v => v !== ""), ["Régime réel normal", "X"]);
  assert.deepEqual(row("Report à nouveau de l'exercice antérieur")?.filter(v => v !== ""),
    ["Report à nouveau de l'exercice antérieur", "ØC", -108360, "Affectations aux réserves"], JSON.stringify(rows));
  // « Brut », centré au-dessus de la paire code + montant, est rangé au-dessus du montant.
  const brut = rows.find(r => r.includes("Brut"));
  assert.equal(brut.indexOf("Brut"), row("Terrains").indexOf(0));
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

test("Excel d'un tableau encadré : seul le contenu de la zone est exporté", () => {
  // Le tableau de la facture occupe x 72-532, y 140-236 (points tels qu'affichés).
  const pages = core.extractRows(facture(), { page: 0, rect: [532, 236, 70, 138] });
  assert.equal(pages.length, 1);
  const wb = XLSX.read(core.toXlsx(XLSX, pages));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets["Page 1"], { header: 1 });
  assert.deepEqual(rows[0], ["Article", "Quantité", "Prix unitaire", "Total"]);
  assert.deepEqual(rows[1], ["Papier A4", 10, 4.5, 45]);
  assert.equal(rows.length, 4);
  assert.doesNotMatch(JSON.stringify(rows), /Facture|Dupont|Total à payer/);
  assert.deepEqual(core.extractRows(facture(), { page: 0, rect: [300, 600, 400, 700] }), [[]]);
});

test("texte du document pour Copilot : une partie par page, cases séparées", () => {
  const t = core.documentText(core.extractRows(facture()));
  assert.match(t, /^--- Page 1 ---\nFacture n° 2026-042/);
  assert.match(t, /Papier A4 \| 10 \| 4,50 \| 45,00/);
});

test("découper par signets : une partie par signet choisi", () => {
  const outline = [{ title: "---------- BILAN ----------", page: 2, level: 0 }, { title: "Bilan Actif", page: 2, level: 1 },
                   { title: "Bilan Passif", page: 4, level: 1 }, { title: "Annexe", page: 9, level: 0 }, { title: "Lien", page: -1, level: 0 }];
  assert.deepEqual(core.bookmarkParts(outline, 12, [0, 3]),
    [{ title: "Début", from: 0, to: 1 }, { title: "BILAN", from: 2, to: 8 }, { title: "Annexe", from: 9, to: 11 }]);
  assert.deepEqual(core.bookmarkParts(outline, 12).map(p => [p.title, p.from, p.to]),
    [["Début", 0, 1], ["BILAN - Bilan Actif", 2, 3], ["Bilan Passif", 4, 8], ["Annexe", 9, 11]]);
  assert.deepEqual(core.bookmarkParts([], 3), []);
  assert.equal(core.fileName('01 - Bilan: "actif"?'), "01 - Bilan actif");
});

test("archive ZIP lisible : noms accentués, contenus intacts", () => {
  const files = [{ name: "01 - Début.pdf", bytes: facture() }, { name: "02 - Été.txt", bytes: new TextEncoder().encode("bonjour") }];
  const z = core.zip(files), v = new DataView(z.buffer, z.byteOffset);
  assert.equal(v.getUint32(0, true), 0x04034b50);
  const end = z.length - 22;
  assert.equal(v.getUint32(end, true), 0x06054b50);
  assert.equal(v.getUint16(end + 10, true), 2);
  // Relit chaque fichier depuis le répertoire central.
  let at = v.getUint32(end + 16, true);
  for (const f of files) {
    assert.equal(v.getUint32(at, true), 0x02014b50);
    const n = v.getUint16(at + 28, true), size = v.getUint32(at + 24, true), local = v.getUint32(at + 42, true);
    assert.equal(new TextDecoder().decode(z.subarray(at + 46, at + 46 + n)), f.name);
    const ln = v.getUint16(local + 26, true);
    assert.deepEqual(z.subarray(local + 30 + ln, local + 30 + ln + size), f.bytes);
    at += 46 + n;
  }
});

test("bandeau des signatures : intacte, ajouts, modifiée, format inconnu", () => {
  const s = { name: "DocuSign", date: "2026-03-12T10:00:00.000Z", intact: true, covers: true };
  assert.deepEqual(core.signatureSummary([s]), { level: "ok", text: "Signé électroniquement par DocuSign le 12/03/2026 : document intact." });
  assert.match(core.signatureSummary([{ ...s, covers: false }]).text, /commentaires ont été ajoutés/);
  assert.equal(core.signatureSummary([{ ...s, intact: false }]).level, "bad");
  assert.equal(core.signatureSummary([{ ...s, intact: null }]).level, "warn");
  assert.equal(core.signatureSummary([]).level, "warn");
});

test("résumé rapide : phrases clés, montants et dates", () => {
  const text = "--- Page 1 ---\nContrat de maintenance informatique entre la société Alpha et la société Beta.\n" +
    "Le contrat de maintenance couvre les serveurs et les postes de la société Beta pendant trois ans.\n" +
    "Montant annuel | 12 500,00 €\nDate de signature | 15/03/2026\n\n--- Page 2 ---\n" +
    "La société Alpha intervient sous quatre heures en cas de panne des serveurs couverts par le contrat.\n" +
    "Le paiement est dû à trente jours, faute de quoi des pénalités de retard sont appliquées.";
  const r = core.quickSummary(text, 3);
  assert.equal(r.points.length, 3);
  assert.ok(r.points.every(p => text.includes(p)));
  assert.ok(r.figures.includes("Montant annuel 12 500,00 €"));
  assert.ok(r.figures.includes("Date de signature 15/03/2026"));
  assert.match(core.summaryText(r), /^Points clés :\n• /);
  assert.deepEqual(core.quickSummary(""), { points: [], figures: [] });
});

test("morceaux pour le modèle : coupés entre les pages, jamais trop longs", () => {
  const page = n => `--- Page ${n} ---\n` + "ligne de texte assez longue pour remplir\n".repeat(40);
  const text = [1, 2, 3, 4].map(page).join("\n\n");
  const chunks = core.summaryChunks(text, 3500);
  assert.ok(chunks.length >= 2 && chunks.every(c => c.length <= 3500));
  assert.ok(chunks.every(c => c.startsWith("--- Page")));
  assert.equal(chunks.join("\n\n").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
  const one = core.summaryMessages("Facture", "texte");
  assert.equal(one[0].role, "system"); assert.match(one[1].content, /objet du document/);
  assert.match(core.summaryMessages("Facture", "texte", 2, 3)[1].content, /partie 2 sur 3/);
  assert.match(core.finalMessages("Facture", ["a", "b"])[1].content, /Partie 2 :\nb/);
});

test("résumé IA : plan de repli et nature des erreurs du moteur", () => {
  assert.deepEqual(core.aiPlan("webgpu"), [["webgpu", 1], ["webgpu", 0.5], ["wasm", 1], ["wasm", 0.5]]);
  assert.deepEqual(core.aiPlan("wasm"), [["wasm", 1], ["wasm", 0.5]]);
  assert.equal(core.aiErrorKind(new Error("failed to call OrtRun(). ERROR_CODE: 6, ERROR_MESSAGE: std::bad_alloc")), "oom");
  assert.equal(core.aiErrorKind(new RangeError("Array buffer allocation failed")), "oom");
  assert.equal(core.aiErrorKind(new Error("table index is out of bounds")), "crash");
  assert.equal(core.aiErrorKind(new Error("memory access out of bounds")), "crash");
  assert.equal(core.aiErrorKind(Object.assign(new Error("unreachable"), { name: "RuntimeError" })), "crash");
  assert.equal(core.aiErrorKind(new Error("Could not locate file")), "other");
  const plan = core.aiPlan("webgpu");
  assert.equal(core.nextAttempt(plan, 0, "oom"), 1);
  assert.equal(core.nextAttempt(plan, 1, "crash"), 2);       // moteur tombé : on continue le plan, avec un moteur neuf
  assert.equal(core.nextAttempt(plan, 0, "other"), 2);       // carte graphique en panne : droit au processeur
  assert.equal(core.nextAttempt(plan, 2, "other"), -1);      // déjà sur le processeur : on abandonne
  assert.equal(core.nextAttempt(plan, 3, "oom"), -1);
  assert.equal(core.nextAttempt(core.aiPlan("wasm"), 0, "crash"), 1);
});

// ------------------------------------------------------------ traduction

test("langue détectée : anglais, allemand, espagnol, chinois, français et autres", () => {
  assert.equal(core.detectLanguage("The sales of the year are in line with the budget for this market."), "en");
  assert.equal(core.detectLanguage("Die Umsätze des Jahres sind im Rahmen des Budgets für diesen Markt."), "de");
  assert.equal(core.detectLanguage("Las ventas del año están en línea con el presupuesto para este mercado."), "es");
  assert.equal(core.detectLanguage("今年的销售额符合该市场的预算。"), "zh");
  assert.equal(core.detectLanguage("Les ventes de l'année sont conformes au budget pour ce marché."), "fr");
  assert.equal(core.detectLanguage("1 678 2 260"), null);
  assert.equal(core.detectLanguage("ارتفعت المبيعات هذا العام بنسبة عشرة بالمئة."), "ar");
  assert.equal(core.detectLanguage("Продажи за год соответствуют бюджету для этого рынка."), "ru");
  assert.equal(core.detectLanguage("Продажі за рік відповідають бюджету для цього ринку."), "uk");
  assert.equal(core.detectLanguage("今年の売上は予算に沿っています。"), "ja");
  assert.equal(core.detectLanguage("올해 매출은 예산에 부합합니다."), "ko");
  assert.equal(core.detectLanguage("Le vendite dell'anno sono in linea con il budget per questo mercato."), "it");
  assert.equal(core.detectLanguage("As vendas do ano estão em linha com o orçamento para este mercado."), "pt");
  assert.equal(core.detectLanguage("Sprzedaż w tym roku jest zgodna z budżetem dla tego rynku."), "pl");
  assert.equal(core.detectLanguage("Bu yılın satışları bu pazar için bütçeye uygundur."), "tr");
});

test("route de traduction : modèle direct, sinon via l'anglais (ROMANCE, mul)", () => {
  const models = r => r.map(x => x.model.replace("Xenova/opus-mt-", "") + (x.prefix ? ` ${x.prefix}` : ""));
  assert.deepEqual(models(core.translationRoute("en", "fr")), ["en-fr"]);
  assert.deepEqual(models(core.translationRoute("de", "es")), ["de-es"]);
  assert.deepEqual(models(core.translationRoute("ar", "zh")), ["ar-en", "en-zh >>cmn_Hans<<"]);
  assert.deepEqual(models(core.translationRoute("en", "zh-TW")), ["en-zh >>cmn_Hant<<"]);
  assert.deepEqual(models(core.translationRoute("ja", "fr")), ["ja-en", "en-fr"]);
  assert.deepEqual(models(core.translationRoute("pt", "fr")), ["ROMANCE-en", "en-fr"]);
  assert.deepEqual(models(core.translationRoute("fr", "pt")), ["fr-en", "en-ROMANCE >>pt<<"]);
  assert.deepEqual(models(core.translationRoute("en", "pl")), ["en-mul >>pol<<"]);
  assert.deepEqual(models(core.translationRoute("tr", "en")), ["tr-en"]);
  assert.throws(() => core.translationRoute("fr", "fr"));
  const codes = Object.keys(core.LANGUAGES);
  assert.ok(codes.length >= 80);
  for (const a of codes) for (const b of codes) if (a !== b) assert.ok(core.translationRoute(a, b).length <= 2, `${a} ${b}`);
  assert.equal(core.routeSize(core.translationRoute("ar", "zh")), 200);
  assert.equal(core.routeSize(core.translationRoute("ar", "zh"), new Set(["Xenova/opus-mt-ar-en"])), 100);
});

test("sigles et nombres protégés, contrôle par traduction inverse", () => {
  assert.deepEqual(core.protectedTokens("4,46 ME Budget including BASF US tariff of 12%"), ["4,46", "ME", "BASF", "US", "12%"]);
  assert.deepEqual(core.protectedTokens("GENERAL KPIs"), ["KPIs"]);
  assert.deepEqual(core.protectedTokens("The customers are represented"), []);
  assert.ok(core.roundTrip("Carry forward", "Carry forward"));
  assert.ok(core.roundTrip("Top 15 customers", "Top 15 clients"));
  assert.ok(!core.roundTrip("THEMIS", "The themes"));
  assert.ok(!core.roundTrip("OMV", "The products of production"));
  assert.ok(core.roundTrip("1 678", "1 678"));
});

test("traduction : sigle perdu retraduit par morceaux, texte court douteux gardé", async () => {
  const pages = [[{ text: "Budget of BASF US for 2026" }, { text: "THEMIS" }, { text: "Customers" }]];
  const calls = [];
  const engine = {
    translate: async list => { calls.push([...list]); return list.map(t => ({
      "Budget of BASF US for 2026": "Budget de la société pour 2026",   // sigle disparu : on retraduit par morceaux
      "Budget of": "Budget de", "for": "pour", "THEMIS": "Les thèmes", "Customers": "Clients" })[t] ?? t); },
    reverse: async list => list.map(t => ({ "Les thèmes": "The themes", "Clients": "Customers" })[t] ?? t),
  };
  const done = await core.translateSegments(pages, engine);
  assert.equal(done[0][0].fr, "Budget de BASF US pour 2026");
  assert.equal(done[0][1].fr, "THEMIS");          // la traduction inverse ne retrouve pas le mot : original gardé
  assert.equal(done[0][2].fr, "Clients");
  assert.ok(calls.some(c => c.includes("Budget of")));
  // Titre en majuscules : ses sigles restent en majuscules dans le texte envoyé au modèle.
  const [[caps]] = await core.translateSegments([[{ text: "BASF US SALES" }]], async list => { calls.push([...list]); return list.map(t => t.replace("Basf", "Basf").replace("sales", "ventes")); });
  assert.ok(calls.at(-1).includes("Basf US sales"), JSON.stringify(calls.at(-1)));
  assert.equal(caps.fr, "BASF US VENTES");
});

test("paragraphe sur plusieurs lignes et puces regroupés pour la traduction", async () => {
  const doc = await PDFLib.PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const lines = ["Cash spent this year includes the carry forward of the", "previous year and the new investments approved by the", "board in March."];
  lines.forEach((l, k) => page.drawText(l, { x: 60, y: 700 - k * 12, size: 10, font }));
  page.drawText("•", { x: 45, y: 650, size: 10, font });
  page.drawText("First point of the list", { x: 60, y: 650, size: 10, font });
  page.drawText("•", { x: 45, y: 636, size: 10, font });
  page.drawText("Second point of the list", { x: 60, y: 636, size: 10, font });
  const pages = core.translationSegments(await doc.save());
  const texts = pages[0].map(s => s.text);
  assert.deepEqual(texts, [lines.join(" "), "First point of the list", "Second point of the list"]);
  assert.equal(pages[0][0].lines.length, 3);
});

test("écriture non latine dessinée par le navigateur (draw) et posée en image", async () => {
  const bytes = await englishPdf();
  const pages = core.translationSegments(bytes);
  const done = pages.map(list => list.map(s => ({ ...s, fr: s.text === "Sales" ? "Продажи" : s.text })));
  const asked = [];
  const png = await (async () => { const d = await PDFLib.PDFDocument.create(); const p = d.addPage([10, 10]); p.drawRectangle({ x: 0, y: 0, width: 10, height: 10 }); return core.pageImage(core.openMu(await d.save()), 0, { dpi: 72 }); })();
  const out = await core.applyTranslation(bytes, done, { draw: async (text, box) => { asked.push([text, box]); return { png, width: box.width, height: box.height }; } });
  assert.equal(asked.length, 1);
  assert.equal(asked[0][0], "Продажи");
  assert.ok(asked[0][1].width > 0 && asked[0][1].size === 10);
  const result = text(out);
  assert.doesNotMatch(result, /Sales/);
  assert.match(result, /SITUATION BANCAIRE|BANK SITUATION/);
  assert.ok(core.pageInfo(out)[0].hasText !== undefined);
});

test("seuls les vrais mots sont à traduire", () => {
  assert.ok(core.translatable("Total sales"));
  assert.ok(core.translatable("销售"));
  assert.ok(!core.translatable("1 678,50 €"));
  assert.ok(!core.translatable("31/12/2025"));
  assert.ok(!core.translatable("Q1"));
});

async function englishPdf() {
  const doc = await PDFLib.PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
  page.drawText("BANK SITUATION", { x: 50, y: 780, size: 18, font: bold, color: PDFLib.rgb(0.1, 0.1, 0.5) });
  page.drawText("Sales", { x: 50, y: 700, size: 10, font });
  page.drawText("1 678", { x: 300, y: 700, size: 10, font });
  page.drawText("The customers in the Middle East are strongly represented and", { x: 50, y: 650, size: 10, font });
  page.drawText("their orders are expected to grow next year.", { x: 50, y: 638, size: 10, font });
  page.drawText("accord-enveloppe BPI du 29/10/26", { x: 50, y: 600, size: 10, font });
  return doc.save();
}

test("traduire un PDF : même place, nombres et passages en français gardés", async () => {
  const bytes = await englishPdf();
  const pages = core.translationSegments(bytes);
  const texts = pages[0].map(s => s.text);
  assert.deepEqual(texts, ["BANK SITUATION", "Sales",
    "The customers in the Middle East are strongly represented and their orders are expected to grow next year."]);
  const dico = { "Bank situation": "Situation bancaire", "Sales": "Ventes",
    "The customers in the Middle East are strongly represented and their orders are expected to grow next year.":
      "Les clients du Moyen-Orient sont fortement représentés et leurs commandes devraient augmenter l'année prochaine." };
  const seen = [];
  const done = await core.translateSegments(pages, async list => { seen.push(...list); return list.map(t => dico[t]); });
  assert.deepEqual(seen.sort(), Object.keys(dico).sort());          // titre en MAJUSCULES envoyé en minuscules
  assert.equal(done[0][0].fr, "SITUATION BANCAIRE");
  const out = await core.applyTranslation(bytes, done);
  const result = text(out);
  assert.match(result, /SITUATION BANCAIRE/);
  assert.match(result, /Ventes/);
  assert.match(result, /1 678/);
  assert.match(result, /accord-enveloppe BPI du 29\/10\/26/);
  assert.match(result, /Moyen-Orient/);
  assert.doesNotMatch(result, /BANK|Sales|customers/);
  // Le paragraphe traduit reste dans sa zone d'origine : même marge gauche, sous le titre, au-dessus de la suite.
  const mu = core.openMu(out);
  const [[start]] = core.search(mu, 0, "Les clients");
  const [[end]] = core.search(mu, 0, "prochaine");
  const [[next]] = core.search(mu, 0, "accord-enveloppe");
  mu.destroy();
  assert.ok(Math.abs(start[0] - 50) < 1, String(start));
  assert.ok(start[1] > 842 - 665 && end[3] < next[1], `${start} ${end} ${next}`);
});

test("défauts des modèles de traduction corrigés", () => {
  assert.equal(core.cleanTranslation("Kunden", "Clientsssssss"), "Clients");
  assert.equal(core.cleanTranslation("x", "Les recettes sont comprises dans le budget.."), "Les recettes sont comprises dans le budget.");
  assert.equal(core.cleanTranslation("Sales", "Ventes ".repeat(30)), "Sales");
  assert.equal(core.cleanTranslation("Etc", "Et ainsi de suite..."), "Et ainsi de suite...");
  assert.equal(core.cleanTranslation("Sales", ""), "Sales");
  assert.equal(core.cleanTranslation("Defense", "Défense"), "Défense");        // vraie traduction, accents compris
  assert.equal(core.cleanTranslation("Total", "Total général"), "Total");       // mot seul allongé
  assert.equal(core.cleanTranslation("Loan", "Prêt"), "Prêt");
  // Racines comparées souplement par la traduction inverse.
  assert.ok(core.roundTrip("Rate", "Rates"));
  assert.ok(core.roundTrip("Ending", "End"));
  assert.ok(core.roundTrip("Sales Evolution", "Evolution of sales"));
  assert.ok(!core.roundTrip("Sabic", "Sabique"));
});

test("traduction : noms propres déformés repris sous un nom d'emprunt", async () => {
  const pages = [[{ text: "Strong Framatome impact expected" }, { text: "Paralloy/Manoir Group USA" }, { text: "THEMIS" },
                  { text: "Framatome shareholding (30%)" }, { text: "Sales drop compared to 2025" }, { text: "Integration of the Paralloy network" }]];
  assert.deepEqual(core.properNouns("Strong Framatome impact expected"), ["Framatome"]);
  assert.deepEqual(core.properNouns("Framatome shareholding (30%)"), []);
  assert.deepEqual(core.properNouns("Framatome shareholding (30%)", new Set(["Framatome"])), ["Framatome"]);
  const calls = [];
  const dico = {
    "Strong Framatome impact expected": "Fort impact du Fram-Bat attendu",
    "Strong Renault impact expected": "Fort impact de Renault attendu",
    "Paralloy/Manoir Group USA": "Groupe Paralliage/Manoir USA",
    "Renault/Manoir Group USA": "Groupe Renault/Manoir USA",
    "Framatome shareholding (30%)": "Part de Fram-Bat (30%)",
    "Renault shareholding (30%)": "Participation de Renault (30%)",
    "Sales drop compared to 2025": "Baisse des ventes par rapport à 2025",
    "Themis": "Thémis", "Integration of the Paralloy network": "Intégration du réseau Paralloy",
  };
  const back = { "Fort impact du Fram-Bat attendu": "Strong Fram-Bat impact expected", "Groupe Paralliage/Manoir USA": "Paralliage/Manoir Group USA",
                 "Part de Fram-Bat (30%)": "Share of Fram-Bat (30%)", "Baisse des ventes par rapport à 2025": "Sales drop compared to 2025", "Thémis": "Themis" };
  const engine = { translate: async list => { calls.push(...list); return list.map(t => dico[t] ?? t); },
                   reverse: async list => list.map(t => back[t] ?? t) };
  const [done] = await core.translateSegments(pages, engine);
  assert.equal(done[0].fr, "Fort impact du Framatome attendu");         // « Fram-Bat » remis d'aplomb sur place
  assert.equal(done[1].fr, "Groupe Paralloy/Manoir USA");
  assert.equal(done[2].fr, "THEMIS");                                    // titre en majuscules rendu au mot près
  assert.equal(done[3].fr, "Part de Framatome (30%)");                   // en tête de phrase, mais connu du document
  assert.equal(done[4].fr, "Baisse des ventes par rapport à 2025");      // mot courant : pas de nom d'emprunt
  assert.ok(!calls.some(c => /Renault.*drop/.test(c)));
});

test("traduction : « & » remplacé par le mot, intitulé recopié retraduit en minuscules", async () => {
  const dico = { "Context and Assumptions": "Contexte et hypothèses", "Ending": "Ending", "ending": "fin",
                 "Historical view": "Historical view", "historical view": "vue historique",
                 "Baker Hughes": "Baker Hughes", "baker hughes": "boulanger hughes", "BASF US": "BASF US" };
  const seen = [];
  const engine = async list => { seen.push(...list); return list.map(t => dico[t] ?? t); };
  const [done] = await core.translateSegments([["Context & Assumptions", "Ending", "Historical view", "Baker Hughes", "BASF US"].map(text => ({ text }))], engine, { amp: "and" });
  // Un nom en Majuscules Initiales recopié par le modèle (« Baker Hughes ») n'est pas réessayé en minuscules.
  assert.deepEqual(done.map(s => s.fr), ["Contexte et hypothèses", "Fin", "Vue historique", "Baker Hughes", "BASF US"]);
  assert.ok(!seen.includes("basf us") && !seen.includes("baker hughes"), "sigle et nom ne sont pas réessayés en minuscules");
  assert.equal(core.AMPERSAND.en, "and");
});

test("traduction : contrôle inverse assoupli, seconde chance en minuscules, nom déformé gardé", async () => {
  const dico = { "Sales Evolution": "Évolution des ventes", "in progress": "en cours", "Context and Assumptions": "Contexte et acomptes",
                 "context and assumptions": "contexte et hypothèses", "Sabic": "Sabique", "sabic": "sabique", "Energy": "Énergie",
                 "Ending": "Fin de la procédure", "ending": "fin", "Loans and Stakholders": "Prêts et détenteurs de titres" };
  const back = { "Évolution des ventes": "Sales trends", "en cours": "ongoing", "Contexte et acomptes": "Context and deposits",
                 "Contexte et hypothèses": "Context and assumptions", "Sabique": "Sabica", "Énergie": "Energy", "Fin": "End",
                 "Prêts et détenteurs de titres": "Loans and securities holders" };
  const engine = { translate: async list => list.map(t => dico[t] ?? t), reverse: async list => list.map(t => back[t] ?? t) };
  const texts = ["Sales Evolution", "in progress", "Context & Assumptions", "SABIC", "ENERGY", "Ending", "Loans and Stakholders"];
  const [done] = await core.translateSegments([texts.map(text => ({ text }))], engine, { amp: "and" });
  assert.deepEqual(done.map(s => s.fr), ["Évolution des ventes", "en cours", "Contexte et hypothèses", "SABIC", "ÉNERGIE", "Fin", "Prêts et détenteurs de titres"]);
  // Le retour ramène « Sabique » à « Sabic » : seul le découpage en sous-mots révèle le nom inconnu du modèle.
  const back2 = { ...back, "Sabique": "Sabic" };
  const pieces = w => ({ sabic: 2, energy: 1 })[w] ?? 1;
  const [done2] = await core.translateSegments([["SABIC", "ENERGY"].map(text => ({ text }))], { ...engine, reverse: async list => list.map(t => back2[t] ?? t), pieces });
  assert.deepEqual(done2.map(s => s.fr), ["SABIC", "ÉNERGIE"]);
});

test("lignes d'une liste aérée séparées, nombre en fin de phrase et « A » initial regroupés", async () => {
  const doc = await PDFLib.PDFDocument.create();
  const page = doc.addPage([842, 595]);
  const font = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
  // Sommaire : intitulés courts, interligne double -> un morceau chacun.
  ["BANK SITUATION", "CONTEXT & ASSUMPTIONS", "SALES", "CAPEX"].forEach((t, k) => page.drawText(t, { x: 225, y: 500 - k * 30, size: 16, font }));
  // Phrase coupée dont la dernière ligne n'est qu'un nombre.
  page.drawText("•", { x: 500, y: 300, size: 16, font });
  page.drawText("Expected recovery of the market end of", { x: 518, y: 300, size: 16, font });
  page.drawText("2026", { x: 518, y: 281, size: 16, font });
  // Texte étroit, un mot par ligne, commençant par « A ».
  page.drawText("A", { x: 40, y: 200, size: 16, font });
  page.drawText("portfolio", { x: 65, y: 200, size: 16, font });
  page.drawText("equally split between the", { x: 40, y: 181, size: 16, font });
  page.drawText("different areas", { x: 40, y: 162, size: 16, font });
  const texts = core.translationSegments(await doc.save())[0].map(s => s.text);
  assert.deepEqual(texts, ["BANK SITUATION", "CONTEXT & ASSUMPTIONS", "SALES", "CAPEX",
    "Expected recovery of the market end of 2026", "A portfolio equally split between the different areas"]);
  const segs = core.translationSegments(await doc.save())[0];
  assert.equal(segs[4].lines.length, 2);
});

// ------------------------------------------------------------ faire signer à plusieurs

const tinyPng = () => {   // signature dessinée : une image PNG de 4 × 2 pixels
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAEUlEQVR4nGNgYGD4z8DAwMAAAA0AAWo9ZFkAAAAASUVORK5CYII=";
  return { png: Uint8Array.from(Buffer.from(b64, "base64")), w: 4, h: 2 };
};

test("demande de signature : préparer, envoyer, deux signataires dans l'ordre, journal scellé", async () => {
  const page = core.pageInfo(facture())[0];
  let req = core.newRequest({ title: "Contrat", sender: { name: "Damien", email: "damien@exemple.fr" },
    signers: [{ name: "Paul Martin", email: "paul@exemple.fr" }, { name: "Léa Petit", email: "lea@exemple.fr" }] });
  const [paul, lea] = req.signers;
  assert.notEqual(paul.color, lea.color);
  assert.deepEqual(core.requestProblems(req), ["placez au moins une case pour Paul Martin", "placez au moins une case pour Léa Petit"]);
  const sigPaul = core.addRequestField(req, { signer: paul.id, type: "signature", page: 0, at: [150, 650], size: page });
  core.addRequestField(req, { signer: paul.id, type: "date", page: 0, at: [150, 700], size: page });
  core.addRequestField(req, { signer: lea.id, type: "text", page: 0, at: [400, 650], size: page, label: "Fonction" });
  core.addRequestField(req, { signer: lea.id, type: "checkbox", page: 0, at: [400, 700], size: page, label: "J'accepte" });
  const sigLea = core.addRequestField(req, { signer: lea.id, type: "initials", page: 0, at: [590, 835], size: page });
  assert.ok(sigLea.rect[2] <= page.w && sigLea.rect[3] <= page.h, "case gardée dans la page");
  assert.deepEqual(core.requestProblems(req), []);

  // La demande voyage dans le PDF.
  let bytes = core.writeRequest(facture(), req);
  assert.deepEqual(core.readRequest(bytes), req);
  assert.equal(core.readRequest(facture()), null);
  assert.equal(core.requestStatus(req).text, "Demande en préparation (pas encore envoyée).");
  assert.equal(core.canSign(req, paul.id).ok, false);

  // Envoi : sceau de l'expéditeur.
  ({ bytes, request: req } = await core.sendRequest(forge, bytes, req, { bits: 1024 }));
  assert.equal(core.readRequest(bytes).events[0].type, "sent");
  assert.match(req.events[0].hash, /^[0-9a-f]{64}$/);
  assert.ok(core.isSigned(bytes));
  assert.equal(core.requestStatus(req).text, "Personne n'a encore signé (0 sur 2). Prochain : Paul Martin.");
  assert.match(core.canSign(req, lea.id).reason, /d'abord à Paul Martin/);

  // Paul remplit ses cases (la date se remplit seule) puis termine.
  const sent = bytes;
  await assert.rejects(core.completeSigner(forge, bytes, req, paul.id, { bits: 1024 }), /il reste 2 cases/);
  ({ bytes, request: req } = core.fillRequestField(bytes, req, sigPaul.id, tinyPng()));
  const datePaul = req.fields.find(f => f.signer === paul.id && f.type === "date");
  ({ bytes, request: req } = core.fillRequestField(bytes, req, datePaul.id, null, new Date(2026, 10, 5)));
  assert.ok(core.keepsOriginal(sent, bytes), "remplir ne touche pas au document scellé");
  assert.equal(core.pendingFields(req, paul.id).length, 0);
  ({ bytes, request: req } = await core.completeSigner(forge, bytes, req, paul.id, { bits: 1024, received: "abc" }));
  // Un ajout hors de ses cases avant le sceau de Paul serait signalé.
  {
    let b2 = core.annotate(sent, 0, { kind: "textbox", rect: [300, 100, 400, 120], text: "Remise 50 %" }), r2 = core.readRequest(sent);
    ({ bytes: b2, request: r2 } = core.fillRequestField(b2, r2, sigPaul.id, tinyPng()));
    ({ bytes: b2, request: r2 } = core.fillRequestField(b2, r2, datePaul.id, null));
    ({ bytes: b2, request: r2 } = await core.completeSigner(forge, b2, r2, paul.id, { bits: 1024 }));
    assert.deepEqual(core.revisionProblems(forge, b2, r2), ["Paul Martin : un ajout en page 1 ne correspond à aucune de ses cases (texte)."]);
  }
  assert.equal(core.requestStatus(req).text, "1 sur 2 a signé. Prochain : Léa Petit.");
  const notes = b => core.listAnnotations(b).map(a => a.text).join("|");
  assert.match(notes(bytes), /05\/11\/2026/);

  // Léa : texte obligatoire, case cochée, paraphe.
  const [fn, box, ini] = req.fields.filter(f => f.signer === lea.id);
  assert.throws(() => core.fillRequestField(bytes, req, fn.id, "  "), /obligatoire/);
  ({ bytes, request: req } = core.fillRequestField(bytes, req, fn.id, "Gérante"));
  ({ bytes, request: req } = core.fillRequestField(bytes, req, box.id, true));
  ({ bytes, request: req } = core.fillRequestField(bytes, req, ini.id, tinyPng()));
  assert.match(notes(bytes), /Gérante\|X\|Paraphe/);
  const p12 = core.readCertificate(forge, testP12(), "1234");
  ({ bytes, request: req } = await core.completeSigner(forge, bytes, req, lea.id, { id: p12 }));
  const st = core.requestStatus(core.readRequest(bytes));
  assert.equal(st.complete, true);
  assert.equal(st.text, "Terminé : les 2 signataires ont signé.");
  assert.equal(st.signers[1].method, "certificat");

  // Contrôle : trois sceaux intacts (envoi, Paul, Léa) ; Léa avec son certificat.
  const check = core.checkRequest(forge, bytes, req);
  assert.deepEqual(check.steps.map(s => [s.name, s.sealed, s.intact]), [["Damien", true, true], ["Paul Martin", true, true], ["Léa Petit", true, true]]);
  assert.equal(check.steps[1].issuer, core.SEAL_ISSUER);
  assert.equal(check.steps[2].issuer, "Jeanne Martin");
  assert.equal(check.tampered, false);
  const sigs = core.signatures(forge, bytes);
  assert.equal(sigs.length, 3);
  assert.ok(sigs.every(s => s.intact));

  // Certificat d'achèvement ajouté en dernière page, et aucune retouche entre les sceaux.
  assert.equal(core.pageInfo(bytes).length, 2);
  const cert = text(bytes);
  assert.match(cert, /Certificat d'achèvement de la signature/);
  assert.match(cert, /Paul Martin <paul@exemple\.fr>/);
  assert.match(cert, /avec son certificat : Jeanne Martin/);
  assert.match(cert, new RegExp(req.events[0].hash));
  assert.deepEqual(core.revisionProblems(forge, bytes, req), []);
  // Un commentaire ajouté ensuite est signalé, sans gravité.
  const commented = core.annotate(bytes, 0, { kind: "note", at: [300, 300], text: "Vu" });
  assert.deepEqual(core.revisionProblems(forge, commented, req), ["1 commentaire ajouté après la dernière signature (le contenu signé n'a pas changé)."]);

  // Un octet du document envoyé modifié : le contrôle le voit.
  const bad = bytes.slice(), k = latin1(bytes).indexOf("Dupont");
  if (k > 0) bad[k] = 0x58; else bad[400] ^= 1;
  assert.equal(core.checkRequest(forge, bad, req).tampered, true);

  if (process.env.MIM_DEMANDE) (await import("node:fs")).writeFileSync(process.env.MIM_DEMANDE, bytes);
  // Une fois tout signé, plus personne ne peut signer.
  assert.equal(core.canSign(req, lea.id).ok, false);
});

test("demande de signature : message d'e-mail et lien mailto", () => {
  const req = core.newRequest({ title: "Bail", sender: { name: "Damien", email: "d@x.fr" }, signers: [{ name: "Paul", email: "paul@x.fr" }] });
  core.addRequestField(req, { signer: req.signers[0].id, type: "signature", page: 0, at: [100, 100] });
  const m = core.requestEmail(req, req.signers[0], { fileName: "Bail - à signer.pdf" });
  assert.equal(m.to, "paul@x.fr");
  assert.equal(m.subject, "Document à signer : Bail");
  assert.match(m.body, /Damien vous demande de signer le document « Bail » \(1 case à remplir\)/);
  assert.match(m.body, /lecteur-pdf-libre\.vercel\.app/);
  const url = core.mailtoUrl(m);
  assert.match(url, /^mailto:paul@x\.fr\?subject=Document%20%C3%A0%20signer/);
  assert.match(url, /%0D%0A/);
  const back = core.requestEmail(req, null, { fileName: "Bail - signé.pdf", toSender: true });
  assert.equal(back.to, "d@x.fr");
});

test("sceau Mim : nom accentué lisible, émetteur reconnu", () => {
  const id = core.sealIdentity(forge, { name: "Hélène Durand", email: "helene@exemple.fr" }, { bits: 1024 });
  const [sig] = core.signatures(forge, core.signPdf(forge, facture(), id, { reason: "essai" }));
  assert.equal(sig.name, "Hélène Durand");
  assert.equal(sig.issuer, core.SEAL_ISSUER);
  assert.equal(sig.intact, true);
});
