import { describe, expect, it } from "vite-plus/test";

import {
  AUTO_COMPACT_MIN_EFFECTIVE_DROP,
  type AutoCompactHoldReason,
  type AutoCompactInput,
  autoCompactStatusText,
  clampAutoCompactThreshold,
  DEFAULT_AUTO_COMPACT_MAX_CYCLES,
  DEFAULT_AUTO_COMPACT_THRESHOLD,
  decideAutoCompact,
  MAX_AUTO_COMPACT_THRESHOLD,
  MIN_AUTO_COMPACT_THRESHOLD,
  initialAutoCompactBudget,
  noteAutoCompactCycleComplete,
  noteAutoCompactSend,
  noteAutoCompactSendFailed,
  providerAdvertisesCompact,
  reconcileAutoCompactBudget,
  toggleAutoCompactThread,
} from "./autoCompact.ts";

/** An armed, idle, past-threshold thread: the one case that should act. */
const ready: AutoCompactInput = {
  armed: true,
  phase: "idle",
  usedPercentage: 60,
  thresholdPercent: DEFAULT_AUTO_COMPACT_THRESHOLD,
  threadBusy: false,
  sessionReady: true,
  archived: false,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  hasComposerDraft: false,
  providerSupportsCompact: true,
  cyclesUsed: 0,
  maxCycles: DEFAULT_AUTO_COMPACT_MAX_CYCLES,
  usedPercentageBeforeCompact: null,
};

const at = (over: Partial<AutoCompactInput>): AutoCompactInput => ({ ...ready, ...over });

describe("decideAutoCompact — starting a sequence", () => {
  it("compacts an armed, idle thread that has crossed the threshold", () => {
    expect(decideAutoCompact(ready)).toEqual({ kind: "compact" });
  });

  it.each([
    ["disarmed", { armed: false }],
    ["unsupported-provider", { providerSupportsCompact: false }],
    ["archived", { archived: true }],
    ["session-not-ready", { sessionReady: false }],
    ["needs-user", { hasPendingApprovals: true }],
    ["needs-user", { hasPendingUserInput: true }],
    ["needs-user", { hasActionableProposedPlan: true }],
    ["cap-reached", { cyclesUsed: DEFAULT_AUTO_COMPACT_MAX_CYCLES }],
    ["draft-pending", { hasComposerDraft: true }],
    ["thread-busy", { threadBusy: true }],
    ["unknown-usage", { usedPercentage: null }],
    ["below-threshold", { usedPercentage: 49.9 }],
  ] satisfies ReadonlyArray<readonly [AutoCompactHoldReason, Partial<AutoCompactInput>]>)(
    "holds with %s",
    (reason: AutoCompactHoldReason, over: Partial<AutoCompactInput>) => {
      expect(decideAutoCompact(at(over))).toEqual({ kind: "hold", reason });
    },
  );

  it("fires exactly at the threshold, not one step below it", () => {
    expect(decideAutoCompact(at({ usedPercentage: 50 }))).toEqual({ kind: "compact" });
    expect(decideAutoCompact(at({ usedPercentage: 49.99 }))).toEqual({
      kind: "hold",
      reason: "below-threshold",
    });
  });

  it("holds on the last allowed cycle boundary rather than exceeding the cap", () => {
    expect(decideAutoCompact(at({ cyclesUsed: 2, maxCycles: 3 }))).toEqual({ kind: "compact" });
    expect(decideAutoCompact(at({ cyclesUsed: 3, maxCycles: 3 }))).toEqual({
      kind: "hold",
      reason: "cap-reached",
    });
  });

  it("ranks a thread needing the user above a merely busy one", () => {
    // Both are true during an approval prompt; the reported reason must be the actionable one.
    expect(decideAutoCompact(at({ threadBusy: true, hasPendingApprovals: true }))).toEqual({
      kind: "hold",
      reason: "needs-user",
    });
  });
});

