/**
 * How many threads the sidebar Queue lets be busy before it sends, overall or per provider
 * instance. Kept on this device only (local storage), shared by its tabs.
 *
 * Stored under its own key, not the queue's: a tab still running a build from before these
 * settings existed writes the whole queue state, and would drop them from a shared key.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const QUEUE_SLOT_SETTINGS_STORAGE_KEY = "t3code:queue-slots:v1";

export const MAX_QUEUE_SLOTS = 99;

interface QueueSlotSettingsState {
  /** How many threads may be busy before the queue sends; 0 holds it. */
  readonly slots: number;
  readonly perProvider: boolean;
  /** Per provider instance, used while `perProvider` is on; kept when it is off. */
  readonly providerSlots: Readonly<Record<string, number>>;
  readonly setSlots: (slots: number) => void;
  readonly setPerProvider: (perProvider: boolean) => void;
  readonly setProviderSlots: (instanceId: string, slots: number) => void;
}

/** Stored or typed slot counts become an integer in 0..99; anything unreadable is the default 1. */
function clampSlots(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(MAX_QUEUE_SLOTS, Math.floor(value)));
}

function clampProviderSlots(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.entries(value).map(([id, n]) => [id, clampSlots(n)]));
}

export const useQueueSlotSettingsStore = create<QueueSlotSettingsState>()(
  persist(
    (set) => ({
      slots: 1,
      perProvider: false,
      providerSlots: {},
      setSlots: (slots) => set({ slots: clampSlots(slots) }),
      setPerProvider: (perProvider) => set({ perProvider }),
      setProviderSlots: (instanceId, slots) =>
        set((state) => ({
          providerSlots: { ...state.providerSlots, [instanceId]: clampSlots(slots) },
        })),
    }),
    {
      name: QUEUE_SLOT_SETTINGS_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        slots: state.slots,
        perProvider: state.perProvider,
        providerSlots: state.providerSlots,
      }),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<QueueSlotSettingsState>;
        return {
          ...current,
          slots: clampSlots(stored.slots),
          perProvider: stored.perProvider === true,
          providerSlots: clampProviderSlots(stored.providerSlots),
        };
      },
    },
  ),
);
