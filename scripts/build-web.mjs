// Prépare le site statique dans dist/ : les fichiers de web/ plus les bibliothèques
// libres copiées depuis node_modules (aucune dépendance à un CDN, fonctionne hors ligne).
// Usage : npm ci && npm run build            (site dans dist/, publié sur Vercel)
//         npm run build -- build/site   (site embarqué dans l'application Windows)
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { makeExamples } from "./exemples.mjs";

const out = process.argv[2] || "dist";
const nm = "node_modules/";
const files = {
  "vendor/mupdf/mupdf.js": "mupdf/dist/mupdf.js",
  "vendor/mupdf/mupdf-wasm.js": "mupdf/dist/mupdf-wasm.js",
  "vendor/mupdf/mupdf-wasm.wasm": "mupdf/dist/mupdf-wasm.wasm",
  "vendor/pdf-lib.min.js": "pdf-lib/dist/pdf-lib.min.js",
  "vendor/xlsx.full.min.js": "xlsx/dist/xlsx.full.min.js",
  "vendor/docx.iife.js": "docx/dist/index.iife.js",
  "vendor/forge.min.js": "node-forge/dist/forge.min.js",
  "vendor/tesseract/tesseract.min.js": "tesseract.js/dist/tesseract.min.js",
  "vendor/tesseract/worker.min.js": "tesseract.js/dist/worker.min.js",
  "vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js": "tesseract.js-core/tesseract-core-simd-lstm.wasm.js",
  "vendor/tesseract/core/tesseract-core-lstm.wasm.js": "tesseract.js-core/tesseract-core-lstm.wasm.js",
  "vendor/tesseract/lang/fra.traineddata.gz": "@tesseract.js-data/fra/4.0.0_best_int/fra.traineddata.gz",
  "vendor/tesseract/lang/eng.traineddata.gz": "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
};

rmSync(out, { recursive: true, force: true });
cpSync("web", out, { recursive: true });
for (const [dst, src] of Object.entries(files)) {
  mkdirSync(`${out}/${dst}`.replace(/\/[^/]+$/, ""), { recursive: true });
  cpSync(nm + src, `${out}/${dst}`);
}
mkdirSync(`${out}/exemples`);
for (const [name, bytes] of Object.entries(await makeExamples())) writeFileSync(`${out}/exemples/${name}`, bytes);

// Application installable (Android, ordinateur) : le service worker garde une copie de tous les
// fichiers du lecteur ; son numéro de version change dès qu'un fichier change.
const all = readdirSync(out, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
  .map(e => `${e.parentPath ?? e.path}/${e.name}`.slice(out.length + 1).replaceAll("\\", "/"))
  .filter(f => f !== "sw.js" && f !== "version.json").sort();
const hash = createHash("sha256");
for (const f of all) hash.update(f).update(readFileSync(`${out}/${f}`));
const list = ["./", ...all.filter(f => f !== "index.html")];
writeFileSync(`${out}/sw.js`, readFileSync(`${out}/sw.js`, "utf8")
  .replace("__VERSION__", hash.digest("hex").slice(0, 12)).replace("__FICHIERS__", JSON.stringify(list)));
console.log(`Site prêt dans ${out}/ (${list.length} fichiers gardés pour le mode hors ligne)`);
