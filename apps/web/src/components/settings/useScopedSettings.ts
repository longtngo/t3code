import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  requiredScopesForServerSettingsPatch,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import { readEnvironmentScopeDenied } from "../../state/session";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  DEFAULT_SERVER_SETTINGS,
  type ProjectScopedServerSettingKey,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import {
  mergeEnvironmentSettings,
  persistClientSettingsPatch,
  useClientSettings,
} from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  type ProjectOverrideEntry,
  type ScopedSettingsPatch,
} from "./scopedSettings";

/** Effective settings for the representative target: project overrides applied on top of its environment. */
export function useScopedSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const { target } = useSettingsScope();
  const clientSettings = useClientSettings();
  const serverSettings = target?.settings ?? DEFAULT_SERVER_SETTINGS;
  const settings = useMemo(
    () => mergeEnvironmentSettings(serverSettings, clientSettings),
    [clientSettings, serverSettings],
  );
  return useMemo(() => (selector ? selector(settings) : (settings as T)), [selector, settings]);
}

export function useScopedSettingsMixed(keys: readonly (keyof ServerSettings)[]): boolean {
  const { targets } = useSettingsScope();
  return scopedSettingsAreMixed(targets, keys);
}

/** Where the keys' effective values come from across the selected targets. */
export function useScopedSettingSource(keys: readonly (keyof ServerSettings)[]) {
  const { targets } = useSettingsScope();
  return scopedSettingsSource(targets, keys);
}

function useRunScopedPlan() {
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return useCallback(
    (plan: ReturnType<typeof planScopedSettingsPatch>) => {
      if (plan.unavailableReason) {
        toastManager.add({
          type: "warning",
          title: "Setting not saved",
          description: plan.unavailableReason,
        });
        return;
      }
      void persistScopedSettingsPatch(
        plan,
        async (request) => {
          // FORK: only a loaded grant without the scope is refused here; a loading one is the
          // server's to judge, like the other gated reads.
          const missing = requiredScopesForServerSettingsPatch(request.input.patch).find((scope) =>
            readEnvironmentScopeDenied(request.environmentId, scope),
          );
          if (missing)
            return AsyncResult.failure(
              Cause.fail(
                new EnvironmentAuthorizationError({
                  requiredScope: missing,
                  message: "This connection cannot change these settings.",
                }),
              ),
            );
          return persistServer(request);
        },
        persistClientSettingsPatch,
      ).then(({ failedEnvironments, savedEnvironmentCount }) => {
        if (failedEnvironments.length === 0) return;
        toastManager.add({
          type: "error",
          title:
            savedEnvironmentCount > 0 ? "Setting saved on some environments" : "Setting not saved",
          // FORK: names the environments refused for a missing permission, not only "could not update".
          description: describeFailedWrites(failedEnvironments, savedEnvironmentCount),
        });
      });
    },
    [persistServer],
  );
}

// FORK: the toast copy for failed scoped settings writes (`labelList`, `labels`, `describeFailedWrites`).
const labelList = new Intl.ListFormat("en", { type: "conjunction" });
const labels = (writes: readonly { readonly label: string }[]) =>
  labelList.format(writes.map((write) => write.label));

/** Names the failed environments, and says which of them lack the permission to write. */
function describeFailedWrites(
  failed: readonly { readonly label: string; readonly refused: boolean }[],
  savedEnvironmentCount: number,
): string {
  const refused = failed.filter((write) => write.refused);
  const other = failed.filter((write) => !write.refused);
  return [
    other.length > 0 ? `Could not update ${labels(other)}.` : null,
    refused.length === 1
      ? `The connection to ${labels(refused)} does not have permission to change environment settings.`
      : refused.length > 1
        ? `The connections to ${labels(refused)} do not have permission to change environment settings.`
        : null,
    savedEnvironmentCount > 0 ? "The other selected environments saved the change." : null,
  ]
    .filter((sentence) => sentence !== null)
    .join(" ");
}

export function useUpdateScopedSettings() {
  const { scope, environments } = useSettingsScope();
  const run = useRunScopedPlan();
  return useCallback(
    (patch: ScopedSettingsPatch) => run(planScopedSettingsPatch(scope, environments, patch)),
    [environments, run, scope],
  );
}

/**
 * Drop the project overrides for `keys` so the selected checkouts inherit
 * again. Rows also render outside the settings layout (provider cards,
 * dialogs), where there is no scope and nothing to clear.
 */
export function useClearScopedSettings() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return useCallback(
    (keys: readonly ProjectScopedServerSettingKey[]) => {
      if (context === null) return;
      run(planScopedSettingsClear(context.scope, context.environments, keys));
    },
    [context, run],
  );
}

/** Clear `keys` on specific project entries, from an environment scope's chain popover. */
export function useClearProjectOverrides() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return useCallback(
    (entries: readonly ProjectOverrideEntry[], keys: readonly ProjectScopedServerSettingKey[]) => {
      if (context === null) return;
      run(planProjectOverridesClear(context.environments, entries, keys));
    },
    [context, run],
  );
}

export function useScopedSettingsWriteAllowed() {
  const { connectedEnvironments } = useSettingsScope();
  const writable = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  return (
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((target) => writable.has(target.environmentId))
  );
}
