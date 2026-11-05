import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useRef } from "react";

import {
  classifyQueryFailure,
  queryView,
  type QueueView,
} from "../components/sidebar/sidebarResourceQueue.logic";
import { environmentAtomList, environmentIdsKey } from "../state/environmentAtomList";
import { resourceQueueEnvironment } from "../state/resourceQueue";
import { useDocumentVisible } from "./useDocumentVisible";

/** Closed panel: a glanceable count that does not need to be live. */
const IDLE_INTERVAL_MS = 60_000;
/** Open panel: refresh every few seconds. */
const ACTIVE_INTERVAL_MS = 5_000;

const TAG = WS_METHODS.getResourceQueue;
const queueAtom = (environmentId: EnvironmentId) =>
  resourceQueueEnvironment.get({ environmentId, input: {} });
const queuesAtom = environmentAtomList("web-resource-queues", queueAtom);

/**
 * Refresh only a settled result that is not fetching and not positively classified unsupported.
 * Initial or waiting means a fetch is already running (first subscribe, reconnect), and an
 * unsupported env's atom re-runs by itself on reconnect through its connection dependency.
 */
function shouldRefresh(result: AsyncResult.AsyncResult<unknown, unknown>): boolean {
  if (result._tag === "Initial" || result.waiting) return false;
  return !(
    result._tag === "Failure" && classifyQueryFailure(result.cause, TAG).status === "unsupported"
  );
}

/**
 * Every environment's resource queue, in `envs` order. One interval refreshes each connected
 * env's query atom (60 s closed, 5 s `fast`), paused while the tab is hidden. It also refreshes
 * at once when the panel opens, the tab shows again, or the connected set changes; closing the
 * panel only slows the cadence.
 */
export function useResourceQueues(
  envs: ReadonlyArray<{ environmentId: EnvironmentId; connected: boolean }>,
  fast: boolean,
): ReadonlyArray<QueueView> {
  const registry = useContext(RegistryContext);
  const ids = envs.map((entry) => entry.environmentId);
  const results = useAtomValue(queuesAtom(environmentIdsKey(ids)));
  const visible = useDocumentVisible();
  const connectedKey = environmentIdsKey(
    envs.filter((entry) => entry.connected).map((entry) => entry.environmentId),
  );

  const previous = useRef<{ connectedKey: string; visible: boolean; fast: boolean } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polling interval that refreshes each connected, supported env's queue atom
  useEffect(() => {
    const before = previous.current;
    previous.current = { connectedKey, visible, fast };
    if (!visible || connectedKey === "") return;
    const connected = connectedKey.split("\n") as EnvironmentId[];
    const refreshAll = () => {
      for (const environmentId of connected) {
        const atom = queueAtom(environmentId);
        if (shouldRefresh(registry.get(atom))) registry.refresh(atom);
      }
    };
    const now =
      before === null ||
      before.connectedKey !== connectedKey ||
      !before.visible ||
      (fast && !before.fast);
    if (now) refreshAll();
    const timer = setInterval(refreshAll, fast ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [registry, connectedKey, visible, fast]);

  return results.map((result) => queryView(result, TAG));
}
