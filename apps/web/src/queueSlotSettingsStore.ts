/**
 * How many threads the sidebar Queue lets be busy before it sends, overall or per provider
 * instance. This is the device's copy, shared by its tabs: read when there is no primary
 * environment (or before it has a value), and sent to the primary as a one-time import.
 * `queueSlotSettings.ts` picks the effective value.
 *
 * Stored under its own key, not the queue's: a tab still running a build from before these
 * settings existed writes the whole queue state, and would drop them from a shared key.
 */
import {
  normalizeQueueSlots,
  type QueueSlotSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const QUEUE_SLOT_SETTINGS_STORAGE_KEY = "t3code:queue-slots:v1";

/** Only the fields being changed; `providerSlots` merges per instance. */
export type QueueSlotPatch = NonNullable<ServerSettingsPatch["queueSlots"]>;

interface QueueSlotSettingsState extends QueueSlotSettings {
  /** Merges the patch and normalizes the result (slot counts become integers in 0..99). */
  readonly apply: (patch: QueueSlotPatch) => void;
}

const pick = (state: QueueSlotSettings): QueueSlotSettings => ({
  slots: state.slots,
  perProvider: state.perProvider,
  providerSlots: state.providerSlots,
});

/** The device's three fields, read now. */
export function readLocalQueueSlots(): QueueSlotSettings {
  return pick(useQueueSlotSettingsStore.getState());
}

export const useQueueSlotSettingsStore = create<QueueSlotSettingsState>()(
  persist(
    (set) => ({
      ...normalizeQueueSlots(undefined),
      apply: (patch) =>
        set((state) =>
          normalizeQueueSlots({
            ...pick(state),
            ...patch,
            providerSlots: { ...state.providerSlots, ...patch.providerSlots },
          }),
        ),
    }),
    {
      name: QUEUE_SLOT_SETTINGS_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => pick(state),
      merge: (persisted, current) => ({ ...current, ...normalizeQueueSlots(persisted) }),
    },
  ),
);
