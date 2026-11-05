// Essai de la traduction avec les vrais modèles (lancé par la CI) :
//   npm i --no-save @huggingface/transformers@4.3.1 && node scripts/essai-traduction.mjs
// Les modèles sont rangés dans modeles-traduction/ (même format que dans l'application).
import { pipeline, env, Tensor } from "@huggingface/transformers";
import * as mupdf from "mupdf";
import * as PDFLib from "pdf-lib";
import * as core from "../web/core.js";

core.init({ mupdf, PDFLib });

env.cacheDir = "modeles-traduction";
const loaded = {};
const load = async id => loaded[id] ??= await pipeline("translation", id, { dtype: "q8" });
// Moteur src → tgt comme dans l'application : une ou deux étapes OPUS-MT, préfixe de langue cible si besoin.
async function engine(src, tgt) {
  const steps = [];
  for (const r of core.translationRoute(src, tgt)) { const pipe = await load(r.model); steps.push(r.prefix ? core.prefixedRun(pipe, Tensor, r.prefix) : pipe); }
  return async list => {
    let out = list;
    for (const run of steps) out = (await run(out, { max_new_tokens: 400 })).map(r => r.translation_text);
    return out;
  };
}
const SAMPLES = {
  en: ["BANK SITUATION", "Top 15 Customers", "Middle East/Asia partners strongly represented",
       "The budget assumes a stable exchange rate and no new tariffs in the United States."],
  de: ["Die Umsätze des Jahres liegen im Rahmen des Budgets.", "Kunden", "Investitionen und Sicherheit"],
  es: ["Las ventas del año están en línea con el presupuesto.", "Clientes", "Situación bancaria"],
  zh: ["今年的销售额符合预算。", "客户", "银行贷款和现金流"],
};
let failed = false;
const fail = msg => { failed = true; console.log(`  ÉCHEC : ${msg}`); };
for (const [lang, texts] of Object.entries(SAMPLES)) {
  const translate = await engine(lang, "fr");
  const t0 = Date.now();
  const done = await core.translateSegments([texts.map(text => ({ text }))], translate);
  console.log(`\n${core.LANGUAGES[lang].name} → français (${Date.now() - t0} ms)`);
  for (const s of done[0]) console.log(`  ${s.text}  ->  ${s.fr}`);
  const all = done[0].map(s => s.fr).join(". ");
  if (core.detectLanguage(done[0][0].fr) !== "fr" && core.detectLanguage(all) !== "fr") fail("pas du français");
}
// Autres sens : paire directe (de→es), via l'anglais (ar→zh, ja→fr, fr→pt par ROMANCE), modèle multilingue (en→pl).
const OTHERS = [
  ["de", "es", "Die Umsätze des Jahres liegen im Rahmen des Budgets.", "es"],
  ["ar", "zh", "ارتفعت المبيعات هذا العام بنسبة عشرة بالمئة.", "zh"],
  ["ja", "fr", "今年の売上は予算に沿っています。", "fr"],
  ["fr", "pt", "Les ventes de l'année sont conformes au budget.", "pt"],
  ["en", "pl", "The sales of the year are in line with the budget.", "pl"],
  ["fr", "en", "Les ventes de l'année sont conformes au budget.", "en"],
];
for (const [src, tgt, text, expect] of OTHERS) {
  const translate = await engine(src, tgt);
  const t0 = Date.now();
  const [[s]] = await core.translateSegments([[{ text }]], translate);
  console.log(`\n${core.LANGUAGES[src].name} → ${core.LANGUAGES[tgt].name} (${Date.now() - t0} ms)\n  ${text}  ->  ${s.fr}`);
  if (s.fr === text) fail("texte non traduit");
  const got = core.detectLanguage(s.fr);
  if (got && got !== expect) fail(`langue obtenue : ${got}`);
}
// Contrôle par traduction inverse : les sigles et noms propres mal traduits sont gardés tels quels.
const enfr = await engine("en", "fr"), fren = await engine("fr", "en");
const [checked] = await core.translateSegments([["THEMIS", "OMV", "BASF US", "GENERAL KPIs", "Carry Forward", "Top 15 Customers"].map(text => ({ text }))],
  { translate: enfr, reverse: fren });
console.log("\nContrôle inverse :");
for (const s of checked) console.log(`  ${s.text}  ->  ${s.fr}`);
for (const s of checked) for (const w of core.protectedTokens(s.text)) if (!s.fr.includes(w)) fail(`${w} perdu dans « ${s.fr} »`);
if (checked[0].fr !== "THEMIS") fail("THEMIS devrait être gardé");
if (!/clients/i.test(checked[5].fr)) fail("Top 15 Customers devrait être traduit");
// Cas vus sur une vraie présentation : mots courts d'un tableau, noms propres déformés par le modèle,
// titres en majuscules, phrase coupée avant un nombre.
const REAL = ["Rate", "Ending", "Defense", "August", "Dec.", "Sales Evolution", "in progress", "Total", "Context & Assumptions",
  "Loans and Stakholders", "SABIC", "SADARA", "DOW CHEMICAL", "Strong Framatome impact expected", "Paralloy/Manoir Group USA",
  "Integration of the Paralloy network", "Expected recovery of the market end of 2026", "Ramp up expected in H2",
  "GENERAL KPIs", "CASH-FLOW", "BANK & LOANS", "Not affected Sales : less than 17%", "6 New Salesperson for Europe, Asia and America zones"];
const t3 = Date.now();
const [real] = await core.translateSegments([REAL.map(text => ({ text }))], { translate: enfr, reverse: fren }, { amp: core.AMPERSAND.en });
console.log(`\nCas réels (${Date.now() - t3} ms) :`);
for (const s of real) console.log(`  ${s.text}  ->  ${s.fr}`);
// Sorties brutes du modèle et retour en anglais, pour comprendre ce que le contrôle garde ou rejette.
const raw = await enfr(REAL), rawBack = await fren(raw), low = await enfr(REAL.map(t => t.toLocaleLowerCase()));
console.log("\nSorties brutes (traduction | retour | en minuscules) :");
REAL.forEach((t, k) => console.log(`  ${t}  |  ${raw[k]}  |  ${rawBack[k]}  |  ${low[k]}`));
const by = Object.fromEntries(real.map(s => [s.text, s.fr]));
for (const w of ["Rate", "Defense", "August", "Context & Assumptions"]) if (by[w] === w) fail(`« ${w} » non traduit`);
if (!/Framatome/.test(by["Strong Framatome impact expected"])) fail("Framatome perdu");
if (!/Paralloy/.test(by["Paralloy/Manoir Group USA"])) fail("Paralloy perdu");
if (!/2026/.test(by["Expected recovery of the market end of 2026"])) fail("2026 perdu");
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
const segs = core.translationSegments(en);
const t1 = Date.now();
const done = await core.translateSegments(segs, enfr);
const fr = await core.applyTranslation(en, done);
console.log(`\nPDF traduit (${segs.flat().length} passages, ${Date.now() - t1} ms) :`);
console.log(core.toText(core.extractRows(fr)));
// Vitesse sur 200 passages courts différents (une présentation de 30 pages en compte ~400).
const many = Array.from({ length: 200 }, (_, k) => [{ text: `Sales forecast for customer group ${k} in the second quarter` }]);
const t2 = Date.now();
await core.translateSegments(many, enfr);
console.log(`\n200 passages traduits en ${Math.round((Date.now() - t2) / 1000)} s.`);

if (failed) process.exit(1);
console.log("\nTraduction : OK (4 langues vers le français, 6 autres paires, contrôle inverse).");
