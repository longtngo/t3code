/**
 * Client helpers for Web Push subscription (the per-device notification toggle).
 *
 * The delivery + display side lives in the service worker (`public/push-sw.js`);
 * this module only manages the browser `PushManager` subscription and shapes it for
 * the `pushSubscriptions.register` RPC. Web Push works only in the deployed web PWA
 * (secure context, service worker present) — not Electron or dev.
 */

/** The subscription fields the server needs (matches contracts' PushSubscriptionInput). */
export interface WebPushSubscriptionPayload {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

/**
 * URL-safe base64 → `Uint8Array` for `PushManager.subscribe`'s
 * `applicationServerKey`. Backed by an explicit `ArrayBuffer` so the type satisfies
 * the DOM's `BufferSource`.
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/** Whether this browser can do Web Push at all. */
export function isWebPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window
  );
}

/** True when this device already holds a push subscription. */
export async function hasExistingPushSubscription(): Promise<boolean> {
  if (!isWebPushSupported()) {
    return false;
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription !== null;
}

/**
 * Subscribe this device to Web Push (reusing an existing subscription if present)
 * and return the server-shaped payload, or `null` if the browser produced an
 * unexpectedly incomplete subscription.
 */
export async function subscribeToPush(
  vapidPublicKey: string,
): Promise<WebPushSubscriptionPayload | null> {
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    }));
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    return null;
  }
  return {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  };
}

/**
 * Unsubscribe this device. The server-side row is pruned lazily when its next send
 * returns 404/410, so there is no unregister RPC to call here.
 */
export async function unsubscribeFromPush(): Promise<void> {
  if (!isWebPushSupported()) {
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  await subscription?.unsubscribe();
}
