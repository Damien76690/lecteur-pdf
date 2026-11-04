// Essai de la traduction en français avec les vrais modèles (lancé par la CI) :
//   npm i --no-save @huggingface/transformers@4.3.1 && node scripts/essai-traduction.mjs
// Les modèles sont rangés dans modeles-traduction/ (même format que dans l'application).
import { pipeline, env } from "@huggingface/transformers";
import * as mupdf from "mupdf";
import * as PDFLib from "pdf-lib";
import * as core from "../web/core.js";

core.init({ mupdf, PDFLib });

env.cacheDir = "modeles-traduction";
const SAMPLES = {
  en: ["BANK SITUATION", "Top 15 Customers", "Middle East/Asia partners strongly represented",
       "The budget assumes a stable exchange rate and no new tariffs in the United States."],
  de: ["Die Umsätze des Jahres liegen im Rahmen des Budgets.", "Kunden", "Investitionen und Sicherheit"],
  es: ["Las ventas del año están en línea con el presupuesto.", "Clientes", "Situación bancaria"],
  zh: ["今年的销售额符合预算。", "客户", "银行贷款和现金流"],
};
let failed = false;
for (const [lang, texts] of Object.entries(SAMPLES)) {
  const chain = [];
  for (const id of core.TRANSLATION_MODELS[lang]) chain.push(await pipeline("translation", id, { dtype: "q8" }));
  const t0 = Date.now();
  const pages = [texts.map(text => ({ text }))];
  const done = await core.translateSegments(pages, async list => {
    let out = list;
    for (const run of chain) out = (await run(out, { max_new_tokens: 400 })).map(r => r.translation_text);
    return out;
  });
  console.log(`\n${core.LANGUAGES[lang]} (${Date.now() - t0} ms)`);
  for (const s of done[0]) console.log(`  ${s.text}  ->  ${s.fr}`);
  const all = done[0].map(s => s.fr).join(". ");
  const long = done[0][0].fr;
  if (core.detectLanguage(long) !== "fr" && core.detectLanguage(all) !== "fr") { failed = true; console.log(`  ÉCHEC : pas du français`); }
}
// De bout en bout : un PDF anglais façon présentation (titre, tableau, puces), traduit en PDF français.
const en = await (async () => {
  const doc = await PDFLib.PDFDocument.create();
  const page = doc.addPage([842, 595]);
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
  page.drawText("Budget 2026 – Sales PETRO", { x: 40, y: 540, size: 22, font });
  page.drawText("Top 15 Customers", { x: 40, y: 500, size: 15, font: bold });
  page.drawText("Representing 78% of Total Sales with identified customers", { x: 60, y: 470, size: 15, font });
  const cols = ["Country", "April", "May", "June", "Total", "% Margin"];
  cols.forEach((c, k) => page.drawText(c, { x: 200 + k * 60, y: 420, size: 7, font: bold }));
  [["EXXON", "USA", "2 260", "1 524"], ["BASF GERMANY", "Germany", "3 859", ""]].forEach((row, r) =>
    row.forEach((c, k) => page.drawText(c, { x: k ? 140 + k * 60 : 40, y: 405 - r * 12, size: 7, font })));
  return doc.save();
})();
const enfr = await pipeline("translation", core.TRANSLATION_MODELS.en[0], { dtype: "q8" });
const segs = core.translationSegments(en);
const t1 = Date.now();
const done = await core.translateSegments(segs, async list => (await enfr(list, { max_new_tokens: 400 })).map(r => r.translation_text));
const fr = await core.applyTranslation(en, done);
console.log(`\nPDF traduit (${segs.flat().length} passages, ${Date.now() - t1} ms) :`);
console.log(core.toText(core.extractRows(fr)));
// Vitesse sur 200 passages courts différents (une présentation de 30 pages en compte ~400).
const many = Array.from({ length: 200 }, (_, k) => [{ text: `Sales forecast for customer group ${k} in the second quarter` }]);
const t2 = Date.now();
await core.translateSegments(many, async list => (await enfr(list, { max_new_tokens: 400 })).map(r => r.translation_text));
console.log(`\n200 passages traduits en ${Math.round((Date.now() - t2) / 1000)} s.`);

if (failed) process.exit(1);
console.log("\nTraduction vers le français : OK pour les 4 langues.");
