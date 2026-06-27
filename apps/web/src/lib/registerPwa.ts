import { stackedThreadToast, toastManager } from "../components/ui/toast";

// A coding session keeps one SPA tab open for hours with no navigations, and
// registerType:"prompt" only checks for a new service worker on load/navigation.
// Poll for an update hourly so a new build actually surfaces the reload prompt.
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Registers the production service worker (installability + app-shell precache) and
 * surfaces a user-controlled "Reload" prompt when a new build is available.
 *
 * Call only from a secure context outside Electron and only in production builds —
 * the desktop app loads from a file:// shell where service workers don't apply, and
 * the dev server intentionally ships no service worker (devOptions.enabled is false).
 */
export async function registerPwa(): Promise<void> {
  const { registerSW } = await import("virtual:pwa-register");

  const updateSW = registerSW({
    onNeedRefresh() {
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "New version available",
          description: "Reload to get the latest T3 Code.",
          // Persist until the user acts; a new build is not urgent enough to auto-reload
          // an active session out from under them.
          timeout: 0,
          actionProps: {
            children: "Reload",
            onClick: () => {
              // Activates the waiting worker (skipWaiting) and reloads the page.
              void updateSW(true);
            },
          },
          data: { hideCopyButton: true },
        }),
      );
    },
    onRegisteredSW(_swScriptUrl, registration) {
      if (!registration) {
        return;
      }
      setInterval(() => {
        void registration.update();
      }, UPDATE_CHECK_INTERVAL_MS);
    },
  });
}
