/** Pure helpers for the Local Models settings panel (unit-tested in the sibling test). */

/** Bytes → GB for display. `0` (the "auto" sentinel) stays `0`. */
export function bytesToGb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round((bytes / 1e9) * 10) / 10;
}

/** GB (from the input) → bytes for storage. Negatives/NaN clamp to `0` (= auto). */
export function gbToBytes(gb: number): number {
  if (!Number.isFinite(gb) || gb <= 0) return 0;
  return Math.round(gb * 1e9);
}

/** Append a launch-arg token, ignoring blank input. One token = one argv element. */
export function addArg(args: readonly string[], token: string): string[] {
  const trimmed = token.trim();
  if (trimmed === "") return [...args];
  return [...args, trimmed];
}

/** Remove the launch-arg at `index` (no-op if out of range). */
export function removeArgAt(args: readonly string[], index: number): string[] {
  if (index < 0 || index >= args.length) return [...args];
  return args.filter((_, i) => i !== index);
}

export type PerModel = Record<string, { args?: readonly string[] }>;

/** Set (or clear) the args for one per-model override key. */
export function setPerModelArgs(perModel: PerModel, modelId: string, args: readonly string[]): PerModel {
  return { ...perModel, [modelId]: { args: [...args] } };
}

/**
 * Rename a per-model override key, preserving its args. No-op when `to` is empty, equal to
 * `from`, or already an existing key — renaming onto an existing key would silently merge
 * the two entries and lose one's args.
 */
export function renamePerModelKey(perModel: PerModel, from: string, to: string): PerModel {
  if (to === "" || from === to || perModel[to] !== undefined) return { ...perModel };
  const next: PerModel = {};
  for (const [k, v] of Object.entries(perModel)) next[k === from ? to : k] = v;
  return next;
}

/** Remove a per-model override entirely. */
export function removePerModel(perModel: PerModel, modelId: string): PerModel {
  const next: PerModel = {};
  for (const [k, v] of Object.entries(perModel)) {
    if (k !== modelId) next[k] = v;
  }
  return next;
}
