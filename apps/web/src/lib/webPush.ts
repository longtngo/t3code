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

/**
 * Whether a subscription's `applicationServerKey` matches the given VAPID key bytes.
 * A subscription bound to a *different* key can never receive our pushes — the push
 * service (FCM etc.) rejects the mismatch (404/410/403) — so reusing it silently
 * breaks delivery. Exported for unit testing.
 */
export function pushSubscriptionMatchesKey(
  subscription: Pick<PushSubscription, "options">,
  expectedKey: Uint8Array,
): boolean {
  const existing = subscription.options.applicationServerKey;
  if (!existing) {
    return false;
  }
  const existingBytes = new Uint8Array(existing);
  if (existingBytes.length !== expectedKey.length) {
    return false;
  }
  for (let i = 0; i < expectedKey.length; i += 1) {
    if (existingBytes[i] !== expectedKey[i]) {
      return false;
    }
  }
  return true;
}

/** True when this device holds a push subscription bound to the CURRENT server key. */
export async function hasValidPushSubscription(vapidPublicKey: string): Promise<boolean> {
  if (!isWebPushSupported()) {
    return false;
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return (
    subscription !== null &&
    pushSubscriptionMatchesKey(subscription, urlBase64ToUint8Array(vapidPublicKey))
  );
}

/**
 * Subscribe this device to Web Push and return the server-shaped payload, or `null`
 * if the browser produced an incomplete subscription. Reuses an existing subscription
 * ONLY when it is bound to the current server key; a stale/foreign-keyed subscription
 * (e.g. left over from an earlier key or a rotated endpoint still bound to the old
 * key) is dropped and replaced, so we never register a dead endpoint.
 */
export async function subscribeToPush(
  vapidPublicKey: string,
): Promise<WebPushSubscriptionPayload | null> {
  const registration = await navigator.serviceWorker.ready;
  const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);
  let existing = await registration.pushManager.getSubscription();
  if (existing && !pushSubscriptionMatchesKey(existing, applicationServerKey)) {
    await existing.unsubscribe();
    existing = null;
  }
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
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
