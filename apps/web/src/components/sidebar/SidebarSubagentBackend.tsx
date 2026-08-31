import { useEffect, useState } from "react";
import { BotIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";
import {
  ProviderInstanceId,
  SUBAGENT_BACKEND_CURSOR,
  SUBAGENT_BACKEND_DEFAULT,
} from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { useClientSettings } from "~/hooks/useSettings";
import { useSubagentBackend } from "~/hooks/useSubagentBackend";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { normalizeProviderAccentColor } from "~/providerInstances";
import { WindowRow } from "~/components/chat/VitalsGauge";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  subagentBackendApplyInput,
  subagentBackendRowStatus,
  subagentCursorAvailable,
  subagentCursorInstancesPickable,
} from "./sidebarSubagentBackend.logic";

const PANEL_ID = "sidebar-subagent-backend-panel";

/**
 * Re-renders once a second while, and only while, the panel is open, so the usage bar's
 * reset-time readout stays "now"-relative (`formatWindowReset`). `WindowRow` is called here
 * with `windowMs: null`, so `computeWindowPace` never produces a pace projection to advance —
 * there is nothing else this ticker does. A permanently-mounted ticker in the sidebar footer
 * is exactly the repainting cost the project guidelines forbid — most of the time this row is
 * collapsed and nothing here should be painting at all.
 */
function usePanelNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * Sidebar footer disclosure for the machine-level subagent-dispatch-backend toggle: whether
 * subagents on this host route through Cursor or the provider's default. Expands in place
 * (pushing the thread list up) rather than floating, unlike its footer-row neighbours, because
 * this is a settings surface with real controls rather than a glanceable status popover.
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
  const now = usePanelNow(open);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);

  if (!supported || environmentId == null) return null;

  const status = subagentBackendRowStatus(state);
  const cursorAvailable = subagentCursorAvailable(state);
  const instancesPickable = subagentCursorInstancesPickable(state);
  const isCursor = state?.backend === SUBAGENT_BACKEND_CURSOR;
  const controlsDisabled = pending || state == null;

  const applyBackend = (backend: string) => {
    if (state == null) return;
    set(subagentBackendApplyInput(state, backend));
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem className="shrink-0">
        <SidebarMenuButton
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={open ? PANEL_ID : undefined}
        >
          <BotIcon />
          <span className="min-w-0 flex-1 truncate">Subagents</span>
          {pending ? (
            <Loader2Icon className="size-3 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                status.dot === "on" ? "bg-emerald-500" : "bg-muted-foreground/40",
              )}
            />
          )}
          <span className="max-w-24 shrink truncate text-xs text-muted-foreground">
            {status.text}
          </span>
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
              open && "rotate-90",
            )}
          />
        </SidebarMenuButton>

        {open ? (
          <div id={PANEL_ID} className="space-y-2.5 px-1 pt-2 pb-1">
            <ToggleGroup
              aria-label="Subagent backend"
              variant="segmented"
              value={[isCursor ? SUBAGENT_BACKEND_CURSOR : SUBAGENT_BACKEND_DEFAULT]}
              onValueChange={(next) => {
                const value = next[0];
                if (value) applyBackend(value);
              }}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Toggle
                      value={SUBAGENT_BACKEND_CURSOR}
                      disabled={controlsDisabled || !cursorAvailable}
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
              <Toggle value={SUBAGENT_BACKEND_DEFAULT} disabled={controlsDisabled}>
                Default
              </Toggle>
            </ToggleGroup>

            {instancesPickable && state ? (
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
                disabled={controlsDisabled || !isCursor}
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

            {/* Visible but disabled when off, so the setting stays discoverable rather than
                vanishing along with the thing it configures. */}
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
              disabled={controlsDisabled || !isCursor || (state?.models.length ?? 0) === 0}
            >
              <SelectTrigger size="sm" aria-label="Cursor model">
                <SelectValue placeholder="Model" />
              </SelectTrigger>
              <SelectPopup>
                {(state?.models ?? []).map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>

            {state?.degraded ? (
              <div className="text-[11px] leading-snug text-amber-500">{state.degraded}</div>
            ) : null}

            {isCursor && usage ? (
              <WindowRow
                label={usage.label}
                window={{ utilization: usage.usedPercent, resetsAt: usage.resetsAt }}
                windowMs={null}
                now={now}
                timestampFormat={timestampFormat}
              />
            ) : null}
          </div>
        ) : null}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
