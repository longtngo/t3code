import { act } from "react";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useQueueSlotSettingsStore } from "../queueSlotSettingsStore";
import { renderDom } from "../testing/renderDom";
import { QueueSlotsControl, useQueueSlots } from "./QueueSlotsControl";
import { queueSlotTotal, type QueueSlotInstance } from "./threadQueue.logic";

const instances: ReadonlyArray<QueueSlotInstance> = [
  { instanceId: "claudeAgent", label: "Claude" },
  { instanceId: "claudeAgent_personalsub", label: "Claude · PersonalSub" },
];

/** The header's control with two visible providers; the store state is the real one. */
function Harness() {
  const queue = useQueueSlots();
  const ids = instances.map((i) => i.instanceId);
  return (
    <QueueSlotsControl
      {...queue}
      instances={instances}
      total={queueSlotTotal(queue.slots, queue.perProvider, queue.providerSlots, ids)}
    />
  );
}

const type = (input: HTMLInputElement, text: string) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const blur = (input: HTMLInputElement) =>
  act(async () => {
    input.blur();
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
const input = (label: string) => {
  const found = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (found === null) throw new Error(`no ${label} input`);
  return found;
};

describe("QueueSlotsControl per provider", () => {
  beforeEach(() => {
    useQueueSlotSettingsStore.setState({ slots: 1, perProvider: false, providerSlots: {} });
  });

  const openPopover = async () => {
    const view = await renderDom(<Harness />);
    await view.click(view.find('button[aria-label="Queue slots"]'));
    return view;
  };
  // The switch's label text. happy-dom runs a label's activation even when the switch's own click
  // cancelled it, so clicking the switch itself toggles twice here (a browser toggles once).
  const perProviderLabel = () => {
    const found = [...document.querySelectorAll("label > span")].find(
      (span) => span.textContent === "Per provider",
    );
    if (found === undefined) throw new Error("no Per provider label");
    return found;
  };

  it("turns per-provider mode on and off from the switch", async () => {
    const view = await openPopover();
    await view.click(perProviderLabel());
    expect(useQueueSlotSettingsStore.getState().perProvider).toBe(true);
    expect(document.querySelector('input[aria-label="Claude slots"]')).not.toBeNull();
    await view.click(perProviderLabel());
    expect(useQueueSlotSettingsStore.getState().perProvider).toBe(false);
    expect(document.querySelector('input[aria-label="active slots"]')).not.toBeNull();
  });

  it("saves a provider's typed slot count under its instance id", async () => {
    useQueueSlotSettingsStore.setState({ perProvider: true });
    await openPopover();
    const field = input("Claude · PersonalSub slots");
    field.focus();
    await type(field, "3");
    await blur(field);
    expect(useQueueSlotSettingsStore.getState().providerSlots).toEqual({
      claudeAgent_personalsub: 3,
    });
  });

  it("lists each provider's slot count in the header tooltip", async () => {
    useQueueSlotSettingsStore.setState({
      perProvider: true,
      providerSlots: { claudeAgent_personalsub: 2 },
    });
    const view = await renderDom(<Harness />);
    const trigger = view.find('[data-testid="sidebar-queue-slots"]');
    if (trigger === null) throw new Error("no slot count");
    expect(trigger.textContent).toBe("3");
    // Focus opens the tooltip too, without the hover delay.
    await act(async () => {
      trigger.focus();
    });
    const popup = document.querySelector('[data-slot="tooltip-popup"]');
    expect([...(popup?.querySelectorAll("span") ?? [])].map((s) => s.textContent)).toEqual([
      "Claude: 1",
      "Claude · PersonalSub: 2",
    ]);
  });
});
