/**
 * `titleRegenerationFailedAt` is persisted, so it arrives in the first snapshot and with every
 * unrelated update. Report the CHANGE, not the value, or old failures replay on every page load.
 */
export function shouldReportTitleRegenerationFailure(input: {
  /** False for a thread this client has not seen before, i.e. hydration. */
  readonly observedBefore: boolean;
  readonly previousFailedAt: string | null;
  readonly failedAt: string | null;
}): boolean {
  if (!input.observedBefore) return false;
  if (input.failedAt === null) return false;
  return input.failedAt !== input.previousFailedAt;
}
