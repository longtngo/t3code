import type { LlmModel, LlmModelsSample, LlmProvider } from "@t3tools/contracts";

export type { LlmModel, LlmModelsSample, LlmProvider };

/** Total number of resident (loaded) models across all reachable providers. */
export function countResident(sample: LlmModelsSample | null): number {
  if (!sample) return 0;
  let count = 0;
  for (const provider of sample.providers) {
    for (const model of provider.models) {
      if (model.loaded) count += 1;
    }
  }
  return count;
}

/** Total number of models known across providers (resident + idle/available). */
export function countAvailable(sample: LlmModelsSample | null): number {
  if (!sample) return 0;
  let count = 0;
  for (const provider of sample.providers) count += provider.models.length;
  return count;
}

/** Compact token-count label, e.g. 163223 -> "163k ctx", 1_050_000 -> "1.1M ctx". */
export function formatContext(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "";
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M ctx`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k ctx`;
  return `${tokens} ctx`;
}
