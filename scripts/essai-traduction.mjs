// Essai de la traduction en français avec les vrais modèles (lancé par la CI) :
//   npm i --no-save @huggingface/transformers@4.3.1 && node scripts/essai-traduction.mjs
// Les modèles sont rangés dans modeles-traduction/ (même format que dans l'application).
import { pipeline, env } from "@huggingface/transformers";
import * as core from "../web/core.js";

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
if (failed) process.exit(1);
console.log("\nTraduction vers le français : OK pour les 4 langues.");
