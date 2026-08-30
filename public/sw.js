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
const VERSION = "v2";
const SHELL = `rasid-shell-${VERSION}`;
const DATA = `rasid-data-${VERSION}`;
/*
 * Every push that reaches this device is written here, banner or no banner.
 *
 * "Nothing arrived" has two very different causes: the push never got here, or
 * it got here and the operating system swallowed the banner. From the outside
 * they look identical, and the first person to hit that ambiguity had no way to
 * tell which one he was looking at. This log separates them: if an entry is
 * here, delivery works and the problem is the device's notification settings.
 * It is not versioned, because its whole value is surviving an update.
 */
const PUSH_LOG = "rasid-push-log";

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
        Promise.all(
          keys
            .filter((k) => k !== SHELL && k !== DATA && k !== PUSH_LOG)
            .map((k) => caches.delete(k)),
        ),
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
  // Scoped to the shell cache. A bare caches.match searches every cache,
  // including the push log, which has no business answering page requests.
  const cached = await caches.open(SHELL).then((c) => c.match(request));
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && new URL(request.url).origin === self.location.origin) {
    const cache = await caches.open(SHELL);
    cache.put(request, response.clone());
  }
  return response;
}

/** Keeps the last ten arrivals, newest last, so the app can prove delivery. */
async function recordArrival(payload, via) {
  const cache = await caches.open(PUSH_LOG);
  const entry = { at: new Date().toISOString(), via, title: payload.title, body: payload.body };
  // Millisecond plus a random suffix: two pushes can land in the same
  // millisecond, and a bare timestamp would have one silently replace the other.
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await cache.put(
    new Request(`./__push-log/${key}`),
    new Response(JSON.stringify(entry), { headers: { "content-type": "application/json" } }),
  );
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - 10)).map((k) => cache.delete(k)));
}

async function announce(payload, via) {
  await recordArrival(payload, via);
  await self.registration.showNotification(payload.title || "راصد", {
    body: payload.body || "",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    dir: "rtl",
    lang: "ar",
    // Collapse repeats of the same subject rather than stacking them.
    tag: payload.tag || "rasid",
  });
  // Wake any open window so the settings screen can update itself.
  for (const client of await self.clients.matchAll({ type: "window" })) {
    client.postMessage({ type: "push-arrived" });
  }
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(announce(payload, "push"));
});

/*
 * A test the page can fire itself. Notifications shown from a page and from a
 * worker are not the same code path on Android, and the one that matters is the
 * worker's, because that is the one a real push uses. So the test goes through
 * here rather than calling showNotification in the tab.
 */
self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === "test-notification") {
    event.waitUntil(
      announce(
        {
          title: "راصد — تجربة محلية",
          body: "هذا إشعار جرّبته بنفسك من داخل التطبيق. وصوله يعني أن جهازك يعرض إشعارات راصد.",
          tag: "rasid-test",
        },
        "local",
      ),
    );
  }
  // The fortnight-after-applying reminder. The page decides when it is due,
  // because the marks it is based on never leave that device.
  if (msg.type === "follow-up") {
    event.waitUntil(announce({ title: msg.title, body: msg.body, tag: msg.tag }, "follow-up"));
  }
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
