/* Charger alerts: shows pushes from the ChargeIt proxy and opens the station when tapped.
   Loaded into the generated service worker via workbox importScripts. */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" ? data.title : "ChargeIt";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      renotify: true,
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      vibrate: [120, 60, 120],
      data: { url: typeof data.url === "string" ? data.url : "./" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope);
  // Only ever open our own pages.
  if (url.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ("focus" in w) {
          return w.focus().then((f) => (f && "navigate" in f ? f.navigate(url.href) : f));
        }
      }
      return self.clients.openWindow(url.href);
    }),
  );
});
