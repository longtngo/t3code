import type { SourceControlProviderAuth } from "@t3tools/contracts";
import type { GitHubSettings } from "@t3tools/client-runtime/source-control-clients";

export type GitHubDiscoveredAccount = NonNullable<SourceControlProviderAuth["accounts"]>[number];

export interface GitHubHostGroup {
  readonly host: string;
  /** gh's active stored login: used where no pin applies and git names no account gh holds for a folder. */
  readonly activeAccount: string | null;
  /** False when gh holds the active login but cannot use it, so requests that fall back to it fail. */
  readonly activeUsable: boolean;
  /** Stored logins that work and can be pinned with `gh auth token --user`. */
  readonly selectable: ReadonlyArray<string>;
  readonly broken: ReadonlyArray<GitHubDiscoveredAccount>;
  readonly environmentVariable: string | null;
}

/**
 * What the account picker shows for a host. A pin is `signedOut` when gh no longer holds it (the
 * server falls back to gh's active login) and `broken` when gh holds it but cannot use it (the
 * server still sends it, and GitHub refuses). `warning` names the pin's problem only while the
 * pin is what requests use: the host is on and no saved token or environment token overrides it.
 * A saved token is used before GH_TOKEN, and a host turned off has no override.
 */
export function gitHubHostPickerState(input: {
  readonly pin: string | undefined;
  readonly enabled: boolean;
  readonly savedToken: boolean;
  readonly group: Pick<GitHubHostGroup, "selectable" | "broken" | "environmentVariable">;
}): {
  readonly pinProblem: "signedOut" | "broken" | null;
  readonly warning: "signedOut" | "broken" | null;
  readonly override: "savedToken" | "environment" | null;
} {
  const { pin, group } = input;
  const override = !input.enabled
    ? null
    : input.savedToken
      ? "savedToken"
      : group.environmentVariable
        ? "environment"
        : null;
  const pinProblem =
    pin === undefined || group.selectable.includes(pin)
      ? null
      : group.broken.some((entry) => entry.account === pin)
        ? "broken"
        : "signedOut";
  return {
    pinProblem,
    warning: input.enabled && override === null ? pinProblem : null,
    override,
  };
}

export function groupGitHubAccounts(
  accounts: ReadonlyArray<GitHubDiscoveredAccount>,
): ReadonlyArray<GitHubHostGroup> {
  const hosts = [...new Set(accounts.map((entry) => entry.host))];
  return hosts.map((host) => {
    const entries = accounts.filter((entry) => entry.host === host);
    const stored = entries.filter((entry) => entry.environmentVariable === undefined);
    const selectable = stored.filter((entry) => entry.authenticated);
    // gh uses its active login even when it is broken, so the fallback names that one.
    const active = stored.find((entry) => entry.active) ?? selectable[0];
    return {
      host,
      activeAccount: active?.account ?? null,
      activeUsable: active?.authenticated ?? true,
      selectable: selectable.map((entry) => entry.account),
      broken: stored.filter((entry) => !entry.authenticated),
      environmentVariable:
        entries.find((entry) => entry.environmentVariable)?.environmentVariable ?? null,
    };
  });
}

export function nextGitHubHosts(
  current: GitHubSettings["hosts"],
  host: string,
  change: { readonly enabled?: boolean; readonly account?: string | null },
): GitHubSettings["hosts"] {
  const previous = current[host];
  const enabled = change.enabled ?? previous?.enabled ?? true;
  const account = change.account === undefined ? previous?.account : (change.account ?? undefined);
  const { [host]: _replaced, ...rest } = current;
  if (enabled && account === undefined) return rest;
  return { ...rest, [host]: { enabled, ...(account === undefined ? {} : { account }) } };
}
