import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { accountUsageEnvironment } from "~/state/accountUsage";

export interface AccountUsageRefresh {
  readonly run: () => void;
  readonly pending: boolean;
}

/**
 * On-demand usage refresh for one environment.
 *
 * `pending` covers only the round trip to the server, which is the honest thing
 * to spin on: the refreshed numbers arrive afterwards as an
 * `account.usage.updated` activity, on their own path, and waiting for them here
 * would mean inventing a correlation the protocol does not carry.
 */
export function useAccountUsageRefresh(environmentId: EnvironmentId): AccountUsageRefresh {
  const [pending, setPending] = useState(false);
  const refresh = useAtomCommand(accountUsageEnvironment.refresh, {
    label: "account-usage:refresh",
  });
  const run = useCallback(() => {
    if (pending) return;
    setPending(true);
    void refresh({ environmentId, input: {} }).finally(() => {
      setPending(false);
    });
  }, [environmentId, pending, refresh]);
  return { run, pending };
}
