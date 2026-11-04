// Exploration (CI) : quels modèles de traduction libres existent, et comment se comporte NLLB-200.
import { pipeline, env } from "@huggingface/transformers";
env.cacheDir = "modeles-traduction";

const list = async (q) => {
  const out = [];
  for (let page = 0; page < 20; page++) {
    const r = await fetch(`https://huggingface.co/api/models?author=Xenova&search=${q}&limit=100&skip=${page * 100}`);
    const j = await r.json();
    if (!j.length) break;
    out.push(...j.map(m => m.id));
    if (j.length < 100) break;
  }
  return out;
};
const opus = await list("opus-mt");
console.log("OPUS-MT Xenova :", opus.length);
console.log(opus.map(m => m.replace("Xenova/opus-mt-", "")).sort().join(" "));
for (const q of ["nllb", "m2m100", "madlad", "marian"]) {
  const l = await list(q); console.log(q, ":", l.join(" "));
}
for (const id of ["Xenova/nllb-200-distilled-600M", "Xenova/m2m100_418M", "onnx-community/nllb-200-distilled-600M"]) {
  try {
    const r = await fetch(`https://huggingface.co/api/models/${id}?blobs=true`);
    const j = await r.json();
    const files = (j.siblings || []).filter(s => /onnx/.test(s.rfilename)).map(s => `${s.rfilename} ${Math.round((s.size || 0) / 1048576)}Mo`);
    console.log(id, "\n  " + files.join("\n  "));
  } catch (e) { console.log(id, "erreur", e.message); }
}

const samples = {
  "eng_Latn>fra_Latn": ["BASF US", "OMV", "GENERAL KPIs", "Carry Forward", "Ramp up expected in H2", "Top 15 Customers (excl. Us tariff impact)",
    "4.46 ME Budget including Carry Forward of previous year", "THEMIS", "TOTAL", "Context & Assumptions"],
  "deu_Latn>spa_Latn": ["Die Umsätze des Jahres liegen im Rahmen des Budgets.", "Kunden"],
  "arb_Arab>zho_Hans": ["ارتفعت المبيعات هذا العام بنسبة عشرة بالمئة.", "العملاء"],
  "fra_Latn>eng_Latn": ["Autorisations", "accord-enveloppe BPI du 29/10/26 (12 mois)", "Les ventes de l'année sont conformes au budget."],
};
for (const [id, dtype] of [["Xenova/nllb-200-distilled-600M", "q8"], ["Xenova/m2m100_418M", "q8"]]) {
  try {
    const t0 = Date.now();
    const tr = await pipeline("translation", id, { dtype });
    console.log(`\n${id} chargé en ${Date.now() - t0} ms`);
    for (const [pair, texts] of Object.entries(samples)) {
      let [src, tgt] = pair.split(">");
      if (/m2m/.test(id)) { src = src.slice(0, 2).replace("en", "en").replace("de", "de").replace("ar", "ar").replace("fr", "fr"); tgt = tgt.slice(0, 2); }
      const t1 = Date.now();
      const out = await tr(texts, { src_lang: src, tgt_lang: tgt, max_new_tokens: 200 });
      console.log(`  ${pair} (${Date.now() - t1} ms)`);
      texts.forEach((t, k) => console.log(`    ${t}  ->  ${out[k].translation_text}`));
    }
    const many = Array.from({ length: 40 }, (_, k) => `Sales forecast for customer group ${k} in the second quarter`);
    const t2 = Date.now();
    await tr(many, { src_lang: /m2m/.test(id) ? "en" : "eng_Latn", tgt_lang: /m2m/.test(id) ? "fr" : "fra_Latn", max_new_tokens: 200 });
    console.log(`  40 phrases en ${Date.now() - t2} ms`);
  } catch (e) { console.log(id, "ERREUR", e.message); }
}
