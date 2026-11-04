// Sonde temporaire (CI) : codes de langue cible « >>pt<< » des modèles OPUS-MT dans Transformers.js.
import { pipeline, env, Tensor } from "@huggingface/transformers";
import * as core from "../web/core.js";
env.cacheDir = "modeles-traduction";
const show = (label, x) => console.log(label, typeof x === "string" ? x : JSON.stringify(x));
const text = "The sales of the year are in line with the budget.";
for (const [id, code] of [["Xenova/opus-mt-en-ROMANCE", ">>pt<<"], ["Xenova/opus-mt-en-zh", ">>cmn_Hans<<"], ["Xenova/opus-mt-en-mul", ">>pol<<"], ["Xenova/opus-mt-en-mul", ">>ara<<"], ["Xenova/opus-mt-en-mul", ">>jpn<<"]]) {
  const pipe = await pipeline("translation", id, { dtype: "q8" });
  const tok = pipe.tokenizer;
  console.log(`\n=== ${id} ${code}`);
  show("codes supportés (extrait) :", (tok.supported_language_codes || []).filter(c => /pt|pol|cmn|fra|deu|zho|ara|jpn|rus|hin|kor|swh|swa|nob|pes|fas/.test(c)).slice(0, 40));
  show("id du code :", tok.convert_tokens_to_ids(code));
  show("tokens texte préfixé :", tok.tokenize(`${code} ${text}`).slice(0, 6));
  show("A pipeline avec préfixe :", (await pipe(`${code} ${text}`, { max_new_tokens: 100 }))[0].translation_text);
  show("B pipeline sans préfixe :", (await pipe(text, { max_new_tokens: 100 }))[0].translation_text);
  try { show("C prefixedRun (lot de 2) :", (await core.prefixedRun(pipe, Tensor, code)([text, "Customers"], { max_new_tokens: 100 })).map(r => r.translation_text)); }
  catch (e) { show("C erreur :", String(e).slice(0, 300)); }
}
