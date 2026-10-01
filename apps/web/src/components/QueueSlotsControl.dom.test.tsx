import { RegistryContext } from "@effect/atom-react";
import type { QueueSlotSettings } from "@t3tools/contracts";
import { type Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Same seams as queueSlotSettings.dom.test.tsx: the primary environment, its server config atom
// and the outgoing command are stubbed. Each `updateSettings` call waits on its own deferred reply,
// released separately from the settings echo (the config atom), as on the wire.
const fixture = vi.hoisted(() => ({
  primary: null as { environmentId: string } | null,
  calls: [] as Array<{
    value: { input: { patch: { queueSlots?: unknown } } };
    reply: (queueSlots: unknown) => void;
    fail: () => void;
  }>,
}));

vi.mock("../state/environments", () => ({
  usePrimaryEnvironment: () => fixture.primary,
}));
vi.mock("../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/server")>();
  const { Atom } = await import("effect/unstable/reactivity");
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const primaryServerConfigAtom = Atom.make<{ settings: Record<string, unknown> } | null>(null);
  return {
    ...actual,
    primaryServerConfigAtom,
    primaryServerSettingsAtom: Atom.make(
      (get) => get(primaryServerConfigAtom)?.settings ?? DEFAULT_SERVER_SETTINGS,
    ),
  };
});
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async (value: never) => {
    const { AsyncResult } = await import("effect/unstable/reactivity");
    return new Promise((resolve) => {
      fixture.calls.push({
        value,
        reply: (queueSlots) => resolve(AsyncResult.success({ queueSlots })),
        fail: () => resolve(AsyncResult.failure(new Error("offline") as never)),
      });
    });
  },
}));

import { useQueueSlotSettingsStore } from "../queueSlotSettingsStore";
import { primaryServerConfigAtom } from "../state/server";
import { renderDom } from "../testing/renderDom";
import { QueueSlotsControl, useQueueSlots } from "./QueueSlotsControl";
import { queueSlotTotal, type QueueSlotInstance } from "./threadQueue.logic";

const configAtom = primaryServerConfigAtom as unknown as Atom.Writable<{
  settings: Record<string, unknown>;
} | null>;
let registry: AtomRegistry.AtomRegistry;

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
const mount = () =>
  renderDom(
    <RegistryContext.Provider value={registry}>
      <Harness />
    </RegistryContext.Provider>,
  );

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

beforeEach(() => {
  useQueueSlotSettingsStore.setState({ slots: 1, perProvider: false, providerSlots: {} });
  registry = AtomRegistry.make();
  fixture.primary = null;
  fixture.calls.length = 0;
});

const openPopover = async () => {
  const view = await mount();
  await view.click(view.find('button[aria-label="Queue slots"]'));
  return view;
};

