/* eslint-disable */
// Web Push handlers for the T3 Code PWA service worker.
//
// Injected into the workbox-generated service worker via `workbox.importScripts`
// (see apps/web/vite.config.ts). This code runs in the *service-worker* global
// scope, so it wakes on a server-sent Web Push even when no tab is open and the
// phone screen is off — which is the entire point: notifications that survive the
// mobile tab being frozen (the foreground Notification path in src/lib/notifier.ts
// cannot, because a frozen tab runs no page JS).
//
// Payload shape (JSON, sent by the server): { title, body, tag?, url? }.

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_err) {
    payload = {};
  }

  const title = payload.title || "T3 Code";
  const options = {
    body: payload.body || "",
    // `tag` coalesces notifications for the same thread so a later update replaces
    // an earlier one rather than stacking.
    tag: payload.tag || undefined,
    data: { url: payload.url || "/" },
    icon: "/pwa-192x192.png",
    badge: "/pwa-192x192.png",
  };

  event.waitUntil(
    (async () => {
      // A "finished" push is redundant when a tab of this app is currently visible:
      // the foreground notifier already raises that one, so showing an OS
      // notification too would double-notify. Chrome's `userVisibleOnly` rule only
      // penalises a silent push when NO visible client exists — which is exactly the
      // screen-off / backgrounded case we DO show. The "asking" edge has no
      // foreground counterpart, so it must always show, even with a visible tab.
      if (payload.kind === "finished") {
        const clients = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        const hasVisibleClient = clients.some((client) => client.visibilityState === "visible");
        if (hasVisibleClient) {
          return;
        }
      }
      await self.registration.showNotification(title, options);
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const rawUrl = (event.notification.data && event.notification.data.url) || "/";
  const targetUrl = new URL(rawUrl, self.location.origin);

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      // Prefer a tab already on the exact target path (origin + pathname).
      for (const client of clients) {
        const clientUrl = new URL(client.url);
        if (
          clientUrl.origin === targetUrl.origin &&
          clientUrl.pathname === targetUrl.pathname &&
          "focus" in client
        ) {
          return client.focus();
        }
      }

      // Otherwise focus any open tab and navigate it to the thread.
      const existing = clients.find((client) => "focus" in client);
      if (existing) {
        await existing.focus();
        if ("navigate" in existing) {
          try {
            return await existing.navigate(targetUrl.href);
          } catch (_err) {
            /* navigation can be blocked; fall through to openWindow */
          }
        }
      }

      // No tab open at all — open a fresh one.
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl.href);
      }
    })(),
  );
});
