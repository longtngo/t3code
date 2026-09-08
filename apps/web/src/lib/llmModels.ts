import type { LlmModel, LlmModelsSample, LlmProvider } from "@t3tools/contracts";

export type { LlmModel, LlmModelsSample, LlmProvider };

/** Compact token-count label, e.g. 163223 -> "163k ctx", 1_050_000 -> "1.1M ctx". */
export function formatContext(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "";
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M ctx`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k ctx`;
  return `${tokens} ctx`;
}
