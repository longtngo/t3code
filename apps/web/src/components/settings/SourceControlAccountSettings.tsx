import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type SourceControlProviderAuth,
} from "@t3tools/contracts";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { ENVIRONMENT_SETTINGS_READ_ONLY } from "../../permissionCopy";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScopeDenied } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  groupHostAccounts,
  hostAccountPickerState,
  nextHostAccountChoices,
} from "./SourceControlAccountSettings.logic";
import {
  readHostCredentialSettings,
  type SourceControlDefinition,
  type SourceControlHostCredentials,
} from "@t3tools/client-runtime/source-control-clients";
import { redactedPlaceholder } from "./RedactedSensitiveText";

/** Sentinel select value for "per folder, else the CLI's active login"; logins have no spaces. */
const ACTIVE_ACCOUNT = "active cli account";

function RedactedLogin(props: {
  readonly account: string;
  readonly revealed: boolean;
  readonly label?: string;
}) {
  return props.revealed ? (
    <span className="min-w-0 truncate font-mono text-2xs">{props.account}</span>
  ) : (
    <span className="min-w-0 truncate font-mono text-2xs">
      <span className="select-none blur-xs" aria-hidden>
        {redactedPlaceholder(props.account)}
      </span>
      <span className="sr-only">{props.label ?? "Hidden account"}</span>
    </span>
  );
}

// The "Per folder" choice names the account used when a folder has none of its own.
function PerFolderLabel(props: {
  readonly group: { readonly activeAccount?: string | null; readonly activeUsable: boolean };
  readonly revealed: boolean;
}) {
  const { group, revealed } = props;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {group.activeAccount ? (
        <>
          Per folder, else
          <RedactedLogin revealed={revealed} account={group.activeAccount} />
          {group.activeUsable ? null : "(can't be used)"}
        </>
      ) : (
        "Per folder"
      )}
    </span>
  );
}

