import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
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
export function useAccountUsageRefresh(
  environmentId: EnvironmentId,
  /**
   * The thread being shown. Optional only because the gauge renders without
   * one; when it is absent the refresh reaches threads with a live provider
   * session and no others, which is how a press on an idle thread came to do
   * nothing at all.
   */
  threadId?: ThreadId | null,
): AccountUsageRefresh {
  const [pending, setPending] = useState(false);
  const refresh = useAtomCommand(accountUsageEnvironment.refresh, {
    label: "account-usage:refresh",
  });
  const run = useCallback(() => {
    if (pending) return;
    setPending(true);
    void refresh({
      environmentId,
      input: threadId ? { threadId } : {},
    }).finally(() => {
      setPending(false);
    });
  }, [environmentId, pending, refresh, threadId]);
  return { run, pending };
}
