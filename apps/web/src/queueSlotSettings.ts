/**
 * The sidebar Queue's slot settings live on the primary environment's server, so every client of
 * that machine shares them. The device's local copy (`queueSlotSettingsStore`) is the fallback
 * when there is no primary (the hosted app, desktop with its local environment off) and until the
 * primary has a value, and is imported into the primary once.
 */
import { useAtomValue } from "@effect/atom-react";
import type { QueueSlotSettings } from "@t3tools/contracts";
import { useCallback, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  QUEUE_SLOT_SETTINGS_STORAGE_KEY,
  readLocalQueueSlots,
  useQueueSlotSettingsStore,
  type QueueSlotPatch,
} from "./queueSlotSettingsStore";
import { usePrimaryEnvironment } from "./state/environments";
import {
  primaryServerConfigAtom,
  primaryServerSettingsAtom,
  serverEnvironment,
} from "./state/server";
import { useAtomCommand } from "./state/use-atom-command";

/** The value the popover, the settings tab and the coordinator act on: the server's wins. */
export function useQueueSlotSettings(): QueueSlotSettings {
  const hasPrimary = usePrimaryEnvironment() !== null;
  const server = useAtomValue(primaryServerSettingsAtom).queueSlots;
  const local = useQueueSlotSettingsStore(
    useShallow((state) => ({
      slots: state.slots,
      perProvider: state.perProvider,
      providerSlots: state.providerSlots,
    })),
  );
  return hasPrimary ? (server ?? local) : local;
}

/** The patch's fields as the local store normalized them, so the server gets integers in 0..99. */
function normalizedPatch(patch: QueueSlotPatch, local: QueueSlotSettings): QueueSlotPatch {
  return {
    ...(patch.slots !== undefined && { slots: local.slots }),
    ...(patch.perProvider !== undefined && { perProvider: local.perProvider }),
    ...(patch.providerSlots !== undefined && {
      providerSlots: Object.fromEntries(
        Object.keys(patch.providerSlots).map((id) => [id, local.providerSlots[id] ?? 1]),
      ),
    }),
  };
}

/**
 * Writes the changed field(s) to the device copy, then to the primary. Every server write carries
 * the whole device copy as `queueSlotsImport`, which the server applies only when it has no value,
 * so a partial patch never lands on an absent one. Resolves to the server's value after the write,
 * or null on failure (including a server that refused to rewrite a broken or externally changed
 * settings file) or with no primary.
 */
export function useSetQueueSlots(): (patch: QueueSlotPatch) => Promise<QueueSlotSettings | null> {
  const primaryId = usePrimaryEnvironment()?.environmentId ?? null;
  // A failed edit is reported like other settings writes; the device copy already has it.
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  return useCallback(
    async (patch) => {
      useQueueSlotSettingsStore.getState().apply(patch);
      if (primaryId === null) return null;
      const local = readLocalQueueSlots();
      const result = await updateSettings({
        environmentId: primaryId,
        input: { patch: { queueSlotsImport: local, queueSlots: normalizedPatch(patch, local) } },
      });
      return result._tag === "Success" ? (result.value.queueSlots ?? local) : null;
    },
    [primaryId, updateSettings],
  );
}

function hasLocalQueueSlots(): boolean {
  try {
    return window.localStorage.getItem(QUEUE_SLOT_SETTINGS_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Sends the device copy to a primary that has no value yet. Done only once a reply carries
 * `queueSlots`: a server that refuses the write (settings file broken or changed on disk) replies
 * success without it, and the next config change retries, up to `MAX_IMPORT_ATTEMPTS` per load: a
 * server that drops the unknown field replies the same way and broadcasts every write, so an
 * unbounded retry would loop.
 */
const MAX_IMPORT_ATTEMPTS = 3;
export function useImportLocalQueueSlots(): void {
  const primaryId = usePrimaryEnvironment()?.environmentId ?? null;
  const config = useAtomValue(primaryServerConfigAtom);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const state = useRef<"idle" | "sending" | "done">("idle");
  const attempts = useRef(0);
  useEffect(() => {
    if (primaryId === null || config === null || config.settings.queueSlots !== undefined) return;
    if (state.current !== "idle" || attempts.current >= MAX_IMPORT_ATTEMPTS) return;
    if (!hasLocalQueueSlots()) return;
    attempts.current++;
    state.current = "sending";
    void updateSettings({
      environmentId: primaryId,
      input: { patch: { queueSlotsImport: readLocalQueueSlots() } },
    }).then((result) => {
      state.current =
        result._tag === "Success" && result.value.queueSlots !== undefined ? "done" : "idle";
    });
  }, [config, primaryId, updateSettings]);
}
