import type { LlmModel, LlmModelsSample, LocalLlmModelConfig } from "@t3tools/contracts";
import { getModel, getProvider } from "@t3tools/shared/localLlm";

import type { SidebarFooterBadgeTone } from "./sidebarFooterBadge";

export type SidebarModelStatus = "online" | "offline" | "loading" | "stopping" | "error";

export interface SidebarRow {
  readonly configId: string;
  readonly name: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly status: SidebarModelStatus;
  /** Managed providers can be load/unloaded; external ones are probe-only. */
  readonly loadable: boolean;
  readonly pid?: number | undefined;
  readonly port?: number | undefined;
  readonly sizeBytes?: number | undefined;
  readonly contextWindow?: number | undefined;
}

function indexSampleByConfig(sample: LlmModelsSample | null): Map<string, LlmModel> {
  const byConfig = new Map<string, LlmModel>();
  for (const p of sample?.providers ?? []) {
    for (const m of p.models) {
      if (m.configId) byConfig.set(m.configId, m);
    }
  }
  return byConfig;
}

/**
 * Join the user's (visible) model configs with the live status sample. The sidebar
 * list is config-sourced, not probe-discovered: a config with no live row is offline.
 */
export function mergeConfigsWithSample(
  models: readonly LocalLlmModelConfig[],
  sample: LlmModelsSample | null,
): SidebarRow[] {
  const byConfig = indexSampleByConfig(sample);
  return models
    .filter((c) => c.visible)
    .map((c) => {
      const provider = getProvider(c.providerId);
      const live = byConfig.get(c.id);
      const status = (live?.status ?? "offline") as SidebarModelStatus;
      return {
        configId: c.id,
        name: c.name,
        providerId: c.providerId,
        providerName: provider?.name ?? c.providerId,
        modelId: c.modelId,
        status,
        loadable: provider?.managed ?? false,
        pid: live?.pid,
        port: live?.port,
        sizeBytes: live?.sizeBytes ?? getModel(c.modelId)?.approxBytes,
        contextWindow: c.contextWindow,
      };
    });
}

/** Count of rows currently online (for the sidebar header dot/count). */
export function countOnline(rows: readonly SidebarRow[]): number {
  return rows.filter((r) => r.status === "online").length;
}

/** Count of rows in a transitional state (loading/stopping). */
export function countBusy(rows: readonly SidebarRow[]): number {
  return rows.filter((r) => r.status === "loading" || r.status === "stopping").length;
}

/**
 * How the footer badge should read for a given load state.
 *
 * The number is always the loaded count — the badge answers "how many models are resident",
 * and folding a transient loading count into the same digits would make the same "1" mean two
 * different things. A load in flight shows in the tone instead.
 */
export function localModelsBadge(
  online: number,
  busy: number,
): { readonly tone: SidebarFooterBadgeTone; readonly label: string } {
  const loaded = `${String(online)} local ${online === 1 ? "model" : "models"} loaded`;
  return {
    tone: online > 0 ? "active" : busy > 0 ? "pending" : "idle",
    label: busy > 0 ? `${loaded}, ${String(busy)} loading` : loaded,
  };
}
