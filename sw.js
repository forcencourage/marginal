// Caches the app shell + CDN libraries so the app opens offline.
// Supabase API / storage requests are never intercepted.
const VERSION = 'marginal-v1';

const SHELL = [
  './', 'index.html', 'reader.html', 'login.html', 'profile.html',
  'css/style.css', 'css/profile.css',
  'js/config.js', 'js/supabaseClient.js', 'js/offline.js', 'js/auth.js',
  'js/main.js', 'js/reader.js', 'js/pdfEngine.js', 'js/profile.js',
  'favicon.svg', 'reactions/like.png',
];

const CDN = [
  'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,450;9..144,500;9..144,600&family=Inter:wght@400;500;560;650&display=swap',
  'https://cdn.jsdelivr.net/npm/quill@2/dist/quill.snow.css',
  'https://cdn.jsdelivr.net/npm/quill@2/dist/quill.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/web/pdf_viewer.css',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js',
  'https://cdn.jsdelivr.net/gh/forcencourage/epub.js.2.0@49137e23b966b746596fcc1053488bdb7ea0bd23/epub.js',
];

const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.allSettled([...SHELL, ...CDN].map((u) => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.includes('supabase')) return;        // API + storage: never intercept
  if (url.origin === location.origin) e.respondWith(networkFirst(req, url));
  else if (CDN_HOSTS.includes(url.hostname)) e.respondWith(cacheFirst(req));
});

async function networkFirst(req, url) {
  const cache = await caches.open(VERSION);
  const nav = req.mode === 'navigate';
  const key = nav ? url.origin + url.pathname : req;   // ignore ?id=... for pages
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
    ]);
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch {
    return (await cache.match(key))
      || (nav ? await cache.match('index.html') : null)
      || Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}