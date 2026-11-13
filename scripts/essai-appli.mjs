// Essai de l'application installable (Android) dans un vrai Chromium qui imite un téléphone Pixel :
// le site construit dans dist/ est servi en local, puis on vérifie que
//   1) le manifeste et les icônes sont valides et le service worker garde tout le lecteur sur l'appareil ;
//   2) sans Internet, la page se rouvre et un PDF s'ouvre et s'affiche ;
//   3) « Partager → Mim PDF » (un PDF envoyé par une autre application) ouvre bien le document ;
//   4) sur un écran de téléphone, rien ne déborde de la largeur de l'écran.
//   npm run build && node scripts/essai-appli.mjs [dossier-captures]
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
const { chromium, devices } = createRequire(import.meta.url)("playwright");

const PORT = 8766, SITE = `http://localhost:${PORT}/`, shots = process.argv[2];
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "-d", "dist"], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 1500));
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const ctx = await browser.newContext({ ...devices["Pixel 7"] });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", e => errors.push(e.message));
let failed = false;
const check = (ok, msg) => { console.log(`  ${ok ? "OK " : "ÉCHEC"} ${msg}`); if (!ok) failed = true; };
const pagesShown = () => page.waitForFunction(() => document.querySelectorAll("#pages .page img[src]").length > 0, null, { timeout: 60000 }).then(() => true, () => false);
const shot = name => shots && page.screenshot({ path: `${shots}/${name}.png` });

try {
  // 1) Manifeste, icônes, service worker
  const m = JSON.parse(readFileSync("dist/manifest.webmanifest", "utf8"));
  check(m.display === "standalone" && m.start_url && m.icons.some(i => i.sizes === "512x512" && i.purpose === "maskable")
        && m.icons.some(i => i.sizes === "192x192"), "manifeste complet (plein écran, icônes 192 et 512, icône adaptative)");
  for (const i of m.icons) check((await fetch(SITE + i.src)).ok, `icône ${i.src} présente`);
  await page.goto(SITE);
  const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return !!r.active; });
  check(sw, "service worker actif");
  await page.waitForFunction(async () => (await caches.keys()).some(k => k.startsWith("mim-") && k !== "mim-partage"), null, { timeout: 60000 });
  const cached = await page.evaluate(async () => {
    const k = (await caches.keys()).find(k => k.startsWith("mim-") && k !== "mim-partage");
    return (await (await caches.open(k)).keys()).map(r => new URL(r.url).pathname);
  });
  check(["/", "/app.js", "/core.js", "/vendor/mupdf/mupdf-wasm.wasm", "/vendor/tesseract/lang/fra.traineddata.gz"].every(f => cached.includes(f)),
        `lecteur complet gardé sur l'appareil (${cached.length} fichiers)`);
  await page.reload();       // la page est maintenant servie par le service worker
  await page.waitForFunction(() => /Ouvrez un PDF/.test(document.querySelector("#msg")?.textContent || ""), null, { timeout: 30000 });
  await shot("1-accueil");

  // 4) Largeur de téléphone : la page ne défile pas de côté
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(over <= 1, `rien ne déborde sur l'écran du téléphone (${over}px)`);
  const ribbonH = await page.evaluate(() => document.querySelector("header").getBoundingClientRect().height);
  check(ribbonH < 200, `ruban compact (${Math.round(ribbonH)}px de haut)`);

  // 2) Sans Internet
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => /Ouvrez un PDF/.test(document.querySelector("#msg")?.textContent || ""), null, { timeout: 30000 });
  check(true, "sans Internet : Mim PDF s'ouvre");
  await page.click('#drop [data-sample="facture"]');
  check(await pagesShown(), "sans Internet : un PDF s'ouvre et s'affiche");
  const pageW = await page.evaluate(() => document.querySelector("#pages .page").getBoundingClientRect().width);
  check(pageW <= 412 && pageW > 300, `la page tient dans la largeur de l'écran (${Math.round(pageW)}px)`);
  await shot("2-document-hors-ligne");

  // 3) Partager → Mim PDF (le formulaire qu'Android envoie à l'application)
  await ctx.setOffline(false);
  await page.goto(SITE);
  await page.evaluate(async bytes => {
    const fd = new FormData();
    fd.append("fichiers", new File([new Uint8Array(bytes)], "Facture partagée.pdf", { type: "application/pdf" }));
    await fetch("/partage", { method: "POST", body: fd, redirect: "manual" });
  }, [...readFileSync("exemples/facture.pdf")]);
  await page.goto(SITE + "?partage=1");
  check(await pagesShown(), "un PDF partagé depuis une autre application s'ouvre");
  const name = await page.evaluate(() => document.querySelector(".doctab.on span")?.textContent || document.title);
  check(/partagée/.test(name), `le document partagé garde son nom (« ${name} »)`);
  check(!/partage=/.test(page.url()), "l'adresse est nettoyée après l'ouverture");
  check(!errors.length, "aucune erreur dans la page" + (errors.length ? " : " + errors.join(" | ") : ""));
} catch (e) {
  check(false, e.message);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
