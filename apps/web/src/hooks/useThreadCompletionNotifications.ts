/**
 * Wires the thread-completion notifier into React: registers navigation +
 * active-thread lookup so notifications can suppress the focused thread and
 * route on click, and subscribes to the desktop notification-activated push so
 * clicking a native desktop notification navigates to the thread.
 *
 * Mount once near the app root (inside the router).
 */
import { useEffect, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { registerThreadNotificationHost } from "../lib/notifier";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";

export function useThreadCompletionNotifications(): void {
  const navigate = useNavigate();

  // Track the currently-viewed thread (if any) for suppression. Read from the
  // active route match params rather than store internals.
  const activeThreadRef = useRouterState({
    select: (state): ScopedThreadRef | null => {
      const params = state.matches.at(-1)?.params as
        | { environmentId?: string; threadId?: string }
        | undefined;
      return resolveThreadRouteRef(params ?? {});
    },
  });
  const activeThreadRefBox = useRef<ScopedThreadRef | null>(activeThreadRef);
  activeThreadRefBox.current = activeThreadRef;

  useEffect(() => {
    return registerThreadNotificationHost({
      navigateToThread: (ref) => {
        void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
      },
      getActiveThreadRef: () => activeThreadRefBox.current,
    });
  }, [navigate]);

  useEffect(() => {
    const onNotificationActivated = window.desktopBridge?.onNotificationActivated;
    if (typeof onNotificationActivated !== "function") {
      return;
    }
    const unsubscribe = onNotificationActivated((threadRef) => {
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
    });
    return () => {
      unsubscribe?.();
    };
  }, [navigate]);
}
