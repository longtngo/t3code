/**
 * The sidebar Queue's slot settings live on the primary environment's server, so every client of
 * that machine shares them. The device's local copy (`queueSlotSettingsStore`) is the fallback
 * when there is no primary (the hosted app, desktop with its local environment off) and until the
 * primary has a value, and is imported into the primary once.
 */
import { useAtomValue } from "@effect/atom-react";
import { AuthSettingsWriteScope, type QueueSlotSettings } from "@t3tools/contracts";
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
import { useEnvironmentScope } from "./state/session";
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

/** Whether the primary grants `settings:write` - the same check sidebar sections use. An older
 *  pairing lacks it, and the server refuses the write. False with no primary. */
function usePrimaryCanWriteSettings(): boolean {
  const primaryId = usePrimaryEnvironment()?.environmentId ?? null;
  return useEnvironmentScope(primaryId, AuthSettingsWriteScope);
}

/** How a queue slot edit lands: `write` with no primary (the device copy is the value) or when the
 *  primary grants `settings:write`; `device` while a primary without it has no value yet (the edit
 *  stays in the device copy, which is still the effective one); otherwise `none`. */
export function useQueueSlotsAccess(): "write" | "device" | "none" {
  const hasPrimary = usePrimaryEnvironment() !== null;
  const canWrite = usePrimaryCanWriteSettings();
  // A config that has not arrived may still carry a value, so it counts as one.
  const config = useAtomValue(primaryServerConfigAtom);
  const serverHasValue = config === null || config.settings.queueSlots !== undefined;
  if (!hasPrimary || canWrite) return "write";
  return serverHasValue ? "none" : "device";
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
 * Writes to the device copy, then the primary, always carrying the whole device copy as
 * `queueSlotsImport` (applied only when the server has no value), so a partial patch never lands on
 * an absent one. Resolves to the server's value, or null on failure, no primary, a refused rewrite,
 * or a primary lacking `settings:write` (the edit then stays on this device).
 */
export function useSetQueueSlots(): (patch: QueueSlotPatch) => Promise<QueueSlotSettings | null> {
  const primaryId = usePrimaryEnvironment()?.environmentId ?? null;
  // A failed edit is reported like other settings writes; the device copy already has it.
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const canWrite = usePrimaryCanWriteSettings();
  return useCallback(
    async (patch) => {
      useQueueSlotSettingsStore.getState().apply(patch);
      if (primaryId === null || !canWrite) return null;
      const local = readLocalQueueSlots();
      const result = await updateSettings({
        environmentId: primaryId,
        input: { patch: { queueSlotsImport: local, queueSlots: normalizedPatch(patch, local) } },
      });
      return result._tag === "Success" ? (result.value.queueSlots ?? local) : null;
    },
    [canWrite, primaryId, updateSettings],
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
 * The device-copy import is done only once a reply carries `queueSlots`. A server that refuses the
 * write, or drops the unknown field, replies success without it and broadcasts every write, so
 * retries are capped per load or they would loop.
 */
const MAX_IMPORT_ATTEMPTS = 3;
export function useImportLocalQueueSlots(): void {
  const primaryId = usePrimaryEnvironment()?.environmentId ?? null;
  const config = useAtomValue(primaryServerConfigAtom);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const writable = usePrimaryCanWriteSettings();
  const state = useRef<"idle" | "sending" | "done">("idle");
  const attempts = useRef(0);
  useEffect(() => {
    if (!writable) return;
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
  }, [config, primaryId, updateSettings, writable]);
}
