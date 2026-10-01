import { RegistryContext } from "@effect/atom-react";
import type { QueueSlotSettings } from "@t3tools/contracts";
import { type Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The primary environment, its server config atom and the settings command's network call are
// stubbed; the local store and the command runner (with its failure reporting) are the real ones.
const fixture = vi.hoisted(() => ({
  primary: { environmentId: "env-primary" } as { environmentId: string } | null,
  calls: [] as Array<{ label: string; value: unknown }>,
  // The server's `queueSlots` in the reply; `undefined` models a refused import.
  replyQueueSlots: undefined as unknown,
  replyFails: false,
  // While set, each call waits on it before replying.
  hold: null as Promise<void> | null,
}));

vi.mock("./state/environments", () => ({
  usePrimaryEnvironment: () => fixture.primary,
}));
vi.mock("./state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/server")>();
  const { Atom, AsyncResult } = await import("effect/unstable/reactivity");
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  const primaryServerConfigAtom = Atom.make<{ settings: Record<string, unknown> } | null>(null);
  const { Cause } = await import("effect");
  const label = actual.serverEnvironment.updateSettings.label;
  return {
    ...actual,
    primaryServerConfigAtom,
    primaryServerSettingsAtom: Atom.make(
      (get) => get(primaryServerConfigAtom)?.settings ?? DEFAULT_SERVER_SETTINGS,
    ),
    serverEnvironment: {
      ...actual.serverEnvironment,
      updateSettings: {
        label,
        run: async (_registry: unknown, value: unknown) => {
          fixture.calls.push({ label, value });
          if (fixture.hold !== null) await fixture.hold;
          return fixture.replyFails
            ? AsyncResult.failure(Cause.fail(new Error("offline")))
            : AsyncResult.success({ queueSlots: fixture.replyQueueSlots });
        },
      },
    },
  };
});

import {
  QUEUE_SLOT_SETTINGS_STORAGE_KEY,
  useQueueSlotSettingsStore,
} from "./queueSlotSettingsStore";
import {
  useImportLocalQueueSlots,
  useQueueSlotSettings,
  useSetQueueSlots,
} from "./queueSlotSettings";
import { primaryServerConfigAtom } from "./state/server";
import { renderDom } from "./testing/renderDom";

const configAtom = primaryServerConfigAtom as unknown as Atom.Writable<{
  settings: Record<string, unknown>;
} | null>;

let registry: AtomRegistry.AtomRegistry;
const seen: { value: QueueSlotSettings | null; set: ReturnType<typeof useSetQueueSlots> | null } = {
  value: null,
  set: null,
};

function Probe(props: { importLocal?: boolean }) {
  const value = useQueueSlotSettings();
  const set = useSetQueueSlots();
  useEffect(() => {
    seen.value = value;
    seen.set = set;
  });
  return props.importLocal ? <Importer /> : null;
}
function Importer() {
  useImportLocalQueueSlots();
  return null;
}

const mount = (importLocal = false) =>
  renderDom(
    <RegistryContext.Provider value={registry}>
      <Probe importLocal={importLocal} />
    </RegistryContext.Provider>,
  );
const setConfig = (queueSlots?: QueueSlotSettings) =>
  act(async () => {
    registry.set(configAtom, { settings: queueSlots === undefined ? {} : { queueSlots } });
  });
const set = (patch: Parameters<ReturnType<typeof useSetQueueSlots>>[0]) =>
  act(async () => {
    await seen.set!(patch);
  });
const local = { slots: 5, perProvider: false, providerSlots: { codex: 2 } };
const server = { slots: 3, perProvider: true, providerSlots: {} };
const storeLocalKey = () => useQueueSlotSettingsStore.getState().apply({ slots: 5 });
const updateCalls = () =>
  fixture.calls.filter((call) => call.label === "environment-data:server:update-settings");