export function SourceControlAccountSettings({
  environmentId,
  definition,
  credentials,
  auth,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly definition: SourceControlDefinition;
  readonly credentials: SourceControlHostCredentials;
  readonly auth: SourceControlProviderAuth;
  readonly onSaved: () => void;
}) {
  const { hosts, tokens } = useEnvironmentSettings(environmentId, (settings) =>
    readHostCredentialSettings(settings, definition.kind),
  );
  const { label } = definition;
  const { cliName } = credentials;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `save ${label} account settings`,
  });
  const [saving, setSaving] = useState(false);
  // FORK: a login paired before the permission split cannot save; say so instead of a refusal.
  const writeDenied = useEnvironmentScopeDenied(environmentId, AuthSettingsWriteScope);
  const [revealed, setRevealed] = useState(false);
  const groups = groupHostAccounts(auth.accounts ?? []);

  const save = async (
    host: string,
    change: { readonly enabled?: boolean; readonly account?: string | null },
  ) => {
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: {
        patch: {
          sourceControlHosts: {
            [definition.kind]: { hosts: nextHostAccountChoices(hosts, host, change) },
          },
        },
      },
    });
    setSaving(false);
    if (result._tag === "Success") onSaved();
  };

  if (groups.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Sign in with{" "}
        <code className="rounded bg-muted px-1 py-px text-2xs">{credentials.loginCommand}</code> on
        the server host, then rescan to choose accounts here.
      </p>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Choose which <code className="rounded bg-muted px-1 py-px text-2xs">{cliName}</code> login
          each {label} host uses, or turn a host off.
          {/* FORK: why the controls below are disabled for a login without `settings:write`. */}
          {writeDenied ? ` ${ENVIRONMENT_SETTINGS_READ_ONLY}` : null}
        </p>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          onClick={() => setRevealed((current) => !current)}
          aria-label={revealed ? `Hide ${label} accounts` : `Reveal ${label} accounts`}
          aria-pressed={revealed}
        >
          {revealed ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
      </div>
      {groups.map((group) => {
        const choice = hosts[group.host];
        const enabled = choice?.enabled ?? true;
        const state = hostAccountPickerState({
          pin: choice?.account,
          enabled,
          // A saved token reads as its redaction marker, so non-empty means one is set.
          savedToken: (tokens[group.host] ?? "").length > 0,
          group,
        });
        const unusablePin = state.pinProblem === null ? null : (choice?.account ?? null);
        const pinned = choice?.account ?? ACTIVE_ACCOUNT;
        return (
          <div key={group.host} className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 space-y-0.5">
                <span className="text-xs font-medium text-foreground">{group.host}</span>
                {group.selectable.length === 1 && group.selectable[0] !== undefined ? (
                  <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    <span>Signed in as</span>
                    <RedactedLogin revealed={revealed} account={group.selectable[0]} />
                  </p>
                ) : null}
              </div>
              <Switch
                checked={enabled}
                // FORK: disabled for a login without `settings:write`.
                disabled={saving || writeDenied}
                aria-label={`Use ${label} on ${group.host}`}
                onCheckedChange={(checked) => void save(group.host, { enabled: checked })}
              />
            </div>
            {group.selectable.length > 1 ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">Account</span>
                <div className="w-64 max-w-full">
                  <Select
                    value={pinned}
                    // FORK: disabled for a login without `settings:write`.
                    disabled={saving || writeDenied || !enabled}
                    onValueChange={(value) => {
                      if (typeof value !== "string") return;
                      void save(group.host, {
                        account: value === ACTIVE_ACCOUNT ? null : value,
                      });
                    }}
                  >
                    <SelectTrigger size="sm" aria-label={`${label} account for ${group.host}`}>
                      <SelectValue>
                        {(value: string) =>
                          value === ACTIVE_ACCOUNT ? (
                            <PerFolderLabel group={group} revealed={revealed} />
                          ) : (
                            <RedactedLogin revealed={revealed} account={value} />
                          )
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem value={ACTIVE_ACCOUNT}>
                        <PerFolderLabel group={group} revealed={revealed} />
                      </SelectItem>
                      {unusablePin !== null ? (
                        <SelectItem value={unusablePin} disabled>
                          <span className="flex min-w-0 items-center gap-1">
                            <RedactedLogin revealed={revealed} account={unusablePin} />
                            {state.pinProblem === "broken" ? "(can't be used)" : "(signed out)"}
                          </span>
                        </SelectItem>
                      ) : null}
                      {group.selectable.map((account, index) => (
                        <SelectItem key={account} value={account}>
                          <RedactedLogin
                            revealed={revealed}
                            account={account}
                            label={`Account ${index + 1}`}
                          />
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>
            ) : null}
            {state.warning !== null ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-warning">
                  {state.warning === "broken"
                    ? "The chosen login can't be used, so requests on this host fail until you sign in to it again or pick another."
                    : `The chosen login is no longer signed in, so the active ${cliName} login is used for every folder.`}
                </p>
                <Button
                  size="xs"
                  variant="outline"
                  // FORK: disabled for a login without `settings:write`.
                  disabled={saving || writeDenied}
                  onClick={() => void save(group.host, { account: null })}
                >
                  Use per folder
                </Button>
              </div>
            ) : null}
            {group.broken.map((entry) => (
              <p
                key={entry.account}
                className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground/70"
              >
                <RedactedLogin revealed={revealed} account={entry.account} />
                <span>
                  can't be used: {entry.error ?? `${cliName} reports this login as invalid.`}
                </span>
              </p>
            ))}
            {state.override === "savedToken" ? (
              <p className="text-xs text-warning">
                A token is saved for this host, so it overrides the account chosen here until it is
                removed.
              </p>
            ) : state.override === "environment" ? (
              <p className="text-xs text-warning">
                {group.environmentVariable} is set on the server, so it overrides the account chosen
                here until it is unset.
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