describe("QueueSlotsControl per provider", () => {
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
    // No primary: the write resolves without a server, and the field keeps the committed value.
    expect(field.value).toBe("3");
  });

  it("lists each provider's slot count in the header tooltip", async () => {
    useQueueSlotSettingsStore.setState({
      perProvider: true,
      providerSlots: { claudeAgent_personalsub: 2 },
    });
    const view = await mount();
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

describe("QueueSlotsControl slot fields with a primary", () => {
  const server = (queueSlots: Partial<QueueSlotSettings> = {}): QueueSlotSettings => ({
    slots: 1,
    perProvider: false,
    providerSlots: {},
    ...queueSlots,
  });
  const echo = (queueSlots: QueueSlotSettings) =>
    act(async () => {
      registry.set(configAtom, { settings: { queueSlots } });
    });
  const reply = (index: number, queueSlots: QueueSlotSettings) =>
    act(async () => {
      fixture.calls[index]!.reply(queueSlots);
    });
  const sent = () => fixture.calls.map((call) => call.value.input.patch.queueSlots);
  const field = () => input("active slots");
  const increment = (view: Awaited<ReturnType<typeof mount>>, label = "active slots") =>
    // The popover renders in a portal, outside the view's container.
    view.click(document.querySelector(`button[aria-label="Increase ${label}"]`));
  const decrement = (view: Awaited<ReturnType<typeof mount>>) =>
    view.click(document.querySelector('button[aria-label="Decrease active slots"]'));

  beforeEach(async () => {
    fixture.primary = { environmentId: "env-primary" };
    registry.set(configAtom, { settings: { queueSlots: server() } });
  });

  it("keeps one write in flight per field and sends only the newest value after it", async () => {
    const view = await openPopover();
    await increment(view);
    await increment(view);
    await increment(view);
    expect(sent()).toEqual([{ slots: 2 }]);
    expect(field().value).toBe("4");
    await reply(0, server({ slots: 2 }));
    expect(sent()).toEqual([{ slots: 2 }, { slots: 4 }]);
    expect(field().value).toBe("4");
    await echo(server({ slots: 2 }));
    expect(field().value).toBe("4");
    await reply(1, server({ slots: 4 }));
    expect(field().value).toBe("4");
    await echo(server({ slots: 4 }));
    expect(field().value).toBe("4");
  });

  it("sends a step back to the echoed value while a later write is in flight", async () => {
    const view = await openPopover();
    await increment(view);
    await increment(view);
    await reply(0, server({ slots: 2 }));
    await echo(server({ slots: 2 }));
    await decrement(view);
    expect(field().value).toBe("2");
    await reply(1, server({ slots: 3 }));
    expect(sent()).toEqual([{ slots: 2 }, { slots: 3 }, { slots: 2 }]);
    expect(field().value).toBe("2");
  });

  it("returns to the server's value when the write fails", async () => {
    const view = await openPopover();
    await increment(view);
    expect(field().value).toBe("2");
    await act(async () => {
      fixture.calls[0]!.fail();
    });
    expect(field().value).toBe("1");
  });

  it("shows the successful reply's value, not the draft, when a later write fails last", async () => {
    const view = await openPopover();
    await increment(view);
    await increment(view);
    await reply(0, server({ slots: 2 }));
    await act(async () => {
      fixture.calls[1]!.fail();
    });
    expect(field().value).toBe("2");
  });

  it("sends a step back made after the reply but before its echo", async () => {
    const view = await openPopover();
    await increment(view);
    await reply(0, server({ slots: 2 }));
    expect(field().value).toBe("2");
    await decrement(view);
    expect(sent()).toEqual([{ slots: 2 }, { slots: 1 }]);
    await echo(server({ slots: 2 }));
    expect(field().value).toBe("1");
    await reply(1, server({ slots: 1 }));
    await echo(server({ slots: 1 }));
    expect(field().value).toBe("1");
  });

  it("sends the pending value after a failed write and shows its reply", async () => {
    const view = await openPopover();
    await increment(view);
    await increment(view);
    await act(async () => {
      fixture.calls[0]!.fail();
    });
    expect(sent()).toEqual([{ slots: 2 }, { slots: 3 }]);
    expect(field().value).toBe("3");
    await reply(1, server({ slots: 3 }));
    expect(field().value).toBe("3");
  });

  it("holds an outside change made mid-burst until the write settles, then shows the reply", async () => {
    const view = await openPopover();
    await increment(view);
    await echo(server({ slots: 7 }));
    expect(field().value).toBe("2");
    await reply(0, server({ slots: 2 }));
    expect(field().value).toBe("2");
  });

  it("follows an outside change of the value while idle", async () => {
    await openPopover();
    await echo(server({ slots: 5 }));
    expect(field().value).toBe("5");
  });

  it("keeps a provider's waiting value when another provider commits", async () => {
    const providerSlots = { claudeAgent: 1, claudeAgent_personalsub: 1 };
    registry.set(configAtom, {
      settings: { queueSlots: server({ perProvider: true, providerSlots }) },
    });
    const view = await openPopover();
    await increment(view, "Claude slots");
    await increment(view, "Claude slots");
    await increment(view, "Claude · PersonalSub slots");
    await reply(
      0,
      server({ perProvider: true, providerSlots: { ...providerSlots, claudeAgent: 2 } }),
    );
    expect(sent()).toEqual([
      { providerSlots: { claudeAgent: 2 } },
      { providerSlots: { claudeAgent_personalsub: 2 } },
      { providerSlots: { claudeAgent: 3 } },
    ]);
  });

  it("shows the current value, not an earlier burst's reply, when a later write fails", async () => {
    const view = await openPopover();
    await increment(view);
    await reply(0, server({ slots: 2 }));
    await echo(server({ slots: 2 }));
    await echo(server({ slots: 5 }));
    await increment(view);
    await act(async () => {
      fixture.calls[1]!.fail();
    });
    expect(field().value).toBe("5");
  });

  it("sends each provider's change as its own partial patch", async () => {
    const providerSlots = { claudeAgent: 1, claudeAgent_personalsub: 1 };
    registry.set(configAtom, {
      settings: { queueSlots: server({ perProvider: true, providerSlots }) },
    });
    const view = await openPopover();
    await increment(view, "Claude slots");
    await increment(view, "Claude · PersonalSub slots");
    expect(sent()).toEqual([
      { providerSlots: { claudeAgent: 2 } },
      { providerSlots: { claudeAgent_personalsub: 2 } },
    ]);
  });
});