describe("decideAutoCompact — finishing a sequence", () => {
  const compacting = at({
    phase: "compacting",
    usedPercentageBeforeCompact: 60,
    usedPercentage: 20,
  });

  it("waits while the compaction turn is still running", () => {
    expect(decideAutoCompact({ ...compacting, threadBusy: true })).toEqual({
      kind: "hold",
      reason: "in-flight",
    });
  });

  it("continues once compaction settled and freed room", () => {
    expect(decideAutoCompact(compacting)).toEqual({ kind: "continue" });
  });

  it("abandons instead of continuing when compaction freed nothing", () => {
    // The guard that stops a no-op compaction becoming a loop.
    expect(
      decideAutoCompact({
        ...compacting,
        usedPercentage: 60 - (AUTO_COMPACT_MIN_EFFECTIVE_DROP - 1),
      }),
    ).toEqual({ kind: "abandon", reason: "compaction-ineffective" });
  });

  it("treats a drop of exactly the minimum as effective", () => {
    expect(
      decideAutoCompact({
        ...compacting,
        usedPercentage: 60 - AUTO_COMPACT_MIN_EFFECTIVE_DROP,
      }),
    ).toEqual({ kind: "continue" });
  });

  it("abandons rather than holding when the thread starts needing the user mid-sequence", () => {
    // Holding would park the phase at "compacting" forever, since nothing else clears it.
    expect(decideAutoCompact({ ...compacting, hasPendingApprovals: true })).toEqual({
      kind: "abandon",
      reason: "needs-user",
    });
  });

  it("abandons when usage cannot be read after compaction", () => {
    expect(decideAutoCompact({ ...compacting, usedPercentage: null })).toEqual({
      kind: "abandon",
      reason: "unknown-usage",
    });
  });

  it("does not re-issue continue while the continue turn is in flight", () => {
    expect(decideAutoCompact({ ...compacting, phase: "continuing" })).toEqual({
      kind: "hold",
      reason: "in-flight",
    });
  });

  it("ignores the composer draft mid-sequence", () => {
    // The draft guard exists to avoid interrupting the user before a turn starts; once the
    // thread is already compacting, refusing to continue would strand it.
    expect(decideAutoCompact({ ...compacting, hasComposerDraft: true })).toEqual({
      kind: "continue",
    });
  });
});

describe("toggleAutoCompactThread", () => {
  it("arms a thread that was not in the set", () => {
    expect(toggleAutoCompactThread({}, "env:thread")).toEqual({ "env:thread": true });
  });

  // A stored `false` would be indistinguishable from armed to a `!== undefined` reader and
  // would grow the record by one entry per thread ever armed, so disarming must delete.
  it("disarms by deleting the key rather than storing false", () => {
    const next = toggleAutoCompactThread({ "env:thread": true }, "env:thread");
    expect(next).toEqual({});
    expect("env:thread" in next).toBe(false);
  });

  it("leaves other threads untouched", () => {
    expect(toggleAutoCompactThread({ a: true, b: true }, "a")).toEqual({ b: true });
  });

  it("does not mutate the record it was given", () => {
    const before = { a: true };
    toggleAutoCompactThread(before, "b");
    expect(before).toEqual({ a: true });
  });
});

describe("autoCompactStatusText", () => {
  const base = {
    phase: "idle" as const,
    usedPercentage: 30,
    thresholdPercent: 50,
    threadBusy: false,
    cyclesUsed: 0,
    maxCycles: 3,
    lastHold: null,
  };

  it("names the threshold while approaching", () => {
    expect(autoCompactStatusText(base)).toBe("Will compact at 50%");
  });

  it("explains the wait when the thread is over the line but working", () => {
    expect(autoCompactStatusText({ ...base, usedPercentage: 70, threadBusy: true })).toBe(
      "At 50% — compacting when the thread goes idle",
    );
  });

  it("narrates each phase", () => {
    expect(autoCompactStatusText({ ...base, phase: "compacting" })).toBe("Compacting this thread…");
    expect(autoCompactStatusText({ ...base, phase: "continuing" })).toBe(
      "Compacted. Continuing where it left off.",
    );
  });

  it("says what to do when paused at the cap", () => {
    expect(autoCompactStatusText({ ...base, cyclesUsed: 3 })).toBe(
      "Paused after 3 rounds — send a message to resume",
    );
  });

  it("says what to do when compaction achieved nothing", () => {
    expect(autoCompactStatusText({ ...base, lastHold: "compaction-ineffective" })).toBe(
      "Compacting freed no room — paused until you send a message",
    );
  });
});

