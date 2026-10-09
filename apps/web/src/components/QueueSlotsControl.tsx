import { useAtomValue } from "@effect/atom-react";
import { SettingsIcon } from "lucide-react";
import { MAX_QUEUE_SLOTS, type QueueSlotSettings } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ENVIRONMENT_SETTINGS_READ_ONLY } from "../permissionCopy";
import { environmentServerConfigsAtom } from "../state/server";
import { useQueueSlotSettings, useQueueSlotsAccess, useSetQueueSlots } from "../queueSlotSettings";
import { queueSlotSources } from "./queueSlotSources";
import { listQueueSlotInstances, providerSlotCap, queueSlotTotal } from "./threadQueue.logic";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "./ui/number-field";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Switch } from "./ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** The visible provider instances (with their labels) and the queue's total slots across them. */
export function useQueueSlots() {
  const access = useQueueSlotsAccess();
  const writable = access !== "none";
  const notice =
    access === "none"
      ? ENVIRONMENT_SETTINGS_READ_ONLY
      : access === "device"
        ? QUEUE_SLOTS_DEVICE_ONLY
        : null;
  const { slots, perProvider, providerSlots } = useQueueSlotSettings();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const instances = useMemo(
    () => listQueueSlotInstances(queueSlotSources(serverConfigs)),
    [serverConfigs],
  );
  const total = queueSlotTotal(
    slots,
    perProvider,
    providerSlots,
    instances.map((i) => i.instanceId),
  );
  return { slots, perProvider, providerSlots, instances, total, writable, notice };
}

/**
 * One slot count. Commits on blur, Enter, stepper or arrows; the store clamps, and a cleared field
 * restores the value. One write is in flight at a time: a commit made meanwhile waits, and only the
 * newest waiting value is sent next, so a held arrow key costs two writes, not one per repeat. A
 * waiting value is dropped once any field for the same `setting` (the popover and the Settings tab,
 * or a remount) commits after it: that later commit is sent after it would have been. The field keeps its own draft until the last write settles, so an echo of an earlier write cannot step
 * it back; then it shows `pick` of the newest successful reply, or the effective value if every
 * write failed.
 */
/** The newest commit per setting across every mounted field. */
const latestCommit = new Map<string, number>();
let commitSeq = 0;

