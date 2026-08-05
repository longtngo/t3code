import type { OrchestrationHistoryCursor, OrchestrationThread } from "@t3tools/contracts";
import * as Option from "effect/Option";

export type EnvironmentThreadStatus = "empty" | "cached" | "synchronizing" | "live" | "deleted";

export interface EnvironmentThreadState {
  readonly data: Option.Option<OrchestrationThread>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
  /**
   * How far back the loaded snapshot reaches. Thread snapshots are always
   * WINDOWED to the most recent turns (the giant-frame OOM defense), so a long
   * thread's older turns arrive only via the `getThreadHistoryPage` RPC. This
   * cursor is what that RPC pages from; without it older turns are unreachable.
   * `undefined` for an unwindowed snapshot (short thread) or before one loads.
   */
  readonly oldestLoaded: OrchestrationHistoryCursor | undefined;
  /** Whether turns older than {@link oldestLoaded} exist on the server. */
  readonly hasMoreHistory: boolean;
}

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  status: "empty",
  error: Option.none(),
  oldestLoaded: undefined,
  hasMoreHistory: false,
};
