import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/**
 * On-demand account-usage refresh.
 *
 * A command rather than a query: it answers `{ ok: true }` once every provider has
 * been asked, and the numbers themselves arrive the way they always do, as an
 * `account.usage.updated` activity. Keeping one path into the UI means the refreshed
 * figures render through the same code as the polled ones, so there is no second
 * shape that can drift.
 */
export function createAccountUsageEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:account-usage:refresh",
      tag: WS_METHODS.accountUsageRefresh,
    }),
  };
}
