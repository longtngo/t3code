import { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import { BotIcon, Loader2Icon } from "lucide-react";
import {
  ProviderInstanceId,
  SUBAGENT_BACKEND_CURSOR,
  SUBAGENT_BACKEND_DEFAULT,
  subagentBackendThreadMode,
  type SubagentBackendThreadMode,
  type ThreadId,
  type EnvironmentId,
} from "@t3tools/contracts";

import {
  useClientSettings,
  useEnvironmentSettings,
  usePrimarySettings,
  useUpdateEnvironmentSettings,
} from "~/hooks/useSettings";
import { useSubagentBackend } from "~/hooks/useSubagentBackend";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { getProviderInstanceEntry, normalizeProviderAccentColor } from "~/providerInstances";
import { getAppModelOptionsForInstance } from "~/modelSelection";
import { primaryServerProvidersAtom } from "~/state/server";
import { WindowRow } from "~/components/chat/VitalsGauge";
import { computeWindowPace, cycleWindow, paceDiffLabel, windowSeverity } from "~/lib/vitals";
import { sidebarFooterSeverityBadgeClass } from "./sidebarFooterBadge";
import { resolveThreadRouteTarget } from "~/threadRoutes";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  subagentBackendApplyInput,
  subagentBackendRowStatus,
  subagentCursorAvailable,
  subagentCursorInstancesPickable,
  subagentCursorModelOptions,
  threadOffloadNotes,
} from "./sidebarSubagentBackend.logic";

const PANEL_ID = "sidebar-subagent-backend-panel";

const THREAD_MODE_LABELS: Record<SubagentBackendThreadMode, string> = {
  inherit: "Inherit",
  on: "Cursor",
  off: "Default",
};

/**
 * The clock for the usage pace. Once a second while the panel is open, so its reset readout and
 * pace marker stay current. Once a minute while closed, for the footer badge's colour: pace on a
 * month-long cycle moves about 3% a day, and a per-second ticker on a permanently mounted footer
 * control is repainting cost for nothing. No clock at all while neither needs one.
 */
function usePanelNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Per-thread override segment. Reads and writes the thread's own environment, not the
 * primary: a thread on a remote environment must patch that environment's settings, or the
 * override lands on a server that never spawns the thread.
 */
function ThreadOffloadControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly primaryMasterEnabled: boolean;
  /** `null` when unknown — see `threadOffloadNotes`. */
  readonly cursorAvailable: boolean | null;
}) {
  const { environmentId, threadId, primaryMasterEnabled, cursorAvailable } = props;
  // The master switch is per-environment, not shared (absent from `SHARED_SERVER_SETTING_KEYS`),
  // so a remote thread's own environment can disagree with the primary's flag. Read here, from
  // the thread's own environment, rather than from the primary — otherwise this control could
  // render (or hide) based on a flag the thread's actual server doesn't hold.
  const settings = useEnvironmentSettings(environmentId);
  const threadMasterEnabled = settings.subagentBackendEnabled;
  const mode = subagentBackendThreadMode(settings.subagentBackendThreadModes, threadId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const notes = threadOffloadNotes({ threadMasterEnabled, primaryMasterEnabled, cursorAvailable });
  if (!threadMasterEnabled && notes.length === 0) return null;
  return (
    <div className="space-y-1">
      <div className="text-[11px] leading-snug text-muted-foreground">This thread</div>
      {threadMasterEnabled ? (
        <ToggleGroup
          aria-label="This thread's subagent backend"
          variant="segmented"
          value={[mode]}
          onValueChange={(next) => {
            const value = next[0] as SubagentBackendThreadMode | undefined;
            if (!value) return;
            updateSettings({ subagentBackendThreadModes: { [threadId]: value } });
          }}
        >
          {Object.entries(THREAD_MODE_LABELS).map(([value, label]) => (
            <Toggle key={value} value={value}>
              {label}
            </Toggle>
          ))}
        </ToggleGroup>
      ) : null}
      {notes.map((note) => (
        <p key={note} className="text-[11px] leading-snug text-muted-foreground">
          {note}
        </p>
      ))}
    </div>
  );
}

/**
 * Sidebar footer icon for the machine-level subagent-dispatch-backend toggle: whether subagents
 * on this host route through Cursor or the provider's default. The icon is green while Cursor
 * offload is on; clicking it expands the panel in place above the footer row. Renders two items
 * into the footer's `SidebarMenu`: the icon, and the panel while open.
 *
 * Rendered only when some connected environment reports the `subagentBackend` capability,
 * mirroring how `pullRequestsSupported` is computed in `SidebarUtilityMenu`.
 */
export function SidebarSubagentBackend() {
  const { environments } = useEnvironments();
  const supported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.subagentBackend === true,
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Only ever create the query atoms for a supported environment — the capability gate exists
  // precisely so clients do not probe servers that cannot answer, and `useSubagentBackend`
  // fires a `get` as soon as it has a non-null `environmentId`.
  const environmentId = supported ? primaryEnvironmentId : null;
  const [open, setOpen] = useState(false);
  const { state, usage, pending, set } = useSubagentBackend(environmentId, open);
  const now = usePanelNow(
    open ? 1000 : state?.backend === SUBAGENT_BACKEND_CURSOR && usage ? 60_000 : null,
  );
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const paceTolerance = useClientSettings((s) => s.usagePaceTolerance);
  const settings = usePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const threadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const threadSupported =
    threadRef !== null &&
    environments.find((environment) => environment.environmentId === threadRef.environmentId)
      ?.serverConfig?.environment.capabilities.subagentBackendThreadModes === true;

  // The picker offers the Cursor provider's own visible models for the selected instance, not
  // the CLI's advertised id list. `null` while that instance has no snapshot yet, which
  // `subagentCursorModelOptions` treats differently from a user who hid every model.
  const visibleModels = useMemo(() => {
    const instanceId = state?.instanceId;
    if (instanceId == null) return null;
    const entry = getProviderInstanceEntry(providers, instanceId);
    if (entry === undefined) return null;
    return getAppModelOptionsForInstance(settings, entry, state?.model);
  }, [providers, settings, state?.instanceId, state?.model]);

  const modelOptions = subagentCursorModelOptions(state, visibleModels);

  if (!supported || environmentId == null) return null;

  const masterEnabled = settings.subagentBackendEnabled;
  const status = subagentBackendRowStatus(state, modelOptions, masterEnabled);
  const cursorAvailable = subagentCursorAvailable(state);
  const instancesPickable = subagentCursorInstancesPickable(state);
  const isCursor = state?.backend === SUBAGENT_BACKEND_CURSOR;
  const usageCycle = usage ? cycleWindow(usage.startsAt, usage.resetsAt) : null;
  // The same pace -> severity pair the panel's `WindowRow` colours its bar with.
  // Shown only while offload is genuinely on (the green-icon rule), not merely while Cursor is the
  // stored backend: with the master switch off, a coloured percent would say the opposite.
  const usagePace =
    status.dot === "on" && usage
      ? computeWindowPace(
          { utilization: usage.usedPercent, resetsAt: usage.resetsAt },
          usageCycle?.windowMs ?? null,
          now,
        )
      : null;
  const controlsDisabled = pending || state == null;

  const applyBackend = (backend: string) => {
    if (state == null) return;
    set(subagentBackendApplyInput(state, backend));
  };

  return (
    <>
      <SidebarMenuItem className="shrink-0">
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuButton
                size="sm"
                className="h-8 w-auto gap-1 px-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                aria-controls={open ? PANEL_ID : undefined}
                aria-label="Subagents"
              >
                {pending ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : status.dot === "on" ? (
                  // Wrapped, not coloured directly: the menu button colours its direct `svg`
                  // children with a more specific selector (hover included), so a class on the
                  // icon itself never shows.
                  <span className="flex text-emerald-500">
                    <BotIcon className="size-3.5" />
                  </span>
                ) : (
                  <BotIcon className="size-3.5" />
                )}
                {usagePace ? (
                  <span
                    aria-label={`Cursor usage ${usagePace.usage}%${
                      usagePace.diff !== null ? `, ${paceDiffLabel(usagePace.diff)}` : ""
                    }`}
                    className={sidebarFooterSeverityBadgeClass(
                      windowSeverity(usagePace, paceTolerance),
                    )}
                  >
                    {usagePace.usage}%
                  </span>
                ) : null}
              </SidebarMenuButton>
            }
          />
          {/* The row used to print the status beside its label; an icon has nowhere to put it. */}
          <TooltipPopup side="top">Subagents · {status.text}</TooltipPopup>
        </Tooltip>
      </SidebarMenuItem>

      {/* A full-width first item of the footer row, so it still expands in place above the
          icons and pushes the thread list up. It stays in the flow rather than floating like
          Local models: its Selects open in body portals, and the footer's outside-click
          dismissal would close a floating panel mid-selection. */}
      {open ? (
        <SidebarMenuItem className="order-first basis-full">
          <div id={PANEL_ID} className="space-y-2.5 px-1 pt-2 pb-1 [--segment-gap:var(--sidebar)]">
            <ToggleGroup
              aria-label="Subagent backend"
              variant="segmented"
              value={[isCursor ? SUBAGENT_BACKEND_CURSOR : SUBAGENT_BACKEND_DEFAULT]}
              onValueChange={(next) => {
                const value = next[0];
                if (value) applyBackend(value);
              }}
            >
              <Toggle value={SUBAGENT_BACKEND_DEFAULT} disabled={controlsDisabled}>
                Default
              </Toggle>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Toggle
                      value={SUBAGENT_BACKEND_CURSOR}
                      disabled={controlsDisabled || !cursorAvailable || !masterEnabled}
                    >
                      Cursor
                    </Toggle>
                  }
                />
                {cursorAvailable ? null : (
                  <TooltipPopup side="top">
                    No enabled Cursor instance — add one in Settings.
                  </TooltipPopup>
                )}
              </Tooltip>
            </ToggleGroup>

            {isCursor ? null : (
              <p className="text-[11px] leading-snug text-muted-foreground">
                Subagents run on the same provider and model as the thread that spawns them.
              </p>
            )}

            {isCursor && instancesPickable && state ? (
              <Select
                value={state.instanceId ?? ""}
                onValueChange={(instanceId: string | null) => {
                  if (!instanceId) return;
                  set({
                    backend: SUBAGENT_BACKEND_CURSOR,
                    instanceId: ProviderInstanceId.make(instanceId),
                    ...(state.model ? { model: state.model } : {}),
                  });
                }}
                disabled={controlsDisabled || !masterEnabled}
              >
                <SelectTrigger size="sm" aria-label="Cursor instance">
                  <SelectValue placeholder="Instance" />
                </SelectTrigger>
                <SelectPopup>
                  {state.instances.map((instance) => {
                    const accent = normalizeProviderAccentColor(instance.accentColor);
                    return (
                      <SelectItem key={instance.instanceId} value={instance.instanceId}>
                        <span className="flex items-center gap-1.5">
                          {accent ? (
                            <span
                              aria-hidden
                              className="size-1.5 shrink-0 rounded-full"
                              style={{ backgroundColor: accent }}
                            />
                          ) : null}
                          {instance.displayName}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectPopup>
              </Select>
            ) : null}

            {/* Cursor-only configuration, hidden rather than disabled while the backend is
                `default`: with nothing to configure, a dead control is just noise. */}
            {isCursor ? (
              <Select
                value={state?.model ?? ""}
                onValueChange={(model: string | null) => {
                  if (!model || state == null) return;
                  set({
                    backend: SUBAGENT_BACKEND_CURSOR,
                    ...(state.instanceId ? { instanceId: state.instanceId } : {}),
                    model,
                  });
                }}
                disabled={controlsDisabled || modelOptions.length === 0 || !masterEnabled}
              >
                <SelectTrigger size="sm" aria-label="Cursor model">
                  <SelectValue placeholder="Model" />
                </SelectTrigger>
                <SelectPopup>
                  {modelOptions.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}

            {state?.degraded ? (
              <div className="text-[11px] leading-snug text-amber-500">{state.degraded}</div>
            ) : null}

            {isCursor && usage ? (
              <WindowRow
                label={usage.label}
                window={{ utilization: usage.usedPercent, resetsAt: usage.resetsAt }}
                windowMs={usageCycle?.windowMs ?? null}
                segmentCount={usageCycle?.segmentCount}
                now={now}
                timestampFormat={timestampFormat}
              />
            ) : null}

            {!masterEnabled ? (
              <p className="text-[11px] leading-snug text-muted-foreground">
                Subagent offload is switched off in Settings → General.
              </p>
            ) : null}

            {threadSupported && threadRef ? (
              /* The "Applies to Claude Code threads." note is said rather than gated on the
                 thread's driver: only the Claude adapter injects `SUBAGENT_BACKEND_STATE`, but
                 the shell's `session` is null until a session binds (a brand-new thread would
                 lose the control), and resolving a driver from `modelSelection.instanceId`
                 needs the thread environment's provider list, which only exists for the
                 primary environment. */
              <ThreadOffloadControl
                environmentId={threadRef.environmentId}
                threadId={threadRef.threadId}
                primaryMasterEnabled={masterEnabled}
                cursorAvailable={
                  threadRef.environmentId === environmentId && state != null
                    ? cursorAvailable
                    : null
                }
              />
            ) : null}
          </div>
        </SidebarMenuItem>
      ) : null}
    </>
  );
}
