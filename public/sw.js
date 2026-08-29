/*
 * Service worker.
 *
 * Offline has an honesty problem of its own: a cached copy of the dataset can
 * be days old, and an app that shows it without saying so is the stale green
 * light again, in a new place. Two things prevent that. Data is network-first,
 * so a working connection always wins over the cache. And every cached record
 * carries the timestamps the header already renders, so a stale view says
 * "آخر فحص قبل ٣ أيام" on its own, without the worker having to invent a
 * banner.
 *
 * The shell is cache-first because it is content-addressed by the build: a new
 * deploy produces new filenames, so a cached script is never a wrong script.
 */
const VERSION = "v1";
const SHELL = `rasid-shell-${VERSION}`;
const DATA = `rasid-data-${VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(["./", "./index.html", "./manifest.webmanifest"]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

/** Network first, cache as backup. Fresh data always wins. */
async function dataFirst(request) {
  const cache = await caches.open(DATA);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

/** Cache first. Build filenames carry a hash, so a hit is never stale code. */
async function shellFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && new URL(request.url).origin === self.location.origin) {
    const cache = await caches.open(SHELL);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || "راصد", {
      body: payload.body || "",
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      dir: "rtl",
      lang: "ar",
      // Collapse repeats of the same subject rather than stacking them.
      tag: payload.tag || "rasid",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((list) => {
      const open = list.find((c) => "focus" in c);
      return open ? open.focus() : self.clients.openWindow("./");
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // fonts and the like

  if (url.pathname.includes("/data/")) {
    event.respondWith(dataFirst(request));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("./index.html").then((r) => r ?? Response.error())),
    );
    return;
  }
  event.respondWith(shellFirst(request));
});
