import { describe, expect, it } from "@effect/vitest";
import type { ServerProvider, ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { cursorUsageFromProviders, readCursorUsage } from "./cursorUsageRead.ts";

const provider = (
  driver: string,
  usageLimits: ServerProviderUsageLimits | undefined,
  enabled = true,
): ServerProvider =>
  ({
    instanceId: driver,
    driver,
    enabled,
    installed: true,
    ...(usageLimits === undefined ? {} : { usageLimits }),
  }) as unknown as ServerProvider;

const cursorLimits = (
  windows: ServerProviderUsageLimits["windows"],
): ServerProviderUsageLimits => ({ checkedAt: "2026-08-30T00:00:00.000Z", windows });

const total = {
  id: "totalPercentUsed",
  kind: "monthly",
  label: "Overall",
  usedPercent: 42,
  resetsAt: "2026-09-01T00:00:00.000Z",
  windowDurationMins: 30 * 24 * 60,
} as const;

describe("cursorUsageFromProviders", () => {
  it("reads the overall window of the Cursor instance, with its cycle start", () => {
    expect(
      cursorUsageFromProviders([
        provider("claudeAgent", cursorLimits([{ ...total, usedPercent: 99 }])),
        provider(
          "cursor",
          cursorLimits([{ ...total, id: "autoPercentUsed", usedPercent: 7 }, total]),
        ),
      ]),
    ).toEqual({
      label: "Cursor",
      usedPercent: 42,
      resetsAt: "2026-09-01T00:00:00.000Z",
      fetchedAt: "2026-08-30T00:00:00.000Z",
      startsAt: "2026-08-02T00:00:00.000Z",
    });
  });

  it("is null with nothing to show, and never borrows another provider's window", () => {
    expect(cursorUsageFromProviders([])).toBeNull();
    expect(cursorUsageFromProviders([provider("cursor", undefined)])).toBeNull();
    expect(cursorUsageFromProviders([provider("cursor", cursorLimits([total]), false)])).toBeNull();
    expect(
      cursorUsageFromProviders([
        provider("cursor", cursorLimits([{ ...total, id: "autoPercentUsed" }])),
      ]),
    ).toBeNull();
    expect(cursorUsageFromProviders([provider("codex", cursorLimits([total]))])).toBeNull();
  });

  it("leaves the cycle start out when the window has no length", () => {
    const { windowDurationMins: _omit, ...withoutLength } = total;
    const snapshot = cursorUsageFromProviders([provider("cursor", cursorLimits([withoutLength]))]);
    expect(snapshot?.usedPercent).toBe(42);
    expect(snapshot).not.toHaveProperty("startsAt");
  });
});

describe("readCursorUsage", () => {
  it.effect("reads the provider registry's current snapshot", () =>
    readCursorUsage().pipe(
      Effect.map((snapshot) => expect(snapshot?.usedPercent).toBe(42)),
      Effect.provide(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([provider("cursor", cursorLimits([total]))]),
        }),
      ),
    ),
  );
});
