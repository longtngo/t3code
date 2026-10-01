import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

import { readEnvironmentSettings } from "../hooks/useSettings";
import { listQueueSlotInstances } from "./threadQueue.logic";

/** Each environment's providers and effective settings, the input to `listQueueSlotInstances`. */
export function queueSlotSources(serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>) {
  return [...serverConfigs].map(([environmentId, config]) => ({
    providers: config.providers,
    settings: readEnvironmentSettings(environmentId),
  }));
}

/** The provider instances the coordinator counts slots for; none outside per-provider mode. */
export function visibleQueueInstanceIds(
  perProvider: boolean,
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
): ReadonlyArray<string> {
  return perProvider
    ? listQueueSlotInstances(queueSlotSources(serverConfigs)).map((i) => i.instanceId)
    : [];
}
