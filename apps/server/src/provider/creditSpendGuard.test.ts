import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { creditSpendBlockedReason } from "./creditSpendGuard.ts";

const instanceId = ProviderInstanceId.make("claude-1");
const NOW_MS = Date.parse("2026-09-14T01:00:00.000Z");

const provider = (usedPercent: number | null): ServerProvider =>
  ({
    instanceId,
    driver: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    checkedAt: "2026-09-14T00:00:00.000Z",
    ...(usedPercent === null
      ? {}
      : {
          usageLimits: {
            checkedAt: "2026-09-14T00:00:00.000Z",
            windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent }],
          },
        }),
  }) as unknown as ServerProvider;

describe("creditSpendBlockedReason", () => {
  it("never blocks while spending is allowed, whatever the windows read", () => {
    // I1. The switch on must never block. The implementation checks it first so the switch
    // works even when everything else is broken; this pins the outcome, not the ordering.
    expect(
      creditSpendBlockedReason({
        nowMs: NOW_MS,
        allowSpendingCredits: true,
        providers: [provider(100)],
        instanceId,
      }),
    ).toBeNull();
  });

  it("blocks an instance whose window is at the cap", () => {
    const reason = creditSpendBlockedReason({
      nowMs: NOW_MS,
      allowSpendingCredits: false,
      providers: [provider(100)],
      instanceId,
    });
    expect(reason).toContain("Claude");
    expect(reason).toContain("Allow to spend credits");
  });

  it("does not block below the cap, or with no limits reported", () => {
    // I2.
    for (const percent of [0, 99.999]) {
      expect(
        creditSpendBlockedReason({
          nowMs: NOW_MS,
          allowSpendingCredits: false,
          providers: [provider(percent)],
          instanceId,
        }),
      ).toBeNull();
    }
    expect(
      creditSpendBlockedReason({
        nowMs: NOW_MS,
        allowSpendingCredits: false,
        providers: [provider(null)],
        instanceId,
      }),
    ).toBeNull();
  });

  it("does not block on a snapshot that failed to load, even if it carries a full window", () => {
    // I2. An unavailable probe is not evidence of 100%: the windows beside it are whatever was
    // last seen, and treating them as live would disable the provider on a transient probe error.
    const stale = {
      ...provider(100),
      usageLimits: {
        checkedAt: "2026-09-14T00:00:00.000Z",
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 100 }],
        unavailable: { reason: "probeFailed" },
      },
    } as unknown as ServerProvider;
    expect(
      creditSpendBlockedReason({
        nowMs: NOW_MS,
        allowSpendingCredits: false,
        providers: [stale],
        instanceId,
      }),
    ).toBeNull();
  });

  it("blocks only the exhausted instance, not a sibling on the same driver", () => {
    // Limits are per instance: two Claude instances are two accounts.
    const other = ProviderInstanceId.make("claude-2");
    const siblings = [provider(100), { ...provider(10), instanceId: other } as ServerProvider];
    expect(
      creditSpendBlockedReason({
        nowMs: NOW_MS,
        allowSpendingCredits: false,
        providers: siblings,
        instanceId,
      }),
    ).not.toBeNull();
    expect(
      creditSpendBlockedReason({
        nowMs: NOW_MS,
        allowSpendingCredits: false,
        providers: siblings,
        instanceId: other,
      }),
    ).toBeNull();
  });

  it("does not block an instance it cannot find, or an absent instance id", () => {
    expect(
      creditSpendBlockedReason({
        nowMs: NOW_MS,
        allowSpendingCredits: false,
        providers: [],
        instanceId,
      }),
    ).toBeNull();
    expect(
      creditSpendBlockedReason({
        nowMs: NOW_MS,
        allowSpendingCredits: false,
        providers: [provider(100)],
        instanceId: undefined,
      }),
    ).toBeNull();
  });

  it("falls back to the driver name when the provider has no display name", () => {
    const unnamed = { ...provider(100), displayName: undefined } as ServerProvider;
    expect(
      creditSpendBlockedReason({
        nowMs: NOW_MS,
        allowSpendingCredits: false,
        providers: [unnamed],
        instanceId,
      }),
    ).toContain("claudeAgent");
  });
});
