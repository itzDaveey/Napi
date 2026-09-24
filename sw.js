/* Napi dashboard — service worker
 *
 * Két dolgot csinál:
 *
 * 1) OFFLINE MŰKÖDÉS
 *    Az első (szerverrel történő) betöltéskor eltárolja az egész oldalt, így a
 *    kezdőképernyőre kitett ikon szerver és internet nélkül is elindul.
 *
 * 2) APP FRISSÍTÉSE AZ APPON BELÜLRŐL
 *    A dashboard "App frissítése" gombja átküldi ide az új HTML-fájl tartalmát
 *    (install-app-update üzenet), ezt egy külön, soha nem törölt gyorsítótárba
 *    tesszük (MANUAL), és onnantól az app innen indul. Így új verzióhoz nem kell
 *    többé se a-Shell, se helyi szerver — se ezt a fájlt cserélni.
 *
 * Ezt a fájlt nem kell módosítani új dashboard-verziónál: nem tud semmit az
 * oldal tartalmáról, csak kiszolgálja azt, amit utoljára kapott.
 */

const VERSION = "v1";
const CACHE  = "napi-dashboard-" + VERSION;   // alap fájlok (verziózott)
const MANUAL = "napi-dashboard-manual";       // appon belülről telepített verzió
const MANUAL_KEY = "./__app-update__";        // ide kerül a friss HTML
const MANUAL_META = "./__app-update-meta__";  // mikor és milyen build

const CORE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (e)=>{
  e.waitUntil(
    caches.open(CACHE)
      // egyesével, hogy egyetlen hiányzó fájl se bukjon el az egész telepítést
      .then(c => Promise.all(CORE.map(u => c.add(u).catch(()=>{}))))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener("activate", (e)=>{
  e.waitUntil(
    caches.keys()
      // a MANUAL sosem törlődik — abban van a felhasználó által telepített verzió
      .then(keys => Promise.all(keys
        .filter(k => k !== CACHE && k !== MANUAL)
        .map(k => caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

function htmlResponse(html){
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

/* ---- App frissítése: az oldal küldi be az új HTML-t ---- */
self.addEventListener("message", (e)=>{
  const data = e.data || {};
  const reply = (msg)=>{
    try{
      if(e.ports && e.ports[0]) e.ports[0].postMessage(msg);
    }catch(err){}
  };

  if(data.type !== "install-app-update") return;

  if(typeof data.html !== "string" || data.html.length < 1000){
    reply({ok:false, error:"üres vagy hibás fájl"});
    return;
  }

  e.waitUntil((async ()=>{
    try{
      const c = await caches.open(MANUAL);
      await c.put(new Request(MANUAL_KEY), htmlResponse(data.html));
      await c.put(new Request(MANUAL_META), new Response(JSON.stringify({
        build: data.build || "",
        at: new Date().toISOString()
      }), {headers:{"Content-Type":"application/json"}}));
      reply({ok:true, build:data.build || ""});
    }catch(err){
      reply({ok:false, error:String(err && err.message ? err.message : err)});
    }
  })());
});

/* ---- kiszolgálás ---- */

// oldalbetöltés: 1) appon belülről telepített verzió, 2) gyorsítótár,
// 3) hálózat (ha épp fut a helyi szerver — pl. az első telepítéskor)
async function handleNavigation(req){
  const manual = await caches.open(MANUAL).then(c=>c.match(MANUAL_KEY)).catch(()=>null);
  if(manual) return manual;

  const hit = await caches.match(req);
  if(hit){
    // ha épp elérhető szerver, csendben frissítjük a tárolt példányt
    fetch(req).then(res=>{
      if(res && res.ok) caches.open(CACHE).then(c=>c.put(req, res.clone())).catch(()=>{});
    }).catch(()=>{});
    return hit;
  }

  try{
    const res = await fetch(req);
    if(res && res.ok) caches.open(CACHE).then(c=>c.put(req, res.clone())).catch(()=>{});
    return res;
  }catch(err){
    const fallback = await caches.match("./index.html");
    return fallback || Response.error();
  }
}

function staleWhileRevalidate(req){
  return caches.match(req).then(hit=>{
    const net = fetch(req).then(res=>{
      if(res && res.ok){
        const copy = res.clone();
        caches.open(CACHE).then(c=>c.put(req, copy)).catch(()=>{});
      }
      return res;
    }).catch(()=>hit);
    return hit || net;
  });
}

function cacheFirst(req){
  return caches.match(req).then(hit=>{
    if(hit) return hit;
    return fetch(req).then(res=>{
      const copy = res.clone();
      caches.open(CACHE).then(c=>c.put(req, copy)).catch(()=>{});
      return res;
    }).catch(()=>hit || Response.error());
  });
}

self.addEventListener("fetch", (e)=>{
  const req = e.request;
  if(req.method !== "GET") return;

  let url;
  try{ url = new URL(req.url); }catch(err){ return; }
  if(url.protocol !== "http:" && url.protocol !== "https:") return;

  if(req.mode === "navigate"){
    e.respondWith(handleNavigation(req));
    return;
  }
  if(url.origin === location.origin){
    e.respondWith(staleWhileRevalidate(req));
    return;
  }
  // külső (Google Fonts) — első online betöltés után offline is megmarad
  if(/fonts\.(googleapis|gstatic)\.com/.test(url.hostname)){
    e.respondWith(cacheFirst(req));
    return;
  }
  // minden más külső kérés (pl. a Goodreads-feed átjárója) mehet egyenesen
  // a hálózatra — ezeket nem tároljuk, hogy sose jöjjön vissza régi adat
});
