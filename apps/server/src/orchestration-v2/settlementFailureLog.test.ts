import { describe, expect, it } from "@effect/vitest";

import { describeSettlementFailure, makeSettlementFailureLogGate } from "./settlementFailureLog.ts";

describe("makeSettlementFailureLogGate", () => {
  it("reports a failure once and stays silent while it is unchanged", () => {
    const gate = makeSettlementFailureLogGate();
    expect(gate.shouldLog("repo-a", "boom")).toBe(true);
    // The sweep re-enters this path every 60s; the whole point is the silence.
    for (let sweep = 0; sweep < 20; sweep += 1) {
      expect(gate.shouldLog("repo-a", "boom")).toBe(false);
    }
  });

  it("reports again when the failure changes", () => {
    const gate = makeSettlementFailureLogGate();
    gate.shouldLog("repo-a", "boom");
    expect(gate.shouldLog("repo-a", "different")).toBe(true);
    expect(gate.shouldLog("repo-a", "different")).toBe(false);
  });

  it("re-arms after a recovery, so a recurrence is not swallowed as a repeat", () => {
    const gate = makeSettlementFailureLogGate();
    gate.shouldLog("repo-a", "boom");
    expect(gate.shouldLog("repo-a", "boom")).toBe(false);
    gate.forget("repo-a");
    expect(gate.shouldLog("repo-a", "boom")).toBe(true);
  });

  it("keeps keys independent", () => {
    const gate = makeSettlementFailureLogGate();
    expect(gate.shouldLog("repo-a", "boom")).toBe(true);
    expect(gate.shouldLog("repo-b", "boom")).toBe(true);
    expect(gate.shouldLog("repo-a", "boom")).toBe(false);
  });

  // At a capacity near the live key count, insertion-ordered eviction drops the
  // hot key every sweep and the dedupe silently stops deduping. This pins the
  // failure mode so the real capacity is never quietly lowered into it.
  it("stops deduping the hot key once capacity is exhausted", () => {
    const gate = makeSettlementFailureLogGate(2);
    expect(gate.shouldLog("hot", "boom")).toBe(true);
    expect(gate.shouldLog("hot", "boom")).toBe(false);
    gate.shouldLog("cold-1", "boom");
    gate.shouldLog("cold-2", "boom");
    expect(gate.shouldLog("hot", "boom")).toBe(true);
  });
});

describe("describeSettlementFailure", () => {
  const nested = (tag: string, causeTag: string, detail?: string) =>
    Object.assign(new Error(`${tag} failed`), {
      _tag: tag,
      ...(detail === undefined ? {} : { detail }),
      cause: Object.assign(new Error(`${causeTag} failed`), { _tag: causeTag }),
    });

  it("separates a hang from an exit that share their outer tag", () => {
    const exited = nested("SourceControlProviderError", "GitHubCliCommandError");
    exited.cause.cause = Object.assign(new Error("exit 1"), { _tag: "VcsProcessExitError" });
    const hung = nested("SourceControlProviderError", "GitHubCliCommandError");
    hung.cause.cause = Object.assign(new Error("timed out"), { _tag: "VcsProcessTimeoutError" });

    expect(describeSettlementFailure(exited).failureKey).not.toBe(
      describeSettlementFailure(hung).failureKey,
    );
  });

  it("keeps detail out of the key so varying command output cannot defeat it", () => {
    const first = nested("SourceControlProviderError", "GitHubCliCommandError", "output at 12:01");
    const second = nested("SourceControlProviderError", "GitHubCliCommandError", "output at 12:02");
    expect(describeSettlementFailure(first).failureKey).toBe(
      describeSettlementFailure(second).failureKey,
    );
    expect(describeSettlementFailure(first).detail).toBe("output at 12:01");
  });

  // Both Effect.die sites in the reactor throw a bare Error, so a tag-only key
  // would collapse them and silence the second defect permanently.
  it("distinguishes two bare errors by message", () => {
    const left = describeSettlementFailure(new Error("linked pull request project not found"));
    const right = describeSettlementFailure(new Error("thread project not found"));
    expect(left.failureKey).not.toBe(right.failureKey);
  });

  it("survives a cyclic cause instead of hanging the sweep", () => {
    const looped = Object.assign(new Error("loop"), { _tag: "A" }) as Error & { cause?: unknown };
    looped.cause = looped;
    expect(describeSettlementFailure(looped).errorTag).toBe("A");
  });
});
