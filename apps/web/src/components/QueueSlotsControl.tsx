import { useAtomValue } from "@effect/atom-react";
import { SettingsIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { environmentServerConfigsAtom } from "../state/server";
import { MAX_QUEUE_SLOTS, useQueueSlotSettingsStore } from "../queueSlotSettingsStore";
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
  const slots = useQueueSlotSettingsStore((state) => state.slots);
  const perProvider = useQueueSlotSettingsStore((state) => state.perProvider);
  const providerSlots = useQueueSlotSettingsStore((state) => state.providerSlots);
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
  return { slots, perProvider, providerSlots, instances, total };
}

/** Commits on blur, Enter, stepper or arrows; the store clamps. A cleared field restores the value. */
function SlotField(props: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <NumberField
      aria-label={props.label}
      className="w-24"
      max={MAX_QUEUE_SLOTS}
      min={0}
      onValueCommitted={(next) => {
        if (next !== null) props.onChange(next);
      }}
      size="sm"
      step={1}
      value={props.value}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={`Decrease ${props.label}`} className="[&_svg]:size-3.5" />
        <NumberFieldInput aria-label={props.label} inputMode="numeric" />
        <NumberFieldIncrement aria-label={`Increase ${props.label}`} className="[&_svg]:size-3.5" />
      </NumberFieldGroup>
    </NumberField>
  );
}

const NO_PROVIDERS = "No providers enabled";

/** The queue header's slot count and the gear popover that edits it. */
export function QueueSlotsControl(props: ReturnType<typeof useQueueSlots>) {
  const { slots, perProvider, providerSlots, instances, total } = props;
  const setSlots = useQueueSlotSettingsStore((state) => state.setSlots);
  const setPerProvider = useQueueSlotSettingsStore((state) => state.setPerProvider);
  const setProviderSlots = useQueueSlotSettingsStore((state) => state.setProviderSlots);

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
            <SlotField
              label={`${i.label} slots`}
              value={providerSlotCap(providerSlots, i.instanceId)}
              onChange={(value) => setProviderSlots(i.instanceId, value)}
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
                <SlotField label="active slots" value={slots} onChange={setSlots} />
              </div>
            )}
            <label className="flex items-center justify-between gap-3">
              <span>Per provider</span>
              <Switch size="sm" checked={perProvider} onCheckedChange={setPerProvider} />
            </label>
            {perProvider ? providerRows : null}
            <p className="text-xs text-muted-foreground">
              {perProvider
                ? "Each provider's queued threads send while fewer of its threads are working or monitoring than its number. 0 holds it."
                : "Queued threads send while fewer threads are working or monitoring than this. 0 holds the queue."}
            </p>
          </div>
        </PopoverPopup>
      </Popover>
    </>
  );
}
