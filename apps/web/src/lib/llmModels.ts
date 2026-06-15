import type { LlmModel, LlmModelsSample, LlmProvider } from "@t3tools/contracts";

export type { LlmModel, LlmModelsSample, LlmProvider };

export type ModelStatus = "online" | "offline" | "loading" | "stopping" | "error";

/** Effective UI status: the manager's `status` if present, else derived from `loaded`. */
export function modelStatus(model: LlmModel): ModelStatus {
  return model.status ?? (model.loaded ? "online" : "offline");
}

function eachModel(sample: LlmModelsSample | null): LlmModel[] {
  if (!sample) return [];
  return sample.providers.flatMap((provider) => provider.models);
}

/** Number of models currently online (resident). */
export function countResident(sample: LlmModelsSample | null): number {
  return eachModel(sample).filter((m) => modelStatus(m) === "online").length;
}

/** Number of models in flight (loading or stopping). */
export function countBusy(sample: LlmModelsSample | null): number {
  return eachModel(sample).filter((m) => {
    const s = modelStatus(m);
    return s === "loading" || s === "stopping";
  }).length;
}

/** Total number of models known (online + offline + transitional). */
export function countAvailable(sample: LlmModelsSample | null): number {
  return eachModel(sample).length;
}

/** Compact token-count label, e.g. 163223 -> "163k ctx", 1_050_000 -> "1.1M ctx". */
export function formatContext(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "";
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M ctx`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k ctx`;
  return `${tokens} ctx`;
}
