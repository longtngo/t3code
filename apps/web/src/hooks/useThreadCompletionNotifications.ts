/**
 * Wires the thread-completion notifier into React: registers navigation and active-thread
 * lookup, and raises an OS notification on a running -> terminal edge for a thread not in view.
 * Watches shells so background threads count; hydration never fires because a completion
 * needs a recorded previous `running` state. Mount once near the app root.
 */
import { useEffect, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { useClientSettings, usePrimarySettings } from "./useSettings";
import { useThreadShells } from "../state/entities";
import {
  classifyThreadCompletion,
  notifyThreadCompletions,
  registerThreadNotificationHost,
  type ThreadBackgroundLiveness,
} from "../lib/notifier";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";

/**
 * The latest run's status in the V1 turn-state vocabulary the notifier
 * classifies: every active v2 status reads "running", and only completed,
 * failed and interrupted/cancelled runs are terminal outcomes. A rolled-back
 * run notifies nothing.
 */
function latestRunNotificationState(shell: EnvironmentThreadShell): string | null {
  switch (shell.latestRun?.status) {
    case undefined:
      return null;
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "interrupted":
    case "cancelled":
      return "interrupted";
    default:
      return null;
  }
}

/** Post-settlement background work: v2 reports it as the shell's pending roster. */
function backgroundLivenessOf(shell: EnvironmentThreadShell): ThreadBackgroundLiveness {
  return shell.pendingBackgroundTasks.length > 0 ? "monitoring" : null;
}

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

  // Server-authoritative so Web Push and this notifier agree. Read from the PRIMARY only, so a
  // secondary environment's completions use the primary's categories (the panel writes primary
  // too). Held in a ref like `enabled`, so settings saves do not re-run the thread-diff effect.
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
      const nextState = latestRunNotificationState(shell);
      const completion = classifyThreadCompletion({
        threadId: shell.id,
        previousState,
        nextTurnId: shell.latestRun?.runId ?? null,
        nextState,
        title: shell.title,
      });
      if (completion) {
        notifyThreadCompletions({
          environmentId: shell.environmentId,
          completions: [{ ...completion, backgroundLiveness: backgroundLivenessOf(shell) }],
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
