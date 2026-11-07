// Résumé IA : ce script tourne dans un « worker » à part, avec sa propre mémoire WebAssembly et sa
// propre carte graphique. La page lui envoie « load » puis « run » ; en cas de panne (plus de mémoire,
// moteur tombé), elle le ferme et en relance un neuf : rien ne reste en mauvais état. Le modèle est lu
// dans le cache du navigateur (téléchargé une seule fois) ; le texte du document ne quitte pas ce PC.
const TRANSFORMERS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js";
let T = null, generator = null, stopper = null;
const send = m => postMessage(m);
const fail = e => send({ type: "error", message: e?.message || String(e), name: e?.name || "" });

self.addEventListener("unhandledrejection", ev => { ev.preventDefault(); fail(ev.reason); });

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      T = await import(TRANSFORMERS).catch(() => { throw new Error("impossible de charger l'IA (vérifiez la connexion Internet pour ce premier usage)"); });
      generator = await T.pipeline("text-generation", data.model, { device: data.device, dtype: data.dtype,
        progress_callback: p => { if (p.status === "progress" && p.total) send({ type: "progress", file: p.file, loaded: p.loaded, total: p.total }); } });
      send({ type: "ready" });
    } else if (data.type === "run") {
      if (!generator) throw new Error("modèle non chargé");
      stopper = new T.InterruptableStoppingCriteria();
      let out = "";
      const streamer = new T.TextStreamer(generator.tokenizer, { skip_prompt: true, skip_special_tokens: true,
        callback_function: t => { out += t; send({ type: "token", text: out }); } });
      const res = await generator(data.messages, { max_new_tokens: data.max_new_tokens, do_sample: false, streamer, stopping_criteria: stopper });
      send({ type: "done", text: (res[0].generated_text.at(-1).content || out).trim() });
    } else if (data.type === "stop") stopper?.interrupt();
  } catch (e) { fail(e); }
};
