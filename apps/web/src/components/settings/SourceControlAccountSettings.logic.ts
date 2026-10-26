import type { SourceControlProviderAuth } from "@t3tools/contracts";
import type { HostCredentialSettings } from "@t3tools/client-runtime/source-control-clients";

export type DiscoveredAccount = NonNullable<SourceControlProviderAuth["accounts"]>[number];

export interface HostAccountGroup {
  readonly host: string;
  /** The CLI's active login: used with no pin and where a folder names no login the CLI holds. */
  readonly activeAccount: string | null;
  /** False when the CLI holds the active login but cannot use it, so falling back to it fails. */
  readonly activeUsable: boolean;
  /** Stored logins that work and can be pinned. */
  readonly selectable: ReadonlyArray<string>;
  readonly broken: ReadonlyArray<DiscoveredAccount>;
  readonly environmentVariable: string | null;
}

/**
 * What the account picker shows for a host. A pin is `signedOut` when the CLI no longer holds it
 * (the server falls back to the active login) and `broken` when held but refused. `warning` shows
 * only while the pin is what requests use: host on, no saved or environment token (saved wins).
 */
export function hostAccountPickerState(input: {
  readonly pin: string | undefined;
  readonly enabled: boolean;
  readonly savedToken: boolean;
  readonly group: Pick<HostAccountGroup, "selectable" | "broken" | "environmentVariable">;
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

export function groupHostAccounts(
  accounts: ReadonlyArray<DiscoveredAccount>,
): ReadonlyArray<HostAccountGroup> {
  const hosts = [...new Set(accounts.map((entry) => entry.host))];
  return hosts.map((host) => {
    const entries = accounts.filter((entry) => entry.host === host);
    const stored = entries.filter((entry) => entry.environmentVariable === undefined);
    const selectable = stored.filter((entry) => entry.authenticated);
    // The CLI uses its active login even when it is broken, so the fallback names that one.
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

export function nextHostAccountChoices(
  current: HostCredentialSettings["hosts"],
  host: string,
  change: { readonly enabled?: boolean; readonly account?: string | null },
): HostCredentialSettings["hosts"] {
  const previous = current[host];
  const enabled = change.enabled ?? previous?.enabled ?? true;
  const account = change.account === undefined ? previous?.account : (change.account ?? undefined);
  const { [host]: _replaced, ...rest } = current;
  if (enabled && account === undefined) return rest;
  return { ...rest, [host]: { enabled, ...(account === undefined ? {} : { account }) } };
}
