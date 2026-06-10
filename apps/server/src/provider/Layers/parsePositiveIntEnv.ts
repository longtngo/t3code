/**
 * Parse a positive integer from a process environment variable.
 * Returns `undefined` if the variable is unset, empty, non-numeric, non-finite,
 * or not a positive (> 0) integer.
 */
export function parsePositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
