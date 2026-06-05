import { ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { memo, useMemo, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { recallAccountModel } from "../../accountModelMemory";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import type { ProviderInstanceEntry } from "../../providerInstances";

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

function statusDotClassName(entry: ProviderInstanceEntry): string | undefined {
  switch (entry.snapshot.auth.status) {
    case "authenticated":
      return "bg-emerald-500";
    case "unauthenticated":
      return "bg-destructive";
    default:
      return undefined;
  }
}

/**
 * Quick switch between Claude provider instances (work vs personal accounts).
 *
 * Each Claude instance points at its own config dir / Keychain credential, so
 * two instances are two independent logins. This flips the composer's active
 * selection between them and surfaces each account's email + tier so it's
 * obvious which is live. `onSelectAccount` is the composer's model-select
 * handler; switching restores that account's last-used model (via
 * accountModelMemory), falling back to the instance default for "".
 */
export const AccountSwitcher = memo(function AccountSwitcher(props: {
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  activeInstanceId: ProviderInstanceId;
  compact?: boolean;
  disabled?: boolean;
  onSelectAccount: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const claudeAccounts = useMemo(
    () =>
      props.instanceEntries.filter(
        (entry) => entry.driverKind === CLAUDE_DRIVER_KIND && entry.enabled && entry.isAvailable,
      ),
    [props.instanceEntries],
  );

  const activeAccount = useMemo(
    () => claudeAccounts.find((entry) => entry.instanceId === props.activeInstanceId) ?? null,
    [claudeAccounts, props.activeInstanceId],
  );

  // One menu row per login: instances sharing a continuation group share a
  // config dir and therefore credentials, so "switching" between them would
  // be a no-op. The active instance represents its login group.
  const accounts = useMemo(() => {
    const byLogin = new Map<string, ProviderInstanceEntry>();
    for (const entry of claudeAccounts) {
      const login = entry.continuationGroupKey ?? entry.instanceId;
      if (!byLogin.has(login) || entry.instanceId === props.activeInstanceId) {
        byLogin.set(login, entry);
      }
    }
    return [...byLogin.values()];
  }, [claudeAccounts, props.activeInstanceId]);

  // Only a Claude-account control: hide unless the composer is on one of two+
  // Claude accounts with distinct logins. Showing it while on another provider
  // would turn a "switch account" click into a silent provider switch.
  if (accounts.length < 2 || !activeAccount) return null;

  const activeDot = statusDotClassName(activeAccount);

  const handleSelect = (instanceId: ProviderInstanceId) => {
    setIsMenuOpen(false);
    if (instanceId === props.activeInstanceId) return;
    props.onSelectAccount(instanceId, recallAccountModel(instanceId) ?? "");
  };

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  data-chat-account-switcher="true"
                  disabled={props.disabled}
                  className={cn(
                    "min-w-0 justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 [&_svg]:mx-0",
                    props.compact ? "max-w-36 shrink-0" : "max-w-44 shrink sm:max-w-52 sm:px-3",
                  )}
                />
              }
            >
              <span className="flex min-w-0 items-center gap-2 overflow-hidden">
                <ProviderInstanceIcon
                  driverKind={activeAccount.driverKind}
                  displayName={activeAccount.displayName}
                  accentColor={activeAccount.accentColor}
                  className="size-4"
                  iconClassName="size-4"
                  {...(activeDot ? { statusDotClassName: activeDot } : {})}
                />
                <span className="min-w-0 truncate">
                  {activeAccount.snapshot.auth.email ?? activeAccount.displayName}
                </span>
                <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
              </span>
            </MenuTrigger>
          }
        />
        <TooltipPopup side="top">
          {props.disabled ? "Account is locked for this thread" : "Switch Claude account"}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" className="min-w-64">
        <MenuGroup>
          <MenuGroupLabel>Claude account</MenuGroupLabel>
          {accounts.map((entry) => {
            const isActive = entry.instanceId === props.activeInstanceId;
            const tier = entry.snapshot.auth.type?.trim();
            const email = entry.snapshot.auth.email;
            const dot = statusDotClassName(entry);
            return (
              <MenuItem
                key={entry.instanceId}
                onClick={() => handleSelect(entry.instanceId)}
                className="gap-2.5"
              >
                <ProviderInstanceIcon
                  driverKind={entry.driverKind}
                  displayName={entry.displayName}
                  accentColor={entry.accentColor}
                  className="size-5"
                  iconClassName="size-4"
                  {...(dot ? { statusDotClassName: dot } : {})}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{entry.displayName}</span>
                    {tier ? (
                      <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-[10px] font-semibold uppercase leading-none text-muted-foreground">
                        {tier}
                      </span>
                    ) : null}
                  </span>
                  {email ? (
                    <span className="truncate text-xs text-muted-foreground">{email}</span>
                  ) : null}
                </span>
                {isActive ? (
                  <CheckIcon aria-hidden="true" className="size-4 shrink-0 text-foreground" />
                ) : null}
              </MenuItem>
            );
          })}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});
