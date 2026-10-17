// Fabrique les deux factures d'exemple du site (une normale, une « scannée » sans texte).
import * as mupdf from "mupdf";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export async function makeExamples() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const text = (s, x, y, size = 11) => page.drawText(s, { x, y: 842 - y, size, font });
  text("Facture n° 2026-042", 72, 80, 20);
  text("Client : Société Dupont, 12 rue des Lilas, Rouen", 72, 110);
  const rows = [["Article", "Quantité", "Prix unitaire", "Total"], ["Papier A4", "10", "4,50", "45,00"],
                ["Stylos", "25", "1,20", "30,00"], ["Classeurs", "8", "3,75", "30,00"]];
  rows.forEach((r, i) => r.forEach((cell, j) => {
    page.drawRectangle({ x: 72 + 115 * j, y: 842 - 164 - 24 * i, width: 115, height: 24,
                         borderColor: rgb(0, 0, 0), borderWidth: 0.7 });
    text(cell, 77 + 115 * j, 156 + 24 * i);
  }));
  text("Total à payer : 105,00 €", 72, 260, 13);
  const facture = await pdf.save();

  const doc = mupdf.Document.openDocument(facture, "application/pdf");
  const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.scale(200 / 72, 200 / 72), mupdf.ColorSpace.DeviceGray, false);
  const scan = await PDFDocument.create();
  const img = await scan.embedJpg(pix.asJPEG(75));
  scan.addPage([595, 842]).drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  return { "facture.pdf": facture, "facture-scannee.pdf": await scan.save() };
}
