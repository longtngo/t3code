import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { logWsReconnectPhase } from "../rpc/wsReconnectLog";
import { useEnvironments } from "../state/environments";

/**
 * Observation-only wiring for the opt-in WS reconnect timeline logger.
 *
 * Watches every environment's presentation phase (the supervisor's connection
 * state, surfaced through the presentation atoms) and feeds each transition to
 * `Connection.logWsReconnectPhase`. It never touches the supervisor or reconnect
 * behavior — it is a passive subscriber to phase changes. The logger itself is a
 * no-op unless `localStorage["t3.wsReconnect"] === "1"`, so this hook is cheap to
 * mount unconditionally.
 */
export function useWsReconnectTimelineLog(): void {
  const { presentationById } = useEnvironments();
  const previousPhaseRef = useRef<Map<EnvironmentId, EnvironmentConnectionPhase>>(new Map());

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
