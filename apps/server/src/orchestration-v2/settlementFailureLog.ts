/**
 * Whether a settlement-sweep lookup failure is worth logging. The sweep re-asks every 60 s,
 * which was 95% of all server logging. Only a change (a different failure, or a recovery) is
 * news; same rule and shape as `GitManager`'s `shouldLogPrLookupFailure`.
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
 * A failure's identity, for the dedupe key and log annotations. Walk the whole tag chain: a
 * hung `gh` and an exit-1 `gh` share the outer tag. Never key on `detail`: it carries raw
 * output that varies run to run for one standing condition.
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
