import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@fontsource-variable/dm-sans/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { ManagedRelayAuthProvider } from "./cloud/managedAuth";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";

// The desktop Clerk provider statically pulls in @clerk/clerk-js (~0.5 MB gzip),
// which only the Electron auth path uses — the web path renders @clerk/react's
// CDN-loaded <ClerkProvider> instead. Load it lazily so the web bundle never
// ships the standalone SDK; in Electron the chunk is fetched locally on demand.
const DesktopClerkProvider = lazy(() =>
  import("./cloud/desktopClerk").then((m) => ({ default: m.DesktopClerkProvider })),
);

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentWindowControlsOverlayClass();
}

document.title = APP_DISPLAY_NAME;

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

const app = <RouterProvider router={router} />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {clerkPublishableKey && hasCloudPublicConfig() ? (
      isElectron ? (
        <Suspense fallback={null}>
          <DesktopClerkProvider publishableKey={clerkPublishableKey}>
            <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
          </DesktopClerkProvider>
        </Suspense>
      ) : (
        <ClerkProvider publishableKey={clerkPublishableKey}>
          <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
        </ClerkProvider>
      )
    ) : (
      app
    )}
  </React.StrictMode>,
);
