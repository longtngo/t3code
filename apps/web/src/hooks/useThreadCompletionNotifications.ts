/**
 * Wires the thread-completion notifier into React.
 *
 * Two responsibilities:
 *  1. Register navigation + active-thread lookup so notifications can suppress
 *     the focused thread and route to a thread on click.
 *  2. Observe every thread shell's latest-turn state and, on a genuine
 *     running -> terminal edge for a thread the user is not viewing, raise an
 *     OS notification (gated by the `notifyOnThreadCompletion` client setting).
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

import { useClientSettings } from "./useSettings";
import { useThreadShells } from "../state/entities";
import { classifyThreadCompletion, notifyThreadCompletions, registerThreadNotificationHost } from "../lib/notifier";
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

  const enabled = useClientSettings((settings) => settings.notifyOnThreadCompletion);
  const enabledBox = useRef(enabled);
  enabledBox.current = enabled;

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
          completions: [completion],
          enabled: enabledBox.current,
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
