// Mim PDF installé comme une application (téléphone Android, ordinateur) : ce « service worker »
// garde une copie de tout le lecteur sur l'appareil, pour qu'il s'ouvre et fonctionne sans Internet.
// Les PDF ne passent jamais par ici vers Internet : il ne fait que servir les fichiers du lecteur.
// VERSION et FICHIERS sont remplis par scripts/build-web.mjs à chaque publication.
const VERSION = "__VERSION__";
const FICHIERS = __FICHIERS__;
const CACHE = "mim-" + VERSION, PARTAGE = "mim-partage";

self.addEventListener("install", ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(FICHIERS.map(f => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", ev => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE && k !== PARTAGE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", ev => {
  const url = new URL(ev.request.url);
  if (url.origin !== location.origin) return;              // modèles d'IA, etc. : le navigateur s'en charge
  if (ev.request.method === "POST" && url.pathname === "/partage") return ev.respondWith(recevoirPartage(ev.request));
  if (ev.request.method !== "GET") return;
  ev.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const nav = ev.request.mode === "navigate";
    const ici = await cache.match(nav ? "./" : ev.request, { ignoreSearch: nav || url.pathname.endsWith("/") });
    if (ici) return ici;
    const r = await fetch(ev.request);
    if (r.ok && r.type === "basic" && !url.pathname.startsWith("/partage")) cache.put(ev.request, r.clone());
    return r;
  })());
});

// « Partager » un PDF vers Mim PDF depuis une autre application (Fichiers, Gmail, WhatsApp…) :
// Android envoie le fichier ici ; on le garde le temps que la page l'ouvre.
async function recevoirPartage(request) {
  const form = await request.formData();
  const cache = await caches.open(PARTAGE);
  for (const k of await cache.keys()) await cache.delete(k);
  let n = 0;
  for (const f of form.getAll("fichiers")) {
    if (!(f instanceof File)) continue;
    await cache.put(`/partage/${n++}`, new Response(f, { headers: { "Content-Type": f.type || "application/pdf", "X-Nom": encodeURIComponent(f.name || "document.pdf") } }));
  }
  return Response.redirect("/?partage=" + n, 303);
}
