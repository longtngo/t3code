/**
 * Decides whether a settlement-sweep lookup failure is worth logging.
 *
 * The sweep re-enters the failure path every 60 seconds for as long as a group
 * stays a settlement candidate, and the failure below it is already cached and
 * backed off — so every one of those asks re-reported a condition nothing had
 * changed about. Measured on one machine: 472 records and 1.3 MB in 43 minutes,
 * 95% of everything the server logged, which buries every other warning.
 *
 * Only a *change* is news: a different failure, or a recovery. This is the same
 * rule `GitManager`'s `shouldLogPrLookupFailure` applies one layer down, kept
 * deliberately identical in shape so the two read as one idea.
 */
export const SETTLEMENT_FAILURE_LOG_CAPACITY = 2_048;

export interface SettlementFailureLogGate {
  /** True when this key's failure is new or has changed since it last reported. */
  readonly shouldLog: (key: string, failureKey: string) => boolean;
  /** A key that answered again is allowed to report its next failure. */
  readonly forget: (key: string) => void;
}

export const makeSettlementFailureLogGate = (
  capacity: number = SETTLEMENT_FAILURE_LOG_CAPACITY,
): SettlementFailureLogGate => {
  const lastLoggedByKey = new Map<string, string>();
  return {
    shouldLog: (key, failureKey) => {
      if (lastLoggedByKey.get(key) === failureKey) return false;
      // Eviction is insertion-ordered and re-`set`ting a key does not refresh
      // its position, so this only bounds a key space it never churns through:
      // at a capacity near the live key count the hot key is evicted every
      // sweep and the dedupe silently stops deduping.
      if (!lastLoggedByKey.has(key) && lastLoggedByKey.size >= capacity) {
        const oldestKey = lastLoggedByKey.keys().next().value;
        if (oldestKey !== undefined) lastLoggedByKey.delete(oldestKey);
      }
      lastLoggedByKey.set(key, failureKey);
      return true;
    },
    forget: (key) => {
      lastLoggedByKey.delete(key);
    },
  };
};

/**
 * The identity of a failure, for both the dedupe key and the log annotations.
 *
 * Two things here were measured wrong before they were measured right, and both
 * are easy to reintroduce:
 *
 * - **The tag chain is walked, not read one hop deep.** A `gh` that hung and a
 *   `gh` that exited 1 both surface as `GitHubCliCommandError`; only the nested
 *   cause tells them apart. Keyed one hop deep, a hang that begins mid-outage is
 *   suppressed as a repeat of the exit it replaced.
 * - **`detail` is annotated but never keyed.** It carries raw command output,
 *   which can differ run to run for one standing condition and would defeat the
 *   dedupe entirely — the same reason `GitManager` keys on tags alone.
 */
export interface SettlementFailureIdentity {
  /** Stable across repeats of one condition; changes when the condition does. */
  readonly failureKey: string;
  readonly errorTag: string;
  readonly message: string;
  readonly detail: string | undefined;
}

const tagOf = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const tag = (error as { readonly _tag?: unknown })._tag;
  return typeof tag === "string" ? tag : undefined;
};

export const describeSettlementFailure = (error: unknown): SettlementFailureIdentity => {
  const tags: Array<string> = [];
  let current: unknown = error;
  // Bounded: a cause chain is short, but it is attacker-adjacent data and a
  // cycle here would hang the sweep worker rather than lose a log line.
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    const tag = tagOf(current) ?? (current instanceof Error ? current.name : undefined);
    if (tag !== undefined) tags.push(tag);
    const next: unknown = (current as { readonly cause?: unknown }).cause;
    if (next === current) break;
    current = next;
  }
  const message = error instanceof Error ? error.message : String(error);
  const detail = (error as { readonly detail?: unknown } | null)?.detail;
  return {
    // `message` joins the key so the two `Effect.die` sites, which share the
    // bare `Error` tag, do not collapse into one another and silence a defect.
    failureKey: `${tags.join("/")}\u0000${message}`,
    errorTag: tags[0] ?? "Unknown",
    message,
    detail: typeof detail === "string" ? detail : undefined,
  };
};
