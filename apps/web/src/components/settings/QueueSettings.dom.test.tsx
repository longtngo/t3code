import { RegistryContext } from "@effect/atom-react";
import type { QueueSlotSettings } from "@t3tools/contracts";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Same seams as QueueSlotsControl.dom.test.tsx: primary environment, its server config atom and
// the outgoing command are stubbed; each `updateSettings` call waits on its own deferred reply.
const fixture = vi.hoisted(() => ({
  primary: null as { environmentId: string } | null,
  calls: [] as Array<{
    value: { input: { patch: { queueSlots?: unknown } } };
    reply: (queueSlots: unknown) => void;
  }>,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => undefined,
  useLocation: ({ select }: { select?: (location: unknown) => unknown } = {}) => {
    const location = { pathname: "/settings/queue", hash: "", state: {} };
    return select ? select(location) : location;
  },
}));
// A live scope picker: the Queue tab must not offer it, since writes always go to the primary.
vi.mock("./SettingsScopeContext", () => ({
  useOptionalSettingsScope: () => ({
    search: {},
    singleEnvironment: true,
    groups: [],
    scope: { kind: "all" },
    targets: [],
    connectedEnvironments: [],
    selectScope: () => undefined,
  }),
}));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePrimaryEnvironment: () => fixture.primary,
}));
vi.mock("../../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/server")>();
  const { Atom } = await import("effect/reactivity");
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
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async (value: never) => {
    const { AsyncResult } = await import("effect/reactivity");
    return new Promise((resolve) => {
      fixture.calls.push({
        value,
        reply: (queueSlots) => resolve(AsyncResult.success({ queueSlots })),
      });
    });
  },
}));

import { useQueueSlotSettingsStore } from "../../queueSlotSettingsStore";
import { primaryServerConfigAtom } from "../../state/server";
import { renderDom } from "../../testing/renderDom";
import { QueueSlotsControl, useQueueSlots } from "../QueueSlotsControl";
import type { QueueSlotInstance } from "../threadQueue.logic";
import { QueueSettingsView } from "./QueueSettings";
import { SETTINGS_SEARCH_ITEMS } from "./settingsSearch";

const configAtom = primaryServerConfigAtom as unknown as Atom.Writable<{
  settings: Record<string, unknown>;
} | null>;
let registry: AtomRegistry.AtomRegistry;

const instances: ReadonlyArray<QueueSlotInstance> = [
  { instanceId: "claudeAgent", label: "Claude" },
  { instanceId: "claudeAgent_personalsub", label: "Claude · PersonalSub" },
];

