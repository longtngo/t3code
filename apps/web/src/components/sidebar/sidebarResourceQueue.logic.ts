import type { ResourceQueueItem } from "@t3tools/contracts";

/**
 * A resctl job carries only free-form text (`reason`) plus timing anchors — there is no
 * structured "name / description / estimated-duration" split. These pure helpers derive the
 * richer row presentation (a wrapped name + optional description line, and a running/estimated
 * progress ring) from that free text, so the sidebar component stays a thin renderer and the
 * derivation is unit-tested in isolation.
 */

/** The accent classes a pool is drawn with: its label badge and its capacity bar. */
export interface ResourceAccent {
  readonly badge: string;
  readonly bar: string;
}

const FALLBACK_ACCENT: ResourceAccent = {
  badge: "bg-muted text-muted-foreground",
  bar: "bg-foreground",
};

// Matched by prefix, longest first, because the broker splits and adds pools over time — the
// CPU pool became `cpu_perf` + `cpu_eff`, and each configured test device adds a `dev_*` pool.
// Exact-name matching silently drops such a pool to the gray fallback the moment it is renamed.
const RESOURCE_ACCENTS: ReadonlyArray<readonly [string, ResourceAccent]> = [
  ["gpu", { badge: "bg-violet-400/15 text-violet-300", bar: "bg-violet-400" }],
  ["cpu", { badge: "bg-emerald-400/15 text-emerald-300", bar: "bg-emerald-400" }],
  ["dev", { badge: "bg-sky-400/15 text-sky-300", bar: "bg-sky-400" }],
  ["machine", { badge: "bg-amber-400/15 text-amber-300", bar: "bg-amber-400" }],
];

/**
 * Accent classes for a broker pool name. Unknown pools get a neutral fallback rather than no
 * styling, so a pool this build has never heard of still renders legibly.
 */
export function resourceAccent(name: string): ResourceAccent {
  const key = name.toLowerCase();
  for (const [prefix, accent] of RESOURCE_ACCENTS) {
    if (key === prefix || key.startsWith(`${prefix}_`)) return accent;
  }
  return FALLBACK_ACCENT;
}

/** A reason line split into a primary name and an optional secondary description. */
export interface ReasonParts {
  readonly name: string;
  readonly description?: string;
}

// The first " — ", " – ", or ": " separates a short lead-in (name) from the rest (description).
// A dash is only a separator when preceded by a space and followed by a space or end-of-string,
// so ranges like "50-70" aren't split; a dangling trailing dash is swallowed (no description).
const REASON_SEPARATOR = /\s+[—–](?=\s|$)\s*|:\s+/;

/**
 * Split a job's reason into a name and an optional description. Jobs frequently write
 * "short label — details…" or "label: details…"; when no separator is present the whole
 * reason is the name and there is no description.
 */
export function splitReason(reason: string): ReasonParts {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return { name: "" };
  const match = REASON_SEPARATOR.exec(trimmed);
  if (match == null || match.index === 0) return { name: trimmed };
  const name = trimmed.slice(0, match.index).trim();
  const description = trimmed.slice(match.index + match[0].length).trim();
  if (name.length === 0) return { name: trimmed };
  if (description.length === 0) return { name };
  return { name, description };
}

// A rough duration mined from a reason, e.g. "~14 min ETA", "~50-70min", "~3m", "2h".
// A hyphenated range takes the upper bound (the pessimistic estimate). Units: h / m / s.
const DURATION_RE =
  /~?\s*(\d+(?:\.\d+)?)\s*(?:[-–]\s*(\d+(?:\.\d+)?)\s*)?(h(?:ours?|rs?)?|min(?:ute)?s?|m|s(?:ec(?:onds?)?)?)\b/i;

function unitToSeconds(value: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("h")) return value * 3600;
  if (u === "s" || u.startsWith("sec")) return value;
  return value * 60; // "m", "min", "minute(s)"
}

/**
 * Mine a rough estimated *total* duration (seconds) from a reason's free text, or undefined
 * when none is stated. This is the only estimate resctl jobs actually carry, so the ring uses
 * it and simply hides when it's absent.
 */
export function parseEstimateSeconds(reason: string): number | undefined {
  const match = DURATION_RE.exec(reason);
  if (match == null) return undefined;
  const unit = match[3];
  if (unit == null) return undefined;
  const lower = Number(match[1]);
  const upper = match[2] != null ? Number(match[2]) : lower;
  const pick = Number.isFinite(upper) ? upper : lower;
  if (!Number.isFinite(pick) || pick <= 0) return undefined;
  return unitToSeconds(pick, unit);
}

/** Live elapsed seconds since the job started holding / was enqueued. */
export function elapsedSeconds(item: ResourceQueueItem, nowMs: number): number {
  return Math.max(0, (nowMs - item.sinceMs) / 1000);
}

/**
 * Estimated total run time (seconds) for a running job: prefer a duration mined from the
 * reason; otherwise, if the broker supplied an ETA (remaining), add it to the elapsed time.
 * Undefined when neither is available — the ring then shows nothing.
 */
export function estimatedTotalSeconds(item: ResourceQueueItem, nowMs: number): number | undefined {
  const fromReason = parseEstimateSeconds(item.reason);
  if (fromReason != null) return fromReason;
  if (item.etaSec != null && item.etaSec > 0) return elapsedSeconds(item, nowMs) + item.etaSec;
  return undefined;
}

/** Row progress: a queued job (no elapsed time yet), a running job with a known %, or one without. */
export type RowProgress =
  | { readonly state: "waiting" }
  | { readonly state: "running"; readonly pct: number | null };

/**
 * Compute a running/estimated progress percentage for a job. Waiting jobs have not started, so
 * they carry no percentage (the ring renders a dashed "queued" placeholder). Running jobs get a
 * clamped 0–100 percentage when an estimate exists, or `null` when it doesn't.
 */
export function rowProgress(item: ResourceQueueItem, nowMs: number): RowProgress {
  if (item.state !== "running") return { state: "waiting" };
  const total = estimatedTotalSeconds(item, nowMs);
  if (total == null || total <= 0) return { state: "running", pct: null };
  const pct = Math.round((elapsedSeconds(item, nowMs) / total) * 100);
  return { state: "running", pct: Math.max(0, Math.min(100, pct)) };
}
