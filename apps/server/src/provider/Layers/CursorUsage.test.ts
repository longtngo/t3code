// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as TestClock from "effect/testing/TestClock";

import {
  cursorStateDbPath,
  hasUsageSignal,
  isAccessTokenExpired,
  jwtExpiresAtMs,
  mergeUsageSnapshots,
  normalizeAuthUsage,
  normalizeCurrentPeriodUsage,
  resolveCursorAuthTokens,
  unixMsToIso,
  type RawAuthUsageResponse,
  type RawCurrentPeriodUsageResponse,
  makeAccountUsagePoll,
} from "./CursorUsage.ts";

describe("CursorUsage.normalizeCurrentPeriodUsage", () => {
  // Shape verified against live GetCurrentPeriodUsage (2026-06-13).
  const liveSample: RawCurrentPeriodUsageResponse = {
    billingCycleStart: "1780445696000",
    billingCycleEnd: "1783037696000",
    planUsage: {
      totalSpend: 474,
      includedSpend: 474,
      remaining: 1526,
      limit: 2000,
      autoPercentUsed: 0,
      apiPercentUsed: 5.925,
      totalPercentUsed: 5.925,
    },
    spendLimitUsage: {
      totalSpend: 391993,
      pooledLimit: 800000,
      pooledUsed: 391993,
      pooledRemaining: 408007,
      limitType: "team",
    },
  };

  it("maps the live sample to the normalized contract shape", () => {
    const result = normalizeCurrentPeriodUsage(liveSample);
    assert.deepStrictEqual(result.fiveHour, null);
    assert.deepStrictEqual(result.sevenDay, null);
    assert.deepStrictEqual(result.extra, null);
    assert.deepStrictEqual(result.cursor?.auto, {
      utilization: 0,
      resetsAt: unixMsToIso("1783037696000"),
    });
    assert.deepStrictEqual(result.cursor?.api, {
      utilization: 5.925,
      resetsAt: unixMsToIso("1783037696000"),
    });
    assert.deepStrictEqual(result.cursor?.total, {
      utilization: 5.925,
      resetsAt: unixMsToIso("1783037696000"),
    });
    assert.deepStrictEqual(result.cursor?.onDemand, {
      isEnabled: true,
      usedCredits: 391993,
      monthlyLimit: 800000,
      utilization: 48.999125,
      currency: "USD",
    });
    assert.equal(result.cursor?.onDemandScope, "team");
  });

  it("keeps auto and api as separate cursor windows", () => {
    const result = normalizeCurrentPeriodUsage({
      billingCycleEnd: "1783037696000",
      planUsage: {
        autoPercentUsed: 12,
        apiPercentUsed: 40,
        totalPercentUsed: 52,
      },
    });
    assert.equal(result.cursor?.auto?.utilization, 12);
    assert.equal(result.cursor?.api?.utilization, 40);
    assert.equal(result.cursor?.total?.utilization, 52);
  });

  it("computes billing-cycle utilization from cents when totalPercentUsed is missing", () => {
    const result = normalizeCurrentPeriodUsage({
      billingCycleEnd: "1783037696000",
      planUsage: {
        includedSpend: 500,
        limit: 2000,
      },
    });
    assert.deepStrictEqual(result.cursor?.total, {
      utilization: 25,
      resetsAt: unixMsToIso("1783037696000"),
    });
  });
});

describe("CursorUsage.normalizeAuthUsage", () => {
  const enterpriseSample: RawAuthUsageResponse = {
    "gpt-4": {
      numRequests: 150,
      maxRequestUsage: 500,
    },
  };

  it("maps enterprise request buckets to cursor.requests", () => {
    const result = normalizeAuthUsage(enterpriseSample);
    assert.deepStrictEqual(result, {
      fiveHour: null,
      sevenDay: null,
      extra: null,
      cursor: {
        auto: null,
        api: null,
        total: null,
        onDemand: null,
        requests: {
          used: 150,
          limit: 500,
          utilization: 30,
        },
      },
    });
  });
});

describe("CursorUsage.mergeUsageSnapshots", () => {
  it("fills missing primary cursor fields from fallback", () => {
    const merged = mergeUsageSnapshots(
      {
        fiveHour: null,
        sevenDay: null,
        extra: null,
        cursor: {
          auto: null,
          api: null,
          total: null,
          onDemand: null,
        },
      },
      {
        fiveHour: null,
        sevenDay: null,
        extra: null,
        cursor: {
          auto: null,
          api: null,
          total: { utilization: 30, resetsAt: null },
          onDemand: null,
        },
      },
    );
    assert.equal(merged.cursor?.total?.utilization, 30);
    assert.equal(hasUsageSignal(merged), true);
  });
});

