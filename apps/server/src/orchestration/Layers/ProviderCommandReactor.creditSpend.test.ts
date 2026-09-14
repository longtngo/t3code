import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ServerSettingsError, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  allowSpendingCreditsForReactorCreditGate,
  creditSpendRefusalForSend,
} from "./ProviderCommandReactor.ts";

const sessionInstance = ProviderInstanceId.make("claude-session");
const otherInstance = ProviderInstanceId.make("claude-other");

const provider = (instanceId: ProviderInstanceId, usedPercent: number): ServerProvider =>
  ({
    instanceId,
    driver: "claudeAgent",
    displayName: String(instanceId),
    enabled: true,
    installed: true,
    checkedAt: "2026-09-14T00:00:00.000Z",
    usageLimits: {
      checkedAt: "2026-09-14T00:00:00.000Z",
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent }],
    },
  }) as unknown as ServerProvider;

describe("creditSpendRefusalForSend", () => {
  it("allows the send while spending is allowed", () => {
    expect(
      creditSpendRefusalForSend({
        allowSpendingCredits: true,
        providers: [provider(sessionInstance, 100)],
        activeSessionInstanceId: sessionInstance,
      }),
    ).toBeNull();
  });

  it("refuses on the instance the session is actually bound to", () => {
    const reason = creditSpendRefusalForSend({
      allowSpendingCredits: false,
      providers: [provider(sessionInstance, 100), provider(otherInstance, 5)],
      activeSessionInstanceId: sessionInstance,
    });
    expect(reason).toContain("claude-session");
  });

  it("allows the send when a DIFFERENT instance is the exhausted one", () => {
    // The reactor gates on the bound session instance, never on the thread's default:
    // design P15/P16. Gating on the wrong value refuses turns that cost nothing.
    expect(
      creditSpendRefusalForSend({
        allowSpendingCredits: false,
        providers: [provider(sessionInstance, 5), provider(otherInstance, 100)],
        activeSessionInstanceId: sessionInstance,
      }),
    ).toBeNull();
  });

  it("allows the send only when no instance can be named at all", () => {
    // Defensive: the call site passes `activeSession?.providerInstanceId ?? thread's
    // default`, so `undefined` here means neither existed. Refusing on a name we do not
    // have would block turns we cannot show are spending anything.
    expect(
      creditSpendRefusalForSend({
        allowSpendingCredits: false,
        providers: [provider(sessionInstance, 100)],
        activeSessionInstanceId: undefined,
      }),
    ).toBeNull();
  });

  it("fails open when the settings gate is unavailable", () => {
    expect(
      creditSpendRefusalForSend({
        allowSpendingCredits: undefined,
        providers: [provider(sessionInstance, 100)],
        activeSessionInstanceId: sessionInstance,
      }),
    ).toBeNull();
  });
});

describe("allowSpendingCreditsForReactorCreditGate", () => {
  it.effect("returns undefined when settings read fails", () =>
    Effect.gen(function* () {
      const settingsError = new ServerSettingsError({
        settingsPath: "/test/settings.json",
        operation: "read-file",
        cause: new Error("settings unavailable"),
      });
      const result = yield* allowSpendingCreditsForReactorCreditGate(Effect.fail(settingsError));
      expect(result).toBeUndefined();
    }),
  );
});
