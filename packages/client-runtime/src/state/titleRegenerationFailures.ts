/**
 * Decides whether an observed title-regeneration failure is new enough to tell
 * the user about.
 *
 * `titleRegenerationFailedAt` is persisted on the thread, so it is present in
 * the very first snapshot a client receives and is re-sent with every unrelated
 * shell update. Reporting the value would therefore replay old failures on
 * every page load and repeat them on unrelated changes; reporting the *change*
 * is what makes it a one-shot.
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