describe("CursorUsage.jwtExpiresAtMs", () => {
  it("reads exp from a JWT payload without verifying the signature", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 })).toString("base64url");
    const token = `${header}.${payload}.sig`;
    assert.equal(jwtExpiresAtMs(token), 1_700_000_000_000);
    assert.equal(isAccessTokenExpired(token, 1_700_000_000_000), true);
    assert.equal(isAccessTokenExpired(token, 1_699_999_000_000), false);
  });
});

describe("CursorUsage.resolveCursorAuthTokens", () => {
  const keychainSpawner = (tokens: Record<string, string>, serviceCalls: string[]) =>
    Option.some(
      ChildProcessSpawner.make((command) => {
        const { args } = command as unknown as { args: ReadonlyArray<string> };
        const service = args[args.indexOf("-s") + 1] ?? "";
        serviceCalls.push(service);
        const token = tokens[service];
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(token === undefined ? 44 : 0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(token ?? "")),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      }),
    );

  it.effect("prefers CURSOR_ACCESS_TOKEN from the provided env", () =>
    Effect.gen(function* () {
      const tokens = yield* resolveCursorAuthTokens({
        env: { CURSOR_ACCESS_TOKEN: "env-access", CURSOR_REFRESH_TOKEN: "env-refresh" },
        spawner: Option.none(),
        fileSystem: Option.none(),
      });
      assert.deepStrictEqual(
        tokens,
        Option.some({ accessToken: "env-access", refreshToken: Option.some("env-refresh") }),
      );
    }),
  );

  // TODO(phase-1 sanitize): inject HostProcessPlatform instead of reading process.platform directly.
  // oxlint-disable-next-line t3code/no-global-process-runtime
  it.effect.runIf(process.platform === "darwin")(
    "falls back to CLI keychain tokens when env vars are absent",
    () =>
      Effect.gen(function* () {
        const serviceCalls: string[] = [];
        const tokens = yield* resolveCursorAuthTokens({
          env: {},
          spawner: keychainSpawner(
            {
              "cursor-access-token": "cli-access",
              "cursor-refresh-token": "cli-refresh",
            },
            serviceCalls,
          ),
          fileSystem: Option.none(),
        });
        assert.deepStrictEqual(serviceCalls, ["cursor-access-token", "cursor-refresh-token"]);
        assert.deepStrictEqual(
          tokens,
          Option.some({ accessToken: "cli-access", refreshToken: Option.some("cli-refresh") }),
        );
      }),
  );
});

describe("CursorUsage.cursorStateDbPath", () => {
  it("uses the Cursor Desktop SQLite path on macOS", () => {
    assert.equal(
      cursorStateDbPath({ HOME: "/Users/test" }),
      "/Users/test/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    );
  });

  it("uses the XDG config path on Linux", () => {
    // TODO(phase-1 sanitize): inject HostProcessPlatform instead of reading process.platform directly.
    // oxlint-disable-next-line t3code/no-global-process-runtime
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      assert.equal(
        cursorStateDbPath({ HOME: "/home/test" }),
        "/home/test/.config/Cursor/User/globalStorage/state.vscdb",
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("falls back to homedir() when HOME is empty", () => {
    assert.match(
      cursorStateDbPath({ HOME: "" }),
      new RegExp(`${NodeOS.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  });
});

describe("CursorUsage.makeAccountUsagePoll", () => {
  const dashboardResponse: RawCurrentPeriodUsageResponse = {
    billingCycleStart: "1780445696000",
    billingCycleEnd: "1783037696000",
    planUsage: { autoPercentUsed: 7, apiPercentUsed: 100, totalPercentUsed: 22 },
    spendLimitUsage: { pooledLimit: 1000000, pooledUsed: 395760, limitType: "team" },
  };

  it.effect("stamps fetchedAt so the UI can say how old the numbers are", () =>
    Effect.gen(function* () {
      // Without this the vitals popover's refresh control has no label - its
      // text IS the snapshot age - so it renders as a bare icon that never
      // changes and a press looks like it did nothing. Measured on real data:
      // 0 of 4 Cursor payloads carried the field, against 15 Claude ones.
      // `it.effect` runs on a TestClock that starts at the epoch, so the stamp
      // is exact rather than a window: advance to a known instant and the
      // payload must carry that instant, which is what proves the value is the
      // FETCH time and not something re-derived at emission.
      yield* TestClock.adjust(Duration.millis(1_760_000_000_000));
      const payload = yield* makeAccountUsagePoll({
        env: { CURSOR_ACCESS_TOKEN: "test-access" },
        httpClient: Option.some(
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify(dashboardResponse), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              ),
            ),
          ),
        ),
        spawner: Option.none(),
        fileSystem: Option.none(),
      });

      assert.isNotNull(payload);
      assert.equal(payload?.fetchedAt, "2025-10-09T08:53:20.000Z");
    }),
  );
});
