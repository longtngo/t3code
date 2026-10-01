import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useQueueSlotSettingsStore } from "./queueSlotSettingsStore";

describe("queueSlotSettingsStore", () => {
  beforeEach(() => {
    useQueueSlotSettingsStore.setState({ slots: 1, perProvider: false, providerSlots: {} });
  });

  it("clamps slot values", () => {
    const store = useQueueSlotSettingsStore.getState();
    store.setSlots(-3);
    expect(useQueueSlotSettingsStore.getState().slots).toBe(0);
    store.setSlots(250);
    expect(useQueueSlotSettingsStore.getState().slots).toBe(99);
    store.setSlots(2.7);
    expect(useQueueSlotSettingsStore.getState().slots).toBe(2);
    store.setProviderSlots("claudeAgent", 1000);
    expect(useQueueSlotSettingsStore.getState().providerSlots).toEqual({ claudeAgent: 99 });
  });
});