beforeEach(() => {
  // The store persists on every set; clear after it so no test starts with a device copy saved.
  useQueueSlotSettingsStore.setState(local);
  localStorage.clear();
  registry = AtomRegistry.make();
  fixture.primary = { environmentId: "env-primary" };
  fixture.calls.length = 0;
  fixture.replyQueueSlots = undefined;
  fixture.replyFails = false;
  fixture.hold = null;
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("queue slot settings without a primary", () => {
  it("reads and writes the device copy only", async () => {
    fixture.primary = null;
    storeLocalKey();
    await mount(true);
    // A config left over from an earlier primary is not this device's value.
    await setConfig(server);
    expect(seen.value?.slots).toBe(5);
    let reply: QueueSlotSettings | null | undefined;
    await act(async () => {
      reply = await seen.set!({ slots: 4 });
    });
    expect(reply).toBeNull();
    expect(useQueueSlotSettingsStore.getState().slots).toBe(4);
    expect(seen.value?.slots).toBe(4);
    expect(fixture.calls).toEqual([]);
  });
});

describe("queue slot settings with a primary", () => {
  it("uses the device copy until the primary has a value, then the server's", async () => {
    useQueueSlotSettingsStore.setState({ slots: 0 });
    await mount();
    expect(seen.value?.slots).toBe(0);
    await setConfig();
    expect(seen.value?.slots).toBe(0);
    await setConfig(server);
    expect(seen.value).toEqual(server);
    await setConfig({ ...server, slots: 7 });
    expect(seen.value?.slots).toBe(7);
  });

  it("sends only the changed field, with the whole device copy as the import", async () => {
    fixture.replyQueueSlots = { ...server, perProvider: true };
    await mount();
    let reply: QueueSlotSettings | null | undefined;
    await act(async () => {
      reply = await seen.set!({ perProvider: true });
    });
    expect(reply).toEqual(fixture.replyQueueSlots);
    await set({ providerSlots: { codex: 250 } });
    expect(updateCalls().map((call) => call.value)).toEqual([
      {
        environmentId: "env-primary",
        input: {
          patch: {
            queueSlotsImport: { slots: 5, perProvider: true, providerSlots: { codex: 2 } },
            queueSlots: { perProvider: true },
          },
        },
      },
      {
        environmentId: "env-primary",
        input: {
          patch: {
            queueSlotsImport: { slots: 5, perProvider: true, providerSlots: { codex: 99 } },
            queueSlots: { providerSlots: { codex: 99 } },
          },
        },
      },
    ]);
  });

  it("resolves to null on a failed write and reports it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await mount();
    let reply: QueueSlotSettings | null | undefined;
    fixture.replyFails = true;
    await act(async () => {
      reply = await seen.set!({ slots: 8 });
    });
    expect(reply).toBeNull();
    // A failed edit is reported like every other failed settings write.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      "[atom-command] environment-data:server:update-settings failed",
    );
  });
});

describe("importing the device copy", () => {
  it("sends the device copy once a reply carries the server's value", async () => {
    storeLocalKey();
    expect(localStorage.getItem(QUEUE_SLOT_SETTINGS_STORAGE_KEY)).not.toBeNull();
    const view = await mount(true);
    expect(updateCalls()).toEqual([]);

    // The reply lacks `queueSlots` (the server refused): the next config change retries.
    await setConfig();
    expect(updateCalls().map((call) => call.value)).toEqual([
      { environmentId: "env-primary", input: { patch: { queueSlotsImport: local } } },
    ]);
    fixture.replyQueueSlots = local;
    await setConfig();
    expect(updateCalls()).toHaveLength(2);

    await setConfig();
    await view.rerender(
      <RegistryContext.Provider value={registry}>
        <Probe importLocal />
      </RegistryContext.Provider>,
    );
    expect(updateCalls()).toHaveLength(2);
  });

  it("sends one import at a time", async () => {
    let release = () => {};
    fixture.hold = new Promise((resolve) => {
      release = resolve;
    });
    storeLocalKey();
    await mount(true);
    await setConfig();
    await setConfig();
    expect(updateCalls()).toHaveLength(1);
    fixture.replyQueueSlots = local;
    await act(async () => {
      release();
    });
    await setConfig();
    expect(updateCalls()).toHaveLength(1);
  });

  it("stops after three refused imports, so a server that drops the field cannot loop", async () => {
    storeLocalKey();
    await mount(true);
    for (let i = 0; i < 6; i++) await setConfig();
    expect(updateCalls()).toHaveLength(3);
  });

  it("does not report a failed import", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fixture.replyFails = true;
    storeLocalKey();
    await mount(true);
    await setConfig();
    expect(updateCalls()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("sends nothing without a device copy or when the server has a value", async () => {
    await mount(true);
    await setConfig();
    expect(updateCalls()).toEqual([]);
    storeLocalKey();
    await setConfig(server);
    expect(updateCalls()).toEqual([]);
  });
});
