import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  QUEUE_SLOT_SETTINGS_STORAGE_KEY,
  useQueueSlotSettingsStore,
} from "./queueSlotSettingsStore";
import {
  subscribeToCrossTabThreadQueueUpdates,
  THREAD_QUEUE_STORAGE_KEY,
  useThreadQueueStore,
} from "./threadQueueStore";

// This happy-dom has no `window.localStorage`, and the stores capture it at import, so the stub
// must exist before the store modules load.
const localStorage = vi.hoisted(() => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
  };
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
  return storage;
});

const saved = { slots: 3, perProvider: true, providerSlots: { claudeAgent_personalsub: 2 } };
const writeSettings = (state: unknown) =>
  localStorage.setItem(QUEUE_SLOT_SETTINGS_STORAGE_KEY, JSON.stringify({ state, version: 1 }));
const storedSettings = () =>
  JSON.parse(localStorage.getItem(QUEUE_SLOT_SETTINGS_STORAGE_KEY)!).state;

describe("queueSlotSettingsStore storage", () => {
  beforeEach(() => {
    localStorage.clear();
    useQueueSlotSettingsStore.setState({ slots: 1, perProvider: false, providerSlots: {} });
  });

  it("round-trips slot settings through its own key and loads bad data as defaults", async () => {
    const store = useQueueSlotSettingsStore.getState();
    store.setSlots(3);
    store.setPerProvider(true);
    store.setProviderSlots("claudeAgent_personalsub", 2);
    expect(storedSettings()).toEqual(saved);
    vi.resetModules();
    const fresh = await import("./queueSlotSettingsStore");
    expect(fresh.useQueueSlotSettingsStore.getState()).toMatchObject(saved);

    writeSettings({ slots: "x", perProvider: "yes", providerSlots: { a: -4, b: "z" } });
    await useQueueSlotSettingsStore.persist.rehydrate();
    expect(useQueueSlotSettingsStore.getState()).toMatchObject({
      slots: 1,
      perProvider: false,
      providerSlots: { a: 0, b: 1 },
    });

    writeSettings({ slots: 2, perProvider: true, providerSlots: null });
    await useQueueSlotSettingsStore.persist.rehydrate();
    expect(useQueueSlotSettingsStore.getState()).toMatchObject({ slots: 2, providerSlots: {} });
  });

  it("keeps slot settings when a tab on the previous version writes the queue", async () => {
    const store = useQueueSlotSettingsStore.getState();
    store.setSlots(3);
    store.setPerProvider(true);
    store.setProviderSlots("claudeAgent_personalsub", 2);
    // The previous version kept no slot settings and writes the whole queue state.
    localStorage.setItem(
      THREAD_QUEUE_STORAGE_KEY,
      JSON.stringify({
        state: { entries: [], paused: true, inFlight: null, lastFailure: null },
        version: 1,
      }),
    );
    await useThreadQueueStore.persist.rehydrate();
    await useQueueSlotSettingsStore.persist.rehydrate();
    expect(useThreadQueueStore.getState().paused).toBe(true);
    expect(useQueueSlotSettingsStore.getState()).toMatchObject(saved);
    expect(storedSettings()).toEqual(saved);

    vi.resetModules();
    const fresh = await import("./queueSlotSettingsStore");
    expect(fresh.useQueueSlotSettingsStore.getState()).toMatchObject(saved);
  });

  it("rehydrates slot settings another tab changed", async () => {
    const unsubscribe = subscribeToCrossTabThreadQueueUpdates();
    try {
      writeSettings(saved);
      window.dispatchEvent(new StorageEvent("storage", { key: QUEUE_SLOT_SETTINGS_STORAGE_KEY }));
      await vi.waitFor(() => expect(useQueueSlotSettingsStore.getState()).toMatchObject(saved));
    } finally {
      unsubscribe();
    }
  });

  it("reloads each store only for its own key, and both when storage is cleared", () => {
    const unsubscribe = subscribeToCrossTabThreadQueueUpdates();
    const queue = vi.spyOn(useThreadQueueStore.persist, "rehydrate");
    const settings = vi.spyOn(useQueueSlotSettingsStore.persist, "rehydrate");
    const reloadsFor = (key: string | null) => {
      queue.mockClear();
      settings.mockClear();
      window.dispatchEvent(new StorageEvent("storage", { key }));
      return [queue.mock.calls.length, settings.mock.calls.length];
    };
    try {
      expect(reloadsFor(THREAD_QUEUE_STORAGE_KEY)).toEqual([1, 0]);
      expect(reloadsFor(QUEUE_SLOT_SETTINGS_STORAGE_KEY)).toEqual([0, 1]);
      expect(reloadsFor(null)).toEqual([1, 1]);
      expect(reloadsFor("unrelated")).toEqual([0, 0]);
    } finally {
      unsubscribe();
      queue.mockRestore();
      settings.mockRestore();
    }
  });
});
