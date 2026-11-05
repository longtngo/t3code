import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { type QueueStatus, queryView } from "~/components/sidebar/sidebarResourceQueue.logic";
import type { HostMetricsSample } from "~/lib/hostMetrics";
import { hostMetricsEnvironment } from "~/state/hostMetrics";
import { useEnvironmentQuerySelector } from "~/state/query";

import { useDocumentVisible } from "./useDocumentVisible";

export interface HostMetricsState {
  readonly sample: HostMetricsSample | null;
  readonly status: QueueStatus;
  readonly message: string | null;
  /** When `sample` arrived, or 0 before any sample. */
  readonly receivedAt: number;
}

const hostMetricsView = (result: AsyncResult.AsyncResult<HostMetricsSample, unknown>) => {
  const { data, ...rest } = queryView(result, WS_METHODS.subscribeHostMetrics);
  return { sample: data, ...rest };
};

/**
 * Subscribe to the environment's host-metrics stream while `active` and the tab is visible.
 * Passing `null` to the query atom (when inactive) tears the subscription down - which, with the
 * family's `idleTtlMs: 0`, stops the server-side sampling too. Returning resubscribes fresh.
 */
export function useHostMetrics(environmentId: EnvironmentId, active: boolean): HostMetricsState {
  const visible = useDocumentVisible();
  return useEnvironmentQuerySelector(
    active && visible ? hostMetricsEnvironment.samples({ environmentId, input: {} }) : null,
    hostMetricsView,
  );
}
