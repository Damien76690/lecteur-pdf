// Essai du Résumé IA dans un vrai navigateur (lancé par la CI) : le site construit dans dist/ est
// servi en local, Chromium ouvre la page et fait tourner le worker web/ia.js avec le vrai petit
// modèle Qwen sur le processeur (téléchargé depuis Hugging Face), deux fois de suite avec un worker
// neuf, comme le fait l'application après une panne.
//   npm run build && npm i --no-save playwright && npx playwright install --with-deps chromium
//   node scripts/essai-resume.mjs
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const { chromium } = createRequire(import.meta.url)("playwright");

const PORT = 8765, MODEL = { device: "wasm", model: "onnx-community/Qwen2.5-0.5B-Instruct", dtype: "int8" };
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "-d", "dist"], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 1500));
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage();
page.on("pageerror", e => console.log("  erreur de page :", e.message));
let failed = false;
const fail = msg => { failed = true; console.log(`  ÉCHEC : ${msg}`); };
try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  for (const round of [1, 2]) {
    const t0 = Date.now();
    // Un worker neuf à chaque tour : le second relit le modèle dans le cache du navigateur.
    const r = await page.evaluate(async model => {
      const w = new Worker(new URL("ia.js", location.href), { type: "module" });
      const got = { progress: 0, tokens: 0 };
      const ask = msg => new Promise((ok, ko) => {
        w.onmessage = ({ data }) => {
          if (data.type === "progress") got.progress++;
          else if (data.type === "token") got.tokens++;
          else if (data.type === "error") ko(new Error(data.message));
          else ok(data.text);
        };
        w.onerror = e => ko(new Error(e.message));
        w.postMessage(msg);
      });
      try {
        await ask({ type: "load", ...model });
        got.loaded = true;
        const messages = [{ role: "system", content: "Tu réponds en français, en une phrase." },
                          { role: "user", content: "Que fait un lecteur de PDF ?" }];
        got.text = await ask({ type: "run", messages, max_new_tokens: 24 });
      } catch (e) { got.error = e.message; }
      w.terminate();
      return got;
    }, MODEL);
    console.log(`Tour ${round} (${Math.round((Date.now() - t0) / 1000)} s) :`, JSON.stringify(r));
    if (r.error) fail(`tour ${round} : ${r.error}`);
    else if (!r.text || r.tokens < 2) fail(`tour ${round} : pas de texte produit`);
    if (round === 1 && !r.progress) fail("aucune progression de téléchargement signalée");
  }
} finally { await browser.close(); server.kill(); }
if (failed) process.exit(1);
console.log("Résumé IA dans le navigateur : OK");