describe("clampAutoCompactThreshold", () => {
  it("keeps a value inside the band", () => {
    expect(clampAutoCompactThreshold(55)).toBe(55);
  });

  it("clamps both ends", () => {
    expect(clampAutoCompactThreshold(0)).toBe(MIN_AUTO_COMPACT_THRESHOLD);
    expect(clampAutoCompactThreshold(1000)).toBe(MAX_AUTO_COMPACT_THRESHOLD);
  });

  it("rounds fractional input", () => {
    expect(clampAutoCompactThreshold(50.6)).toBe(51);
  });

  it("falls back to the default for a non-finite value", () => {
    expect(clampAutoCompactThreshold(Number.NaN)).toBe(DEFAULT_AUTO_COMPACT_THRESHOLD);
  });
});

describe("providerAdvertisesCompact", () => {
  it("accepts a provider that advertises the command", () => {
    expect(providerAdvertisesCompact([{ name: "review" }, { name: "compact" }])).toBe(true);
  });

  it("rejects one that does not, and an absent list", () => {
    expect(providerAdvertisesCompact([{ name: "review" }])).toBe(false);
    expect(providerAdvertisesCompact([])).toBe(false);
    expect(providerAdvertisesCompact(undefined)).toBe(false);
  });

  it("matches the whole name rather than a prefix", () => {
    // "compact-history" is a different command; treating it as support would arm a thread
    // whose provider cannot answer `/compact`.
    expect(providerAdvertisesCompact([{ name: "compact-history" }])).toBe(false);
  });
});

describe("auto-compact cycle budget", () => {
  const opened = reconcileAutoCompactBudget(initialAutoCompactBudget, "2026-08-18T10:00:00Z");

  it("adopts the first observation without treating it as a new message", () => {
    expect(opened.cyclesUsed).toBe(0);
    expect(opened.lastSeenUserMessageAt).toBe("2026-08-18T10:00:00Z");
  });

  it("does NOT reset the budget on the message the feature itself sent", () => {
    // The whole point: `latestUserMessageAt` cannot distinguish our synthetic `role: "user"`
    // turn from a typed one, so a naive reset here would make the cap inert.
    const spent = noteAutoCompactCycleComplete({ ...opened, cyclesUsed: 2 });
    const afterSend = noteAutoCompactSend(spent);
    const afterOwnMessage = reconcileAutoCompactBudget(afterSend, "2026-08-18T10:05:00Z");
    expect(afterOwnMessage.cyclesUsed).toBe(3);
    expect(afterOwnMessage.awaitingSelfMessage).toBe(false);
  });

  it("resets the budget on a message the feature did not send", () => {
    const spent = { ...opened, cyclesUsed: 3 };
    expect(reconcileAutoCompactBudget(spent, "2026-08-18T10:05:00Z").cyclesUsed).toBe(0);
  });

  it("consumes exactly one advance per send", () => {
    // Two rounds: each send swallows its own message, and a third advance is the human.
    let budget = noteAutoCompactSend({ ...opened, cyclesUsed: 1 });
    budget = reconcileAutoCompactBudget(budget, "t1");
    expect(budget.cyclesUsed).toBe(1);
    budget = noteAutoCompactSend(budget);
    budget = reconcileAutoCompactBudget(budget, "t2");
    expect(budget.cyclesUsed).toBe(1);
    budget = reconcileAutoCompactBudget(budget, "t3");
    expect(budget.cyclesUsed).toBe(0);
  });

  it("disarms the pending self-message when the send failed", () => {
    // Otherwise the failed send's flag would swallow the user's next real message.
    const budget = noteAutoCompactSendFailed(noteAutoCompactSend({ ...opened, cyclesUsed: 2 }));
    expect(reconcileAutoCompactBudget(budget, "later").cyclesUsed).toBe(0);
  });

  it("ignores a repeated identical timestamp", () => {
    const budget = reconcileAutoCompactBudget({ ...opened, cyclesUsed: 2 }, "2026-08-18T10:00:00Z");
    expect(budget.cyclesUsed).toBe(2);
  });
});