function SlotField(props: {
  setting: string;
  label: string;
  value: number;
  onCommit: (value: number) => Promise<QueueSlotSettings | null>;
  pick: (settings: QueueSlotSettings) => number;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(props.value);
  const sending = useRef(false);
  const pending = useRef<{ value: number; seq: number } | null>(null);
  // The newest successful reply of the current burst, the fallback when a failed write settles last.
  const lastReply = useRef<QueueSlotSettings | null>(null);
  const latestValue = useRef(props.value);

  useEffect(() => {
    latestValue.current = props.value;
    if (!sending.current) setDraft(props.value);
  }, [props.value]);

  const send = (value: number) => {
    sending.current = true;
    void props
      .onCommit(value)
      .catch(() => null)
      .then((reply) => {
        if (reply !== null) lastReply.current = reply;
        const next = pending.current;
        pending.current = null;
        if (next !== null && latestCommit.get(props.setting) === next.seq) {
          send(next.value);
          return;
        }
        sending.current = false;
        const settled = lastReply.current;
        lastReply.current = null;
        setDraft(settled === null ? latestValue.current : props.pick(settled));
      });
  };

  return (
    <NumberField
      aria-label={props.label}
      className="w-24"
      disabled={props.disabled}
      max={MAX_QUEUE_SLOTS}
      min={0}
      onValueChange={(next) => {
        if (next !== null) setDraft(next);
      }}
      onValueCommitted={(next) => {
        // Base UI can also commit the value already shown (blur after typing, an arrow key at a
        // bound, Home/End); that sends one redundant, harmless write. Do not skip values equal to
        // `props.value`: that would drop a step back made between the reply and the echo.
        if (next === null) return;
        const seq = ++commitSeq;
        latestCommit.set(props.setting, seq);
        if (sending.current) pending.current = { value: next, seq };
        else send(next);
      }}
      size="sm"
      step={1}
      value={draft}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={`Decrease ${props.label}`} className="[&_svg]:size-3.5" />
        <NumberFieldInput aria-label={props.label} inputMode="numeric" />
        <NumberFieldIncrement aria-label={`Increase ${props.label}`} className="[&_svg]:size-3.5" />
      </NumberFieldGroup>
    </NumberField>
  );
}

/** The overall slot count, shown when the queue is not per provider. */
export function ActiveSlotsField(props: { value: number; disabled: boolean }) {
  const setQueueSlots = useSetQueueSlots();
  return (
    <SlotField
      setting="slots"
      label="active slots"
      disabled={props.disabled}
      value={props.value}
      onCommit={(value) => setQueueSlots({ slots: value })}
      pick={(settings) => settings.slots}
    />
  );
}

/** One provider instance's slot count. */
export function ProviderSlotsField(props: {
  label: string;
  instanceId: string;
  providerSlots: QueueSlotSettings["providerSlots"];
  disabled: boolean;
}) {
  const setQueueSlots = useSetQueueSlots();
  return (
    <SlotField
      setting={`providerSlots.${props.instanceId}`}
      label={`${props.label} slots`}
      disabled={props.disabled}
      value={providerSlotCap(props.providerSlots, props.instanceId)}
      onCommit={(value) => setQueueSlots({ providerSlots: { [props.instanceId]: value } })}
      pick={(settings) => providerSlotCap(settings.providerSlots, props.instanceId)}
    />
  );
}

export const QUEUE_SLOTS_DEVICE_ONLY =
  "Saved on this device only. This connection cannot change environment settings.";
export const NO_PROVIDERS = "No providers enabled";
export const ACTIVE_SLOTS_HINT =
  "Queued threads send while fewer threads are working or monitoring than this. 0 holds the queue.";
export const PER_PROVIDER_HINT =
  "Each provider's queued threads send while fewer of its threads are working or monitoring than its number. 0 holds it.";

/** The queue header's slot count and the gear popover that edits it. */
export function QueueSlotsControl(props: ReturnType<typeof useQueueSlots>) {
  const { slots, perProvider, providerSlots, instances, total, writable, notice } = props;
  const setQueueSlots = useSetQueueSlots();
  const setPerProvider = (value: boolean) => void setQueueSlots({ perProvider: value });

  let tooltipContent: ReactNode;
  if (!perProvider) {
    tooltipContent =
      total === 0
        ? "0 slots: the queue holds"
        : `Queued threads send while fewer than ${total} thread${total === 1 ? " is" : "s are"} working or monitoring`;
  } else if (instances.length === 0) {
    tooltipContent = NO_PROVIDERS;
  } else {
    tooltipContent = (
      <div className="flex flex-col">
        {instances.map((i) => (
          <span
            key={i.instanceId}
          >{`${i.label}: ${providerSlotCap(providerSlots, i.instanceId)}`}</span>
        ))}
      </div>
    );
  }
  const providerRows =
    instances.length === 0
      ? NO_PROVIDERS
      : instances.map((i) => (
          <div key={i.instanceId} className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate">{i.label}</span>
            <ProviderSlotsField
              label={i.label}
              instanceId={i.instanceId}
              providerSlots={providerSlots}
              disabled={!writable}
            />
          </div>
        ));

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="img"
              data-testid="sidebar-queue-slots"
              aria-label={`Queue slots: ${total}`}
              className="shrink-0 tabular-nums"
            >
              {total}
            </span>
          }
        />
        <TooltipPopup side="top">{tooltipContent}</TooltipPopup>
      </Tooltip>
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label="Queue slots"
              className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            >
              <SettingsIcon className="size-3" />
            </button>
          }
        />
        <PopoverPopup align="end">
          <div className="flex flex-col gap-3 text-sm">
            {perProvider ? null : (
              <div className="flex items-center justify-between gap-3">
                <span>Active slots</span>
                <ActiveSlotsField value={slots} disabled={!writable} />
              </div>
            )}
            <label className="flex items-center justify-between gap-3">
              <span>Per provider</span>
              <Switch
                size="sm"
                checked={perProvider}
                onCheckedChange={setPerProvider}
                disabled={!writable}
              />
            </label>
            {perProvider ? providerRows : null}
            {notice === null ? null : <p className="text-xs text-muted-foreground">{notice}</p>}
            <p className="text-xs text-muted-foreground">
              {perProvider ? PER_PROVIDER_HINT : ACTIVE_SLOTS_HINT}
            </p>
          </div>
        </PopoverPopup>
      </Popover>
    </>
  );
}
