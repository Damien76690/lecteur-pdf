// Sonde temporaire (CI) : comment Transformers.js traite les codes de langue cible « >>pt<< » des modèles OPUS-MT.
import { pipeline, env, Tensor } from "@huggingface/transformers";
env.cacheDir = "modeles-traduction";
const show = (label, x) => console.log(label, typeof x === "string" ? x : JSON.stringify(x));
for (const [id, code, text] of [["Xenova/opus-mt-en-ROMANCE", ">>pt<<", "The sales of the year are in line with the budget."],
                                ["Xenova/opus-mt-en-zh", ">>cmn_Hans<<", "The sales of the year are in line with the budget."],
                                ["Xenova/opus-mt-en-mul", ">>pol<<", "The sales of the year are in line with the budget."]]) {
  const pipe = await pipeline("translation", id, { dtype: "q8" });
  const tok = pipe.tokenizer;
  console.log(`\n=== ${id} (${tok.constructor.name})`);
  show("codes supportés (extrait) :", (tok.supported_language_codes || []).filter(c => /pt|pol|cmn|fra|deu|zho/.test(c)).slice(0, 20));
  show("id du code :", tok.model.tokens_to_ids.get(code));
  const enc = tok(`${code} ${text}`);
  show("ids préfixe :", Array.from(enc.input_ids.data).slice(0, 8).map(Number));
  show("tokens :", tok.model.convert_ids_to_tokens(Array.from(enc.input_ids.data).slice(0, 8).map(Number)));
  show("A pipeline avec préfixe :", (await pipe(`${code} ${text}`, { max_new_tokens: 100 }))[0].translation_text);
  show("A' pipeline sans espace :", (await pipe(`${code}${text}`, { max_new_tokens: 100 }))[0].translation_text);
  show("B pipeline sans préfixe :", (await pipe(text, { max_new_tokens: 100 }))[0].translation_text);
  // C : ids construits à la main, code de langue en tête.
  try {
    const plain = tok(text);
    const ids = [tok.model.tokens_to_ids.get(code), ...Array.from(plain.input_ids.data).map(Number)];
    const input_ids = new Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]);
    const attention_mask = new Tensor("int64", BigInt64Array.from(ids.map(() => 1n)), [1, ids.length]);
    const out = await pipe.model.generate({ input_ids, attention_mask, max_new_tokens: 100 });
    show("C generate manuel :", tok.batch_decode(out, { skip_special_tokens: true }));
    show("C ids sortie :", Array.from(out.data ?? out[0]?.data ?? []).slice(0, 12).map(Number));
  } catch (e) { show("C erreur :", String(e).slice(0, 300)); }
  // D : code de langue en premier token du décodeur (forced_bos_token_id).
  try {
    const enc2 = tok(text);
    const out = await pipe.model.generate({ ...enc2, max_new_tokens: 100, forced_bos_token_id: tok.model.tokens_to_ids.get(code) });
    show("D forced_bos :", tok.batch_decode(out, { skip_special_tokens: true }));
  } catch (e) { show("D erreur :", String(e).slice(0, 300)); }
  show("config :", { decoder_start_token_id: pipe.model.config.decoder_start_token_id, forced: pipe.model.config.forced_bos_token_id, bad: pipe.model.generation_config?.bad_words_ids });
}