// Both surfaces read the same hook, with the two visible providers pinned.
function Popover() {
  const queue = useQueueSlots();
  return <QueueSlotsControl {...queue} instances={instances} />;
}
function Tab() {
  const queue = useQueueSlots();
  return <QueueSettingsView {...queue} instances={instances} />;
}
const mount = (withPopover = false) =>
  renderDom(
    <RegistryContext.Provider value={registry}>
      <Tab />
      {withPopover ? <Popover /> : null}
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
const text = () => document.body.textContent ?? "";

beforeEach(() => {
  useQueueSlotSettingsStore.setState({ slots: 1, perProvider: false, providerSlots: {} });
  registry = AtomRegistry.make();
  fixture.primary = null;
  fixture.calls.length = 0;
});

describe("QueueSettingsView", () => {
  it("does not show the environment and project scope pickers", async () => {
    await mount();
    expect(text()).toContain("Active slots");
    expect(text()).not.toContain("Applying settings for");
  });

  it("shows Active slots, or the per-provider rows, by the Per provider switch", async () => {
    const view = await mount();
    expect(text()).toContain("Active slots");
    expect(document.querySelector('input[aria-label="active slots"]')).not.toBeNull();
    await view.click(document.querySelector('[role="switch"]'));
    expect(useQueueSlotSettingsStore.getState().perProvider).toBe(true);
    expect(text()).not.toContain("Active slots");
    expect(document.querySelector('input[aria-label="active slots"]')).toBeNull();
  });

  const anchorOf = (id: string) => {
    const items: ReadonlyArray<{ id: string; targetId?: string }> = SETTINGS_SEARCH_ITEMS;
    const item = items.find((candidate) => candidate.id === id)!;
    return document.getElementById(item.targetId ?? item.id);
  };

  it("lands each Queue search result on the row it names", async () => {
    await mount();
    expect(anchorOf("queue-slots")?.textContent).toContain("Active slots");
    expect(anchorOf("queue-per-provider")?.textContent).toContain("Per provider");
  });

  it("lands Active slots on the provider counts in per-provider mode", async () => {
    useQueueSlotSettingsStore.setState({ perProvider: true });
    await mount();
    const anchor = anchorOf("queue-slots");
    expect(anchor).not.toBeNull();
    expect(anchor!.querySelector('input[aria-label="Claude slots"]')).not.toBeNull();
    expect(anchorOf("queue-per-provider")?.textContent).toContain("Per provider");
  });

  it("says no providers are enabled in per-provider mode with no provider instances", async () => {
    useQueueSlotSettingsStore.setState({ perProvider: true });
    function NoProviders() {
      return <QueueSettingsView {...useQueueSlots()} instances={[]} />;
    }
    await renderDom(
      <RegistryContext.Provider value={registry}>
        <NoProviders />
      </RegistryContext.Provider>,
    );
    expect(text()).toContain("No providers enabled");
    expect(anchorOf("queue-slots")?.textContent).toContain("No providers enabled");
  });

  it("is editable with no primary environment, committing a partial patch", async () => {
    const view = await mount();
    const field = input("active slots");
    expect(field.disabled).toBe(false);
    field.focus();
    await type(field, "4");
    await blur(field);
    expect(useQueueSlotSettingsStore.getState().slots).toBe(4);
    await view.click(document.querySelector('[role="switch"]'));
    expect(useQueueSlotSettingsStore.getState().perProvider).toBe(true);
  });

  it("commits a provider row under its instance id", async () => {
    fixture.primary = { environmentId: "env-primary" };
    const server: QueueSlotSettings = { slots: 1, perProvider: true, providerSlots: {} };
    registry.set(configAtom, { settings: { queueSlots: server } });
    await mount();
    expect(text()).toContain("Claude · PersonalSub");
    const field = input("Claude · PersonalSub slots");
    field.focus();
    await type(field, "3");
    await blur(field);
    expect(fixture.calls.map((c) => c.value.input.patch.queueSlots)).toEqual([
      { providerSlots: { claudeAgent_personalsub: 3 } },
    ]);
  });
});

describe("QueueSettingsView next to the popover", () => {
  it("shares one server value, and a tab edit's echo reaches the popover field", async () => {
    fixture.primary = { environmentId: "env-primary" };
    const seeded: QueueSlotSettings = { slots: 2, perProvider: false, providerSlots: {} };
    registry.set(configAtom, { settings: { queueSlots: seeded } });
    const view = await mount(true);
    await view.click(view.find('button[aria-label="Queue slots"]'));
    const fields = () => [
      ...document.querySelectorAll<HTMLInputElement>('input[aria-label="active slots"]'),
    ];
    expect(fields().map((f) => f.value)).toEqual(["2", "2"]);

    const tabField = fields()[0]!;
    tabField.focus();
    await type(tabField, "5");
    await blur(tabField);
    expect(fixture.calls.map((c) => c.value.input.patch.queueSlots)).toEqual([{ slots: 5 }]);
    const echoed: QueueSlotSettings = { ...seeded, slots: 5 };
    await act(async () => {
      fixture.calls[0]!.reply(echoed);
      registry.set(configAtom, { settings: { queueSlots: echoed } });
    });
    expect(fields().map((f) => f.value)).toEqual(["5", "5"]);
  });

  it("drops a value still waiting in one field when the other field commits later", async () => {
    fixture.primary = { environmentId: "env-primary" };
    const seeded: QueueSlotSettings = { slots: 1, perProvider: false, providerSlots: {} };
    registry.set(configAtom, { settings: { queueSlots: seeded } });
    const view = await mount(true);
    const increase = () => [
      ...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Increase active slots"]'),
    ];
    const sent = () => fixture.calls.map((c) => c.value.input.patch.queueSlots);
    // The tab sends 2 and keeps 3 waiting; the popover, still showing 1, then commits 2.
    await view.click(increase()[0]!);
    await view.click(increase()[0]!);
    await view.click(view.find('button[aria-label="Queue slots"]'));
    expect(increase()).toHaveLength(2);
    await view.click(increase()[1]!);
    expect(sent()).toEqual([{ slots: 2 }, { slots: 2 }]);
    await act(async () => {
      fixture.calls[0]!.reply({ ...seeded, slots: 2 });
    });
    expect(sent()).toEqual([{ slots: 2 }, { slots: 2 }]);
  });
});
