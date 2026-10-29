import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { logWsReconnectPhase } from "../rpc/wsReconnectLog";
import { useEnvironments } from "../state/environments";

/**
 * Observation-only wiring for the opt-in WS reconnect timeline logger: feeds every environment's
 * presentation-phase transitions to `Connection.logWsReconnectPhase`, never touching the
 * supervisor. The logger is a no-op unless `localStorage["t3.wsReconnect"] === "1"`.
 */
export function useWsReconnectTimelineLog(): void {
  const { presentationById } = useEnvironments();
  const previousPhaseRef = useRef<Map<EnvironmentId, EnvironmentConnectionPhase>>(new Map());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- logs each environment's connection phase change to the reconnect timeline
  useEffect(() => {
    const previous = previousPhaseRef.current;
    const seen = new Set<EnvironmentId>();

    for (const [environmentId, presentation] of presentationById) {
      seen.add(environmentId);
      const phase = presentation.connection.phase;
      if (previous.get(environmentId) === phase) {
        continue;
      }
      previous.set(environmentId, phase);
      logWsReconnectPhase(phase, presentation.entry.target.label, { environmentId });
    }

    for (const environmentId of previous.keys()) {
      if (!seen.has(environmentId)) {
        previous.delete(environmentId);
      }
    }
  }, [presentationById]);
}
