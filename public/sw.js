// BiT Affairs service worker.
//
// Two jobs, deliberately kept minimal:
// 1. Existing (any registered service worker, even a no-op one, is what
//    makes a site installable as a PWA — this is the "app" in "downloadable
//    app").
// 2. Receive and display push notifications sent from the send-push Edge
//    Function (see supabase/functions/send-push), and route a tap on one
//    back into the app.
//
// Deliberately NOT doing offline caching / asset precaching here — that's
// a separate, substantial commitment (cache invalidation on every deploy,
// stale-data risk for an app whose whole point is showing live approval
// status) and wasn't asked for. This worker's only job is installability
// + push.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "BiT Affairs", body: event.data.text() };
  }

  const title = payload.title || "BiT Affairs";
  const options = {
    body: payload.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: payload.url || "/" },
    tag: payload.tag || undefined, // same tag replaces a still-unread notification instead of stacking duplicates
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Focus an already-open tab rather than opening a duplicate one, if we have one.
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
