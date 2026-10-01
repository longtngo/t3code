import { beforeEach, describe, expect, it } from "vite-plus/test";

import { readLocalQueueSlots, useQueueSlotSettingsStore } from "./queueSlotSettingsStore";

describe("queueSlotSettingsStore", () => {
  beforeEach(() => {
    useQueueSlotSettingsStore.setState({ slots: 1, perProvider: false, providerSlots: {} });
  });

  it("clamps slot values", () => {
    const store = useQueueSlotSettingsStore.getState();
    store.apply({ slots: -3 });
    expect(useQueueSlotSettingsStore.getState().slots).toBe(0);
    store.apply({ slots: 250 });
    expect(useQueueSlotSettingsStore.getState().slots).toBe(99);
    store.apply({ slots: 2.7 });
    expect(useQueueSlotSettingsStore.getState().slots).toBe(2);
    store.apply({ providerSlots: { claudeAgent: 1000 } });
    expect(useQueueSlotSettingsStore.getState().providerSlots).toEqual({ claudeAgent: 99 });
  });

  it("applies a patch per field and per provider entry, normalized like the server's value", () => {
    useQueueSlotSettingsStore.setState({ providerSlots: { codex: 4 } });
    const store = useQueueSlotSettingsStore.getState();
    store.apply({ providerSlots: { claudeAgent: -1.5 } });
    store.apply({ perProvider: true });
    expect(readLocalQueueSlots()).toEqual({
      slots: 1,
      perProvider: true,
      providerSlots: { codex: 4, claudeAgent: 0 },
    });
  });
});
