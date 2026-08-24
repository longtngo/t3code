/**
 * Wires the thread-completion notifier into React.
 *
 * Two responsibilities:
 *  1. Register navigation + active-thread lookup so notifications can suppress
 *     the focused thread and route to a thread on click.
 *  2. Observe every thread shell's latest-turn state and, on a genuine
 *     running -> terminal edge for a thread the user is not viewing, raise an
 *     OS notification. Gated by the `notifyOnThreadCompletion` client setting
 *     and by the server-side notification categories.
 *
 * The shell list (`useThreadShells`) is the authoritative per-thread state for
 * ALL threads — not just the actively-viewed one — so it is the path that
 * surfaces completions for background threads. Initial hydration never fires:
 * `classifyThreadCompletion` only returns a completion when the PREVIOUS state
 * was `running`, and a freshly-observed thread has no recorded previous state.
 *
 * Mount once near the app root (inside the router + atom registry).
 */
import { useEffect, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useClientSettings, usePrimarySettings } from "./useSettings";
import { useThreadShells } from "../state/entities";
import {
  classifyThreadCompletion,
  notifyThreadCompletions,
  registerThreadNotificationHost,
} from "../lib/notifier";
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

  // Desktop: native notifications are presented by the Electron main process,
  // which pushes the clicked thread ref back over this bridge listener. Route
  // to that thread (web notifications route in-process via dispatchNotification).
  useEffect(() => {
    const onNotificationActivated =
      typeof window === "undefined" ? undefined : window.desktopBridge?.onNotificationActivated;
    if (typeof onNotificationActivated !== "function") {
      return;
    }
    return onNotificationActivated((threadRef) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    });
  }, [navigate]);

  const enabled = useClientSettings((settings) => settings.notifyOnThreadCompletion);
  const enabledBox = useRef(enabled);
  enabledBox.current = enabled;

  // Server-authoritative, so the Web Push relay and this notifier agree on which
  // categories are silenced. Read from the PRIMARY environment only, while the
  // loop below walks shells from every attached environment — so a secondary
  // environment's completions are gated by the primary's categories. The settings
  // panel writes to primary too, so that is at least self-consistent; it only
  // diverges for multi-environment users.
  //
  // Held in a ref for the same reason as `enabled` above: the effect depends only
  // on `threads`, and adding settings to its deps would re-run the whole
  // thread-diff loop on every unrelated settings save.
  const categories = usePrimarySettings((settings) => settings.notificationCategories);
  const categoriesBox = useRef(categories);
  categoriesBox.current = categories;

  const threads = useThreadShells();
  // Per (environment:thread) previous latest-turn state, so we can detect the
  // running -> terminal edge across renders without any server/RPC changes.
  const previousStatesRef = useRef<Map<string, string | null>>(new Map());

  useEffect(() => {
    const previous = previousStatesRef.current;
    const seen = new Set<string>();
    for (const shell of threads) {
      const key = `${shell.environmentId}:${shell.id}`;
      seen.add(key);
      // Absent key => first observation => `undefined`, which never fires.
      const previousState = previous.has(key) ? (previous.get(key) ?? null) : undefined;
      const nextState = shell.latestTurn?.state ?? null;
      const completion = classifyThreadCompletion({
        threadId: shell.id,
        previousState,
        nextTurnId: shell.latestTurn?.turnId ?? null,
        nextState,
        title: shell.title,
      });
      if (completion) {
        notifyThreadCompletions({
          environmentId: shell.environmentId,
          completions: [
            { ...completion, backgroundActive: shell.backgroundLiveness === "working" },
          ],
          enabled: enabledBox.current,
          categories: categoriesBox.current,
        });
      }
      previous.set(key, nextState);
    }
    // Prune threads that dropped out so the map cannot grow unbounded.
    for (const key of previous.keys()) {
      if (!seen.has(key)) {
        previous.delete(key);
      }
    }
  }, [threads]);
}
