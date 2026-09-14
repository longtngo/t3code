# Credit spend guard implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-scoped "Allow to spend credits" switch (default on) that, when off, stops a
provider instance from doing further work once one of its usage windows reads 100%.

**Architecture:** A pure predicate over `settings + providers` is called **live** at two turn-start
gates (WebSocket command boundary for a synchronous refusal that pauses the sidebar Queue; provider
reactor for server-originated starts). A background fiber does only the side effects a gate cannot:
interrupting running turns and rewriting Cursor subagent flag files. Nothing the fiber maintains is
ever consulted to decide whether spending is allowed.

**Tech Stack:** TypeScript, Effect (effect-smol, `4.0.0-rc.x`), Effect/Schema contracts,
`@effect/vitest` for server tests, `vite-plus/test` for shared/contracts tests, React for the web
Settings UI.

**Spec:** `docs/design/2026-09-14-credit-spend-guard-design.md` — read it before Task 1. Task
numbering below cites its invariants (I1–I13) and premises (P1–P17).

## Global Constraints

- **Node 24.13.1.** `package.json` pins `"node": "^24.13.1"`. Run every command with
  `export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"` first. On the ambient Node 26,
  `packages/shared/src/composerContextLegacy.test.ts` fails one assertion in a file byte-identical to
  `origin/main` (design P10) and that red cancels the packages queued behind it.
- **Setting key:** `allowSpendingCredits`. **User-facing label, exactly:** `Allow to spend credits`.
  **Default:** `true` (spending allowed).
- **Capability key:** `allowSpendingCredits` on `ExecutionEnvironmentCapabilities`.
- **Threshold:** a window is exhausted at `usedPercent >= 100`. `usedPercent` is clamped to `[0,100]`
  (`apps/server/src/provider/providerUsageLimits.ts:14-16`).
- **Block granularity:** provider **instance** (`ProviderInstanceId`), never driver kind.
- **Fail direction:** block only on an affirmative `>= 100` reading. Absent limits, `unavailable`
  (either reason), an empty `windows` array, and any failed read all mean _allow_ (design §9).
- **Never** let a gate read cached state. Gates call `serverSettings.getSettings` and
  `providerRegistry.getProviders` every time (design §4, I9).
- Run only the tests each task names. Do **not** run `pnpm verify` or a repo-wide suite; the final
  gate is run once at Stage 9.
- Commit after every task with the message given in its last step.

---

### Task 1: Setting and capability contracts

**Files:**

- Modify: `packages/contracts/src/settings.ts` (add to `ServerSettings` beside
  `subagentBackendEnabled` at `:1658`; add to `ServerSettingsPatch` beside `:1944`)
- Modify: `packages/contracts/src/environment.ts` (add to `ExecutionEnvironmentCapabilities` beside
  `crew` at `:161-165`)
- Modify: `apps/server/src/environment/ServerEnvironment.ts:240` (advertise it)
- Test: `packages/contracts/src/settings.test.ts`
- Test: `apps/server/src/environment/ServerEnvironment.test.ts:179`

**Interfaces:**

- Produces: `ServerSettings.allowSpendingCredits: boolean`,
  `ServerSettingsPatch.allowSpendingCredits?: boolean`,
  `ExecutionEnvironmentCapabilities.allowSpendingCredits?: boolean`.

- [ ] **Step 1: Write the failing contract tests**

Append to `packages/contracts/src/settings.test.ts`:

```ts
describe("allow spending credits setting", () => {
  it("defaults to allowing spend", () => {
    expect(DEFAULT_SERVER_SETTINGS.allowSpendingCredits).toBe(true);
  });

  it("decodes a settings file written before the field existed", () => {
    const decoded = Schema.decodeUnknownSync(ServerSettings)({});
    expect(decoded.allowSpendingCredits).toBe(true);
  });

  it("degrades an undecodable value to the default instead of failing the document", () => {
    // Same containment as `subagentBackendEnabled` above: a failed `ServerSettings`
    // decode makes `loadSettingsFromDisk` keep DEFAULT_SERVER_SETTINGS and write them
    // back, losing every unrelated setting.
    const decoded = Schema.decodeUnknownSync(ServerSettings)({
      allowSpendingCredits: "false",
      enableProviderUpdateChecks: false,
    });
    expect(decoded.allowSpendingCredits).toBe(true);
    expect(decoded.enableProviderUpdateChecks).toBe(false);
  });

  it("still rejects a non-boolean at the RPC boundary", () => {
    expect(() =>
      Schema.decodeUnknownSync(ServerSettingsPatch)({ allowSpendingCredits: "false" }),
    ).toThrow();
  });

  it("accepts a boolean patch", () => {
    const patch = Schema.decodeUnknownSync(ServerSettingsPatch)({ allowSpendingCredits: false });
    expect(patch.allowSpendingCredits).toBe(false);
  });
});
```

Add to `apps/server/src/environment/ServerEnvironment.test.ts`, beside the
`subagentBackendThreadModes` assertion at `:180`:

```ts
// I11: this assertion is load-bearing. The surrounding test asserts a SUBSET of
// capabilities, so adding the schema field without advertising it here would
// otherwise pass, and the Settings row would be hidden on every client.
expect(second.capabilities.allowSpendingCredits).toBe(true);
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd packages/contracts && pnpm exec vp test run src/settings.test.ts
cd ../../apps/server && pnpm exec vp test run src/environment/ServerEnvironment.test.ts
```

Expected: contracts FAIL (`expected undefined to be true`); server FAIL on the new assertion.

- [ ] **Step 3: Add the setting to `ServerSettings`**

In `packages/contracts/src/settings.ts`, immediately after the `subagentBackendThreadModes` block
(ends `:1670`):

```ts
  // When false, a provider instance whose published usage windows report 100% is blocked:
  // running turns on it are interrupted and new ones are refused. Default true, so an
  // environment that never touches this setting behaves exactly as before.
  allowSpendingCredits: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
    // Same containment as `subagentBackendEnabled` above. An undecodable value reads as
    // `true`, the default — the direction that keeps working rather than the one that
    // silently stops every provider.
    Schema.catchDecoding(() => Effect.succeed(Option.some(true))),
  ),
```

In `ServerSettingsPatch`, after `subagentBackendThreadModes` (`:1947`):

```ts
  allowSpendingCredits: Schema.optionalKey(Schema.Boolean),
```

- [ ] **Step 4: Add the capability**

In `packages/contracts/src/environment.ts`, after the `crew` entry (`:165`):

```ts
  /** Server honours `allowSpendingCredits` and refuses turns on a provider at 100%. Absent on
      servers from before it shipped, so clients hide the master switch rather than write a
      setting nothing reads — an ungated row accepts the flip, has the unknown key stripped
      from the patch, and silently snaps back with no error. */
  allowSpendingCredits: Schema.optionalKey(Schema.Boolean),
```

In `apps/server/src/environment/ServerEnvironment.ts`, after `crew: true,` (`:241`):

```ts
      allowSpendingCredits: true,
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd packages/contracts && pnpm exec vp test run src/settings.test.ts
cd ../../apps/server && pnpm exec vp test run src/environment/ServerEnvironment.test.ts
```

Expected: PASS. The parity test `mirrors every ServerSettings field in ServerSettingsPatch`
(`settings.test.ts:1092`) must also pass — it fails if Step 3's patch mirror was missed.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts \
  packages/contracts/src/environment.ts \
  apps/server/src/environment/ServerEnvironment.ts \
  apps/server/src/environment/ServerEnvironment.test.ts
git commit -m "feat(contracts): add allowSpendingCredits setting and capability"
```

---

### Task 2: `exhaustedUsageWindows` predicate

**Files:**

- Modify: `packages/shared/src/usageLimits.ts` (beside `limitsNotice` at `:395`)
- Test: `packages/shared/src/usageLimits.test.ts`

**Interfaces:**

- Consumes: `ServerProviderUsageLimits`, `ServerProviderUsageWindow` from `@t3tools/contracts`.
- Produces:
  `export function exhaustedUsageWindows(limits: ServerProviderUsageLimits | undefined): readonly ServerProviderUsageWindow[]`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/src/usageLimits.test.ts`:

```ts
describe("exhaustedUsageWindows", () => {
  const win = (id: string, usedPercent: number): ServerProviderUsageWindow => ({
    id,
    kind: "session",
    label: id,
    usedPercent,
  });

  it("reports nothing when there are no limits at all", () => {
    expect(exhaustedUsageWindows(undefined)).toEqual([]);
  });

  it("reports nothing for an unavailable snapshot, whichever reason", () => {
    // I2: "we could not read it" is not "it is at 100%". Four of six drivers never
    // report limits (design P1), so blocking on absence disables most of the product.
    for (const reason of ["unsupported", "probeFailed"] as const) {
      expect(
        exhaustedUsageWindows({
          checkedAt: "2026-09-14T00:00:00.000Z",
          windows: [win("five_hour", 100)],
          unavailable: { reason },
        }),
      ).toEqual([]);
    }
  });

  it("reports nothing for an empty window list", () => {
    expect(exhaustedUsageWindows({ checkedAt: "2026-09-14T00:00:00.000Z", windows: [] })).toEqual(
      [],
    );
  });

  it("does not report a window just below the cap", () => {
    expect(
      exhaustedUsageWindows({
        checkedAt: "2026-09-14T00:00:00.000Z",
        windows: [win("five_hour", 99.999)],
      }),
    ).toEqual([]);
  });

  it("reports exactly the windows at or above the cap", () => {
    const windows = [win("five_hour", 42), win("seven_day", 100), win("seven_day_fable", 100)];
    expect(
      exhaustedUsageWindows({ checkedAt: "2026-09-14T00:00:00.000Z", windows }).map((w) => w.id),
    ).toEqual(["seven_day", "seven_day_fable"]);
  });
});
```

Add `exhaustedUsageWindows` to the import list at the top of the file, and
`type ServerProviderUsageWindow` to the `@t3tools/contracts` import.

- [ ] **Step 2: Run the test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd packages/shared && pnpm exec vp test run src/usageLimits.test.ts
```

Expected: FAIL — `exhaustedUsageWindows is not a function`.

- [ ] **Step 3: Write the implementation**

In `packages/shared/src/usageLimits.ts`, directly above `limitsNotice` (`:395`):

```ts
/**
 * The windows this snapshot reports at or over their cap.
 *
 * Empty for a provider that reports no limits and for an `unavailable` snapshot: absence of
 * a reading is not a reading of 100%, and most drivers never report limits at all.
 */
export function exhaustedUsageWindows(
  limits: ServerProviderUsageLimits | undefined,
): readonly ServerProviderUsageWindow[] {
  if (!limits || limits.unavailable) return [];
  return limits.windows.filter((window) => window.usedPercent >= 100);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd packages/shared && pnpm exec vp test run src/usageLimits.test.ts
```

Expected: PASS, with the pre-existing tests in that file still green.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/usageLimits.ts packages/shared/src/usageLimits.test.ts
git commit -m "feat(shared): add exhaustedUsageWindows predicate"
```

---

### Task 3: Pure credit-spend guard

**Files:**

- Create: `apps/server/src/provider/creditSpendGuard.ts`
- Test: `apps/server/src/provider/creditSpendGuard.test.ts`

**Interfaces:**

- Consumes: `exhaustedUsageWindows` (Task 2), `ServerSettings` (Task 1), `ServerProvider`,
  `ProviderInstanceId`.
- Produces:
  - `export function creditSpendBlockedReason(input: { readonly allowSpendingCredits: boolean; readonly providers: readonly ServerProvider[]; readonly instanceId: ProviderInstanceId | undefined }): string | null`
  - `export function cursorOffloadBlockedReason(input: { readonly allowSpendingCredits: boolean; readonly cursorUsedPercent: number | null }): string | null`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/provider/creditSpendGuard.test.ts`:

```ts
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { creditSpendBlockedReason, cursorOffloadBlockedReason } from "./creditSpendGuard.ts";

const instanceId = ProviderInstanceId.make("claude-1");

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
    // I1. This is checked FIRST so the switch works even when everything else is broken.
    expect(
      creditSpendBlockedReason({
        allowSpendingCredits: true,
        providers: [provider(100)],
        instanceId,
      }),
    ).toBeNull();
  });

  it("blocks an instance whose window is at the cap", () => {
    const reason = creditSpendBlockedReason({
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
          allowSpendingCredits: false,
          providers: [provider(percent)],
          instanceId,
        }),
      ).toBeNull();
    }
    expect(
      creditSpendBlockedReason({
        allowSpendingCredits: false,
        providers: [provider(null)],
        instanceId,
      }),
    ).toBeNull();
  });

  it("blocks only the exhausted instance, not a sibling on the same driver", () => {
    // Limits are per instance: two Claude instances are two accounts.
    const other = ProviderInstanceId.make("claude-2");
    const siblings = [provider(100), { ...provider(10), instanceId: other } as ServerProvider];
    expect(
      creditSpendBlockedReason({ allowSpendingCredits: false, providers: siblings, instanceId }),
    ).not.toBeNull();
    expect(
      creditSpendBlockedReason({
        allowSpendingCredits: false,
        providers: siblings,
        instanceId: other,
      }),
    ).toBeNull();
  });

  it("does not block an instance it cannot find, or an absent instance id", () => {
    expect(
      creditSpendBlockedReason({ allowSpendingCredits: false, providers: [], instanceId }),
    ).toBeNull();
    expect(
      creditSpendBlockedReason({
        allowSpendingCredits: false,
        providers: [provider(100)],
        instanceId: undefined,
      }),
    ).toBeNull();
  });

  it("falls back to the driver name when the provider has no display name", () => {
    const unnamed = { ...provider(100), displayName: undefined } as ServerProvider;
    expect(
      creditSpendBlockedReason({ allowSpendingCredits: false, providers: [unnamed], instanceId }),
    ).toContain("claudeAgent");
  });
});

describe("cursorOffloadBlockedReason", () => {
  it("never blocks while spending is allowed", () => {
    expect(
      cursorOffloadBlockedReason({ allowSpendingCredits: true, cursorUsedPercent: 100 }),
    ).toBeNull();
  });

  it("blocks at the cap and allows below it", () => {
    expect(
      cursorOffloadBlockedReason({ allowSpendingCredits: false, cursorUsedPercent: 100 }),
    ).not.toBeNull();
    expect(
      cursorOffloadBlockedReason({ allowSpendingCredits: false, cursorUsedPercent: 99 }),
    ).toBeNull();
  });

  it("does not block when the usage could not be read", () => {
    // A failed Cursor read is null, never an error (design P9). Absence is not 100%.
    expect(
      cursorOffloadBlockedReason({ allowSpendingCredits: false, cursorUsedPercent: null }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd apps/server && pnpm exec vp test run src/provider/creditSpendGuard.test.ts
```

Expected: FAIL — cannot resolve `./creditSpendGuard.ts`.

- [ ] **Step 3: Write the implementation**

Create `apps/server/src/provider/creditSpendGuard.ts`:

```ts
/**
 * creditSpendGuard — whether a provider instance may spend right now.
 *
 * Pure by design, and called live at every gate rather than cached. A cached answer has
 * three ways to go stale in the fail-OPEN direction (a failed settings read, an empty map
 * during an outage, a dead maintainer fiber), and this guard exists precisely to stop
 * money being spent, so the unsafe direction is the one that must be impossible.
 *
 * @module provider/creditSpendGuard
 */
import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { exhaustedUsageWindows } from "@t3tools/shared/usageLimits";

const SWITCH_LABEL = `"Allow to spend credits"`;

/**
 * Why this instance may not spend, or `null` when it may.
 *
 * Only an affirmative reading of 100% blocks. An instance that reports no limits, one this
 * build cannot find, and an absent instance id all read as allowed: four of six drivers
 * never report usage at all, so treating "cannot tell" as "exhausted" would disable them
 * permanently.
 */
export function creditSpendBlockedReason(input: {
  readonly allowSpendingCredits: boolean;
  readonly providers: readonly ServerProvider[];
  readonly instanceId: ProviderInstanceId | undefined;
}): string | null {
  // First, so that turning the switch back on takes effect immediately and unconditionally.
  if (input.allowSpendingCredits) return null;
  if (input.instanceId === undefined) return null;
  const provider = input.providers.find((entry) => entry.instanceId === input.instanceId);
  if (!provider) return null;
  const windows = exhaustedUsageWindows(provider.usageLimits);
  if (windows.length === 0) return null;
  const name = provider.displayName ?? provider.driver;
  const labels = windows.map((window) => window.label).join(", ");
  return `${name} has used 100% of ${labels} and ${SWITCH_LABEL} is off. Turn it on in Settings, or wait for the limit to reset.`;
}

/** Why Cursor subagent offload is withheld, or `null` when it is allowed. */
export function cursorOffloadBlockedReason(input: {
  readonly allowSpendingCredits: boolean;
  readonly cursorUsedPercent: number | null;
}): string | null {
  if (input.allowSpendingCredits) return null;
  if (input.cursorUsedPercent === null || input.cursorUsedPercent < 100) return null;
  return `Cursor has used 100% of its usage and ${SWITCH_LABEL} is off.`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd apps/server && pnpm exec vp test run src/provider/creditSpendGuard.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Confirm the import specifier resolves**

`@t3tools/shared` has no barrel; subpath exports are the house rule. Verify the specifier used
above matches how other server files import from that module:

```bash
grep -rn "@t3tools/shared/usageLimits" apps/server/src packages/ | head -3
```

If the grep returns nothing, find the correct subpath in `packages/shared/package.json`'s `exports`
block and use that instead. Do not add a barrel.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/provider/creditSpendGuard.ts apps/server/src/provider/creditSpendGuard.test.ts
git commit -m "feat(server): add pure credit-spend guard predicate"
```

---

### Task 4: Guard fiber — interrupts and Cursor flag-file reconcile

**Files:**

- Create: `apps/server/src/provider/Layers/CreditSpendGuardLive.ts`
- Modify: `apps/server/src/server.ts:547` (mount beside `ProviderUsageLimitsIngestionLive`)
- Test: `apps/server/src/provider/Layers/CreditSpendGuardLive.test.ts`

**Interfaces:**

- Consumes: `creditSpendBlockedReason`, `cursorOffloadBlockedReason` (Task 3);
  `ProviderRegistry.streamChanges` / `.getProviders`; `ServerSettingsService.streamChanges` /
  `.getSettings`; `ProjectionSnapshotQuery.getShellSnapshot`; `OrchestrationEngineService.dispatch`;
  `reconcileAllBackends` from `../../subagentBackend/SubagentBackend.ts`; `readCursorUsage` from
  `../../subagentBackend/cursorUsageRead.ts`.
- Produces: `export const CreditSpendGuardLive: Layer.Layer<never, never, ...>`, and
  `export const runCreditSpendGuardTick` — the tick body, exported so tests drive it directly
  instead of racing a forked fiber.

**Design invariants covered:** I4, I5, I7, I8, I12, I13.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/provider/Layers/CreditSpendGuardLive.test.ts`. Drive
`runCreditSpendGuardTick` directly with stub dependencies — the forked fiber is wiring, the tick is
the behaviour. Carry the tick's mutable memo across calls in a `Ref`, exactly as the layer does.

```ts
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { ProviderInstanceId, type ServerProvider, ThreadId } from "@t3tools/contracts";

import {
  type CreditSpendGuardMemo,
  emptyCreditSpendGuardMemo,
  runCreditSpendGuardTick,
} from "./CreditSpendGuardLive.ts";

const instanceA = ProviderInstanceId.make("claude-a");
const instanceB = ProviderInstanceId.make("claude-b");

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

const shell = (
  threadId: string,
  instanceId: ProviderInstanceId,
  activeTurnId: string | null,
  status = "running",
) =>
  ({
    id: ThreadId.make(threadId),
    session: { status, providerInstanceId: instanceId, activeTurnId },
  }) as never;

/** Records every command the tick dispatches, and can be told to fail for one thread. */
const makeHarness = (options?: {
  readonly failInterruptFor?: ReadonlySet<string>;
  readonly failShellSnapshot?: boolean;
  readonly failSettings?: boolean;
}) => {
  const dispatched: { type: string; threadId: string }[] = [];
  let reconciles = 0;
  return {
    dispatched,
    reconciles: () => reconciles,
    deps: {
      getSettings:
        options?.failSettings === true
          ? Effect.fail(new Error("settings unavailable"))
          : Effect.succeed({ allowSpendingCredits: false }),
      getProviders: Effect.succeed([provider(instanceA, 100), provider(instanceB, 10)]),
      getShellSnapshot:
        options?.failShellSnapshot === true
          ? Effect.fail(new Error("projection unavailable"))
          : Effect.succeed({
              threads: [
                shell("t-a1", instanceA, "turn-1"),
                shell("t-a2", instanceA, "turn-2"),
                shell("t-a-idle", instanceA, null),
                shell("t-b", instanceB, "turn-3"),
              ],
            }),
      dispatch: (command: { type: string; threadId: string }) =>
        options?.failInterruptFor?.has(command.threadId) === true &&
        command.type === "thread.turn.interrupt"
          ? Effect.fail(new Error("dispatch failed"))
          : Effect.sync(() => {
              dispatched.push({ type: command.type, threadId: command.threadId });
            }),
      readCursorUsedPercent: Effect.succeed(null),
      reconcileAllBackends: Effect.sync(() => {
        reconciles += 1;
      }),
    },
  };
};

const interruptsFor = (harness: ReturnType<typeof makeHarness>) =>
  harness.dispatched.filter((entry) => entry.type === "thread.turn.interrupt");
const appendsFor = (harness: ReturnType<typeof makeHarness>) =>
  harness.dispatched.filter((entry) => entry.type === "thread.activity.append");

describe("credit spend guard tick", () => {
  it.effect("interrupts only running turns on a newly blocked instance", () =>
    Effect.gen(function* () {
      // I7. Three-way fixture on purpose: one running turn on the blocked instance, one
      // IDLE thread on the blocked instance, and one running turn on a DIFFERENT instance.
      // A single-thread fixture passes for every broken version of this filter.
      const harness = makeHarness();
      const memo = yield* Ref.make(emptyCreditSpendGuardMemo);
      yield* runCreditSpendGuardTick({ ...harness.deps, memo });
      expect(
        interruptsFor(harness)
          .map((entry) => entry.threadId)
          .sort(),
      ).toEqual(["t-a1", "t-a2"]);
    }),
  );

  it.effect("announces each interrupted turn exactly once, however many ticks retry", () =>
    Effect.gen(function* () {
      // I13. t-a1's interrupt keeps failing, so instanceA stays owed and every tick
      // re-sweeps its threads. t-a2 must not collect a fresh timeline entry each time.
      const harness = makeHarness({ failInterruptFor: new Set(["t-a1"]) });
      const memo = yield* Ref.make(emptyCreditSpendGuardMemo);
      yield* runCreditSpendGuardTick({ ...harness.deps, memo });
      yield* runCreditSpendGuardTick({ ...harness.deps, memo });
      yield* runCreditSpendGuardTick({ ...harness.deps, memo });
      expect(appendsFor(harness).filter((entry) => entry.threadId === "t-a2")).toHaveLength(1);
      expect(appendsFor(harness).filter((entry) => entry.threadId === "t-a1")).toHaveLength(1);
    }),
  );

  it.effect("retries the sweep when the projection read failed on the first tick", () =>
    Effect.gen(function* () {
      // I12. Without the pending-debt set, instanceA is already in the blocked memo on
      // tick 2, so it never re-enters "newly blocked" and its turns are NEVER interrupted.
      const memo = yield* Ref.make(emptyCreditSpendGuardMemo);
      const failing = makeHarness({ failShellSnapshot: true });
      yield* runCreditSpendGuardTick({ ...failing.deps, memo });
      expect(interruptsFor(failing)).toHaveLength(0);

      const recovered = makeHarness();
      yield* runCreditSpendGuardTick({ ...recovered.deps, memo });
      expect(
        interruptsFor(recovered)
          .map((entry) => entry.threadId)
          .sort(),
      ).toEqual(["t-a1", "t-a2"]);
    }),
  );

  it.effect("skips the tick without touching the memo when settings cannot be read", () =>
    Effect.gen(function* () {
      // I8. A failed read must not clear the memo: it cannot admit spend (the gates never
      // read the memo) but it must not lose an owed interrupt either.
      const memo = yield* Ref.make(emptyCreditSpendGuardMemo);
      const broken = makeHarness({ failSettings: true });
      yield* runCreditSpendGuardTick({ ...broken.deps, memo });
      expect(broken.dispatched).toHaveLength(0);
      expect(yield* Ref.get(memo)).toEqual(emptyCreditSpendGuardMemo);

      const working = makeHarness();
      yield* runCreditSpendGuardTick({ ...working.deps, memo });
      expect(interruptsFor(working)).toHaveLength(2);
    }),
  );

  it.effect("does not re-interrupt on a later tick while the instance stays blocked", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const memo = yield* Ref.make(emptyCreditSpendGuardMemo);
      yield* runCreditSpendGuardTick({ ...harness.deps, memo });
      yield* runCreditSpendGuardTick({ ...harness.deps, memo });
      expect(interruptsFor(harness)).toHaveLength(2);
    }),
  );

  it.effect("interrupts nothing once spending is allowed again", () =>
    Effect.gen(function* () {
      // I5.
      const memo = yield* Ref.make(emptyCreditSpendGuardMemo);
      const blocked = makeHarness();
      yield* runCreditSpendGuardTick({ ...blocked.deps, memo });
      const allowed = makeHarness();
      yield* runCreditSpendGuardTick({
        ...allowed.deps,
        getSettings: Effect.succeed({ allowSpendingCredits: true }),
        memo,
      });
      expect(interruptsFor(allowed)).toHaveLength(0);
    }),
  );

  it.effect("reconciles subagent flag files only when the Cursor block state changes", () =>
    Effect.gen(function* () {
      // I5's Cursor half. An edge, not a level: rewriting every thread's flag file on
      // every provider tick is O(threads) of pointless disk writes.
      const memo = yield* Ref.make(emptyCreditSpendGuardMemo);
      const harness = makeHarness();
      const blockedCursor = { ...harness.deps, readCursorUsedPercent: Effect.succeed(100) };
      yield* runCreditSpendGuardTick({ ...blockedCursor, memo });
      expect(harness.reconciles()).toBe(1);
      yield* runCreditSpendGuardTick({ ...blockedCursor, memo });
      expect(harness.reconciles()).toBe(1);
      yield* runCreditSpendGuardTick({
        ...harness.deps,
        readCursorUsedPercent: Effect.succeed(40),
        memo,
      });
      expect(harness.reconciles()).toBe(2);
    }),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd apps/server && pnpm exec vp test run src/provider/Layers/CreditSpendGuardLive.test.ts
```

Expected: FAIL — cannot resolve `./CreditSpendGuardLive.ts`.

- [ ] **Step 3: Write the implementation**

Create `apps/server/src/provider/Layers/CreditSpendGuardLive.ts`. Model the layer on
`ProviderUsageLimitsIngestion.ts` (44 lines, `Layer.effectDiscard` + `Stream.runForEach` +
`Effect.forkScoped`, `ignoreCause({ log: true })` per item so one bad tick cannot end the fiber).

Structure:

```ts
/**
 * CreditSpendGuardLive — the side effects the turn-start gates cannot do themselves:
 * interrupting turns already running on an instance that just became blocked, and
 * rewriting the Cursor subagent flag files when Cursor's own block state flips.
 *
 * Deliberately NOT the source of truth for whether spending is allowed. The gates call
 * `creditSpendBlockedReason` live, so nothing this fiber holds — and nothing that happens
 * if it dies — can admit spend.
 *
 * @module provider/Layers/CreditSpendGuardLive
 */

/** Session statuses meaning a process is actively driving this thread, so its turn can spend. */
const LIVE_SESSION_STATUSES = new Set(["idle", "starting", "running", "ready"]);

export interface CreditSpendGuardMemo {
  /** Instances blocked as of the last successful tick; drives the newly-blocked edge. */
  readonly blocked: ReadonlySet<ProviderInstanceId>;
  /** Instances whose interrupt sweep did not complete, retried until it does or they unblock. */
  readonly interruptPending: ReadonlySet<ProviderInstanceId>;
  /** `threadId:turnId` already announced, so a retry tick does not repeat the timeline entry. */
  readonly announced: ReadonlySet<string>;
  /** Cursor's block state as of the last successful tick; drives the reconcile edge. */
  readonly cursorBlocked: boolean;
}

export const emptyCreditSpendGuardMemo: CreditSpendGuardMemo = {
  blocked: new Set(),
  interruptPending: new Set(),
  announced: new Set(),
  cursorBlocked: false,
};
```

`runCreditSpendGuardTick` takes the dependencies as plain Effects (exactly the keys the test's
`deps` object supplies, plus `memo: Ref.Ref<CreditSpendGuardMemo>`) and implements the section 4 E
pseudocode verbatim, in this order:

1. Read settings, then providers. On **either** failure: log `credit-spend-guard.tick-failed` with a
   `stage` field and **return without touching the memo**.
2. Compute `nextBlocked` by calling `creditSpendBlockedReason` per provider.
3. `becameBlocked = nextBlocked \ memo.blocked`; write `blocked: nextBlocked`.
4. `interruptPending = memo.interruptPending ∩ nextBlocked`; `toSweep = becameBlocked ∪ interruptPending`.
5. If `toSweep` is non-empty, read the shell snapshot. **On failure**: set
   `interruptPending: toSweep`, log `credit-spend-guard.interrupt-skipped`, and skip to step 7 —
   this is what makes I12 hold.
6. For each thread whose `session.providerInstanceId ∈ toSweep`, `session.status ∈ LIVE_SESSION_STATUSES`
   and `session.activeTurnId !== null`: append the activity **only if** `threadId:turnId` is not in
   `announced` (then add it), and always dispatch the interrupt. Collect the instance ids whose
   interrupt dispatch failed into the new `interruptPending`. Prune `announced` to the
   `threadId:turnId` pairs still present in the snapshot.
7. Read the Cursor percentage, compute `cursorOffloadBlockedReason`, and call
   `reconcileAllBackends` **only when the boolean differs** from `memo.cursorBlocked`.

The activity command mirrors `ProviderTurnStallWatchdog.ts:130-159` exactly — same
`OrchestrationThreadActivity` shape, `tone: "info"`, `kind: "runtime.warning"`,
`summary: "Credit limit reached — turn interrupted"`, `payload: { message: <the block reason> }`,
`turnId` set to the session's active turn, and the whole append wrapped in
`Effect.timeout(DISPATCH_TIMEOUT)` + a cause catch so a failed append never blocks the interrupt.

The layer itself:

```ts
export const CreditSpendGuardLive = Layer.effectDiscard(
  Effect.gen(function* () {
    // ...resolve services, build a Ref<CreditSpendGuardMemo>, then:
    yield* Stream.merge(providerRegistry.streamChanges, serverSettings.streamChanges).pipe(
      Stream.runForEach(() =>
        runCreditSpendGuardTick({ ...deps, memo }).pipe(Effect.ignoreCause({ log: true })),
      ),
      Effect.forkScoped,
    );
  }),
);
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd apps/server && pnpm exec vp test run src/provider/Layers/CreditSpendGuardLive.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Mutate each guard and confirm the tests go red**

A green suite says nothing about whether a guard guards. Run each mutation, confirm the file still
**compiles**, confirm the named test fails, then revert it. A red that is a SyntaxError proves
nothing.

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd apps/server
# Confirm each edit landed where you meant it to before scoring the row.
grep -n "interruptPending\|announced\|activeTurnId !== null\|LIVE_SESSION_STATUSES" \
  src/provider/Layers/CreditSpendGuardLive.ts
```

| #   | Mutation at the production site                                     | Test that must go RED                                                     |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Delete the `interruptPending` union from `toSweep`                  | "retries the sweep when the projection read failed on the first tick"     |
| 2   | Drop the `announced` check and always append                        | "announces each interrupted turn exactly once"                            |
| 3   | Drop `session.activeTurnId !== null` from the filter                | "interrupts only running turns on a newly blocked instance"               |
| 4   | Drop the `LIVE_SESSION_STATUSES` check                              | "interrupts only running turns on a newly blocked instance"               |
| 5   | Update the memo before the settings-read failure returns            | "skips the tick without touching the memo when settings cannot be read"   |
| 6   | Call `reconcileAllBackends` unconditionally rather than on the edge | "reconciles subagent flag files only when the Cursor block state changes" |

If any mutation leaves the suite green, that test is not pinning what it claims — fix the test
before moving on.

- [ ] **Step 6: Mount the layer**

In `apps/server/src/server.ts`, beside `ProviderUsageLimitsIngestionLive` (`:547`):

```ts
  // Interrupts turns already running on an instance that just hit 100% while
  // `allowSpendingCredits` is off. The turn-start gates do not depend on this fiber.
  Layer.provideMerge(CreditSpendGuardLive),
```

- [ ] **Step 7: Typecheck the server package**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd apps/server && pnpm exec tsc --noEmit
```

Expected: clean. This is the cheapest check that the layer's requirements are all satisfied where it
is mounted.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/provider/Layers/CreditSpendGuardLive.ts \
  apps/server/src/provider/Layers/CreditSpendGuardLive.test.ts apps/server/src/server.ts
git commit -m "feat(server): interrupt running turns when a provider hits its limit"
```

---

### Task 5: WebSocket turn-start gate

**Files:**

- Modify: `apps/server/src/ws.ts` (top of `dispatchNormalizedCommand`, `:1396`)
- Test: `apps/server/src/ws.creditSpendGuard.test.ts`

**Interfaces:**

- Consumes: `creditSpendBlockedReason` (Task 3), `ProviderRegistry`, `ServerSettingsService`,
  `projectionSnapshotQuery.getThreadShellById` (already resolved in `ws.ts`).
- Produces: nothing importable; behaviour only.

**Design invariants covered:** I10, and the ws half of I9.

- [ ] **Step 1: Write the failing test**

Test the **resolution and refusal decision** as an exported pure helper rather than by standing up a
whole WebSocket. Export from `ws.ts`:

```ts
export function resolveTurnStartInstanceId(input: {
  readonly requested: ProviderInstanceId | undefined;
  readonly bootstrapInstanceId: ProviderInstanceId | undefined;
  readonly shell:
    | {
        readonly session: { readonly providerInstanceId?: ProviderInstanceId } | null;
        readonly modelSelection: { readonly instanceId: ProviderInstanceId };
      }
    | undefined;
}): ProviderInstanceId | undefined;
```

Create `apps/server/src/ws.creditSpendGuard.test.ts`:

```ts
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { resolveTurnStartInstanceId } from "./ws.ts";

const requested = ProviderInstanceId.make("requested");
const session = ProviderInstanceId.make("session");
const thread = ProviderInstanceId.make("thread");

const shell = { session: { providerInstanceId: session }, modelSelection: { instanceId: thread } };

describe("resolveTurnStartInstanceId", () => {
  it("prefers an explicitly requested instance", () => {
    expect(resolveTurnStartInstanceId({ requested, bootstrapInstanceId: undefined, shell })).toBe(
      requested,
    );
  });

  it("falls back to the live session's instance, not the thread default", () => {
    // Design P15: with a live session and no requested selection the reactor KEEPS the
    // session, so the turn runs on the session's instance while `desiredInstanceId`
    // holds the thread's. Gating on the thread default checks the wrong account.
    expect(
      resolveTurnStartInstanceId({ requested: undefined, bootstrapInstanceId: undefined, shell }),
    ).toBe(session);
  });

  it("falls back to the thread default when no session is live", () => {
    expect(
      resolveTurnStartInstanceId({
        requested: undefined,
        bootstrapInstanceId: undefined,
        shell: { session: null, modelSelection: { instanceId: thread } },
      }),
    ).toBe(thread);
  });

  it("uses the bootstrap selection when the thread does not exist yet", () => {
    // I10: a bootstrap turn is refused BEFORE thread.create, so there is no shell to read.
    expect(
      resolveTurnStartInstanceId({
        requested: undefined,
        bootstrapInstanceId: thread,
        shell: undefined,
      }),
    ).toBe(thread);
  });

  it("resolves to nothing when there is no instance to name", () => {
    expect(
      resolveTurnStartInstanceId({
        requested: undefined,
        bootstrapInstanceId: undefined,
        shell: undefined,
      }),
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd apps/server && pnpm exec vp test run src/ws.creditSpendGuard.test.ts
```

Expected: FAIL — `resolveTurnStartInstanceId is not a function`.

- [ ] **Step 3: Implement the resolver and the gate**

Add the exported resolver near the other module-scope helpers in `ws.ts`:

```ts
/**
 * Which provider instance a turn start is aimed at, best-effort.
 *
 * Requested selection, then the live session's instance, then the thread's default — the
 * order the reactor's own kept-session path produces. This is deliberately not
 * `desiredInstanceId` from `ProviderCommandReactor`, which skips the session fallback and
 * so names the wrong account whenever a live session runs on a different instance than the
 * thread default. The reactor gate is the authoritative one; this exists so a client gets a
 * synchronous refusal and the sidebar Queue pauses instead of draining.
 */
export function resolveTurnStartInstanceId(/* signature above */) {
  return (
    input.requested ??
    input.shell?.session?.providerInstanceId ??
    input.shell?.modelSelection.instanceId ??
    input.bootstrapInstanceId
  );
}
```

Note the order: `bootstrapInstanceId` is last because a bootstrap command has no shell at all, so
the earlier terms are all `undefined` in exactly that case.

Then, at the **top** of `dispatchNormalizedCommand` (`:1396`), before the
`normalizedCommand.bootstrap ? … : …` ternary so bootstrap is covered too:

```ts
if (normalizedCommand.type === "thread.turn.start") {
  const blocked = yield * creditSpendRefusalFor(normalizedCommand);
  if (blocked !== null) {
    return yield * new OrchestrationDispatchCommandError({ message: blocked });
  }
}
```

`creditSpendRefusalFor` reads the settings and providers, resolves the instance with the helper
above (reading the thread shell with `projectionSnapshotQuery.getThreadShellById`, tolerating a
failed read by treating the shell as `undefined`), and returns `creditSpendBlockedReason(...)`. On a
**settings or provider read failure** it logs `credit-spend-guard.gate-unavailable` and returns
`null` — fail open here, because the reactor gate still refuses authoritatively.

Log `credit-spend-guard.turn-refused` with `{ threadId, instanceId, reason, gate: "ws" }` before
returning the error.

Because `dispatchNormalizedCommand` runs inside the `Effect.tapError(() => cleanupFailedUploadedAttachments(...))`
at `:1543-1544`, a refusal here already releases any attachment the normalizer claimed. Do not add
cleanup.

- [ ] **Step 4: Run the test to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd apps/server && pnpm exec vp test run src/ws.creditSpendGuard.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Confirm the gate really precedes the bootstrap branch**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd apps/server
grep -n "creditSpendRefusalFor\|dispatchBootstrapTurnStart(normalizedCommand)" src/ws.ts
```

Expected: the `creditSpendRefusalFor` call's line number is **lower** than the
`dispatchBootstrapTurnStart(normalizedCommand)` line. If it is not, I10 does not hold and a refused
bootstrap will still have created a thread and a worktree.

- [ ] **Step 6: Typecheck and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd apps/server && pnpm exec tsc --noEmit
git add apps/server/src/ws.ts apps/server/src/ws.creditSpendGuard.test.ts
git commit -m "feat(server): refuse turn starts on a provider that is out of credit"
```

---

### Task 6: Provider reactor turn-start gate

**Files:**

- Modify: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` (in
  `buildSendTurnRequestForThread`, after `ensureSessionForThread` and after `activeSession` is
  resolved at `:1074-1078`)
- Test: `apps/server/src/orchestration/Layers/ProviderCommandReactor.creditSpend.test.ts`

**Interfaces:**

- Consumes: `creditSpendBlockedReason` (Task 3), `ProviderRegistry`, `ServerSettingsService`.

- [ ] **Step 1: Write the failing test**

The reactor is large and layer-heavy; test the decision at the seam rather than by booting it.
Extract and export the two-line decision so it is directly callable:

```ts
export function creditSpendRefusalForSend(input: {
  readonly allowSpendingCredits: boolean;
  readonly providers: readonly ServerProvider[];
  readonly activeSessionInstanceId: ProviderInstanceId | undefined;
}): string | null;
```

Create `apps/server/src/orchestration/Layers/ProviderCommandReactor.creditSpend.test.ts`:

```ts
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { creditSpendRefusalForSend } from "./ProviderCommandReactor.ts";

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
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd apps/server && pnpm exec vp test run \
  src/orchestration/Layers/ProviderCommandReactor.creditSpend.test.ts
```

Expected: FAIL — `creditSpendRefusalForSend is not a function`.

- [ ] **Step 3: Implement the gate**

`creditSpendRefusalForSend` is a thin wrapper over `creditSpendBlockedReason` keyed on
`activeSessionInstanceId`. Call it inside `buildSendTurnRequestForThread` immediately after
`activeSession` is resolved (`:1074-1078`) and before the request object is returned, failing with
the type its eleven sibling refusals already use:

```ts
const creditRefusal = creditSpendRefusalForSend({
  allowSpendingCredits: (yield * serverSettings.getSettings).allowSpendingCredits,
  providers: yield * providerRegistry.getProviders,
  // `ensureSessionForThread` has already run, so `activeSession` is the binding
  // `sendTurn` will route on. The fallback covers the tolerated state where
  // `listSessions()` does not show it (the `sessionModelSwitch` branch just below
  // treats that as "in-session"), so this gate is never weaker than the ws one.
  activeSessionInstanceId: activeSession?.providerInstanceId ?? thread.modelSelection.instanceId,
});
if (creditRefusal !== null) {
  return (
    yield *
    new ProviderAdapterRequestError({
      provider: providerErrorLabel(activeSession?.provider),
      method: "thread.turn.start",
      detail: creditRefusal,
    })
  );
}
```

This point is chosen because `activeSession.providerInstanceId` is the exact binding
`ProviderService.sendTurn` routes on (`ProviderService.ts:1363-1372`), so unlike the ws gate it
cannot name the wrong account. Starting the session costs nothing in credits; only the turn does.

Log `credit-spend-guard.turn-refused` with `{ threadId, instanceId, reason, gate: "reactor" }`.

- [ ] **Step 4: Run the test and the reactor's existing suite**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd apps/server && pnpm exec vp test run \
  src/orchestration/Layers/ProviderCommandReactor.creditSpend.test.ts
pnpm exec vp test run src/orchestration/Layers/ProviderCommandReactor
```

Expected: both PASS. The second command is not optional — this task edits a function every turn
start flows through.

- [ ] **Step 5: Typecheck and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd apps/server && pnpm exec tsc --noEmit
git add apps/server/src/orchestration/Layers/ProviderCommandReactor.ts \
  apps/server/src/orchestration/Layers/ProviderCommandReactor.creditSpend.test.ts
git commit -m "feat(server): refuse server-originated turn starts on an exhausted provider"
```

---

### Task 7: Cursor subagent offload gate

**Files:**

- Modify: `apps/server/src/subagentBackend/SubagentBackend.ts` (`resolveThreadBackend` at `:339`,
  and its two callers at `:454` and `:514`)
- Test: `apps/server/src/subagentBackend/SubagentBackend.thread.test.ts`

**Interfaces:**

- Consumes: `cursorOffloadBlockedReason` (Task 3), `readCursorUsage` from `./cursorUsageRead.ts`.
- Produces: `resolveThreadBackend` gains a required input field
  `creditsBlockedReason: string | null`.

**Design invariant covered:** I6.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/subagentBackend/SubagentBackend.thread.test.ts`:

```ts
it.effect("withholds offload while credits are blocked, whatever the thread mode says", () =>
  Effect.gen(function* () {
    // I6. An explicit per-thread "on" is the strongest possible request to offload, and
    // it must still lose to the credit block — otherwise the switch does nothing for the
    // threads most likely to be spending.
    const threadId = ThreadId.make("t-credit-blocked");
    const settings = {
      subagentBackendEnabled: true,
      subagentBackendThreadModes: { [threadId]: "on" },
    } as unknown as ServerSettings;
    const global: PersistedBackend = {
      backend: "cursor",
      instanceId: ProviderInstanceId.make("cursor-1"),
      model: "auto",
      degraded: null,
    };
    const resolved = yield* resolveThreadBackend({
      settings,
      threadId,
      global,
      creditsBlockedReason: "Cursor has used 100% of its usage",
    });
    expect(resolved.backend).toBe("default");
    expect(resolved.degraded).toContain("100%");
  }),
);

it.effect("offloads normally when credits are not blocked", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("t-credit-ok");
    const settings = {
      subagentBackendEnabled: true,
      subagentBackendThreadModes: { [threadId]: "on" },
    } as unknown as ServerSettings;
    const global: PersistedBackend = {
      backend: "cursor",
      instanceId: ProviderInstanceId.make("cursor-1"),
      model: "auto",
      degraded: null,
    };
    const resolved = yield* resolveThreadBackend({
      settings,
      threadId,
      global,
      creditsBlockedReason: null,
    });
    expect(resolved.backend).toBe("cursor");
  }),
);
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd apps/server && pnpm exec vp test run src/subagentBackend/SubagentBackend.thread.test.ts
```

Expected: FAIL — the first new test resolves `cursor`, and a type error on the unknown
`creditsBlockedReason` key.

- [ ] **Step 3: Implement**

In `resolveThreadBackend` (`:339`), add `creditsBlockedReason: string | null` to the input type and
put the new branch immediately **after** the master-switch branch at `:345-347`, so the ordering
reads master-off, then credits-blocked, then per-thread mode:

```ts
if (input.creditsBlockedReason !== null) {
  return { ...OFF, degraded: input.creditsBlockedReason } satisfies PersistedBackend;
}
```

Both callers compute it from the live Cursor reading. Add a small local helper in the same module so
neither caller duplicates it:

```ts
/** Reads Cursor's usage (cached 60s, never fails) and asks whether offload is blocked. */
const readCreditsBlockedReason = Effect.fn("subagentBackend.creditsBlocked")(function* (
  settings: ServerSettings,
) {
  const usage = yield* readCursorUsage().pipe(Effect.orElseSucceed(() => null));
  return cursorOffloadBlockedReason({
    allowSpendingCredits: settings.allowSpendingCredits,
    cursorUsedPercent: usage?.usedPercent ?? null,
  });
});
```

Call it in `reconcileThreadBackendsBody` (`:454`) once per batch, outside the per-thread
`Effect.forEach`, and in `writeThreadBackendForSession` (`:514`) once, inside the existing permit.
Do **not** call it per thread: it is one account-wide reading, and the 60 s cache makes repeat calls
cheap but not free.

The read is kept in the callers rather than inside `resolveThreadBackend` so the truth table stays a
pure function of its inputs and its tests need no network stub.

- [ ] **Step 4: Run the test to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd apps/server && pnpm exec vp test run src/subagentBackend/
```

Expected: PASS across all six `SubagentBackend.*.test.ts` files. Every existing call site of
`resolveThreadBackend` in those tests needs the new field; adding it is part of this task.

- [ ] **Step 5: Typecheck and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd apps/server && pnpm exec tsc --noEmit
git add apps/server/src/subagentBackend/
git commit -m "feat(server): withhold Cursor subagent offload when credits are blocked"
```

---

### Task 8: Settings row and search entry

**Files:**

- Modify: `apps/web/src/components/settings/SettingsPanels.tsx` (capability near `:2229`; row beside
  the subagent-offload row at `:2787-2814`)
- Modify: `apps/web/src/components/settings/settingsSearch.ts` (item beside `subagent-offload` at
  `:342-349`; `requiresAllowSpendingCredits` beside `:61-62`; filter beside `:941-942`; availability
  field beside `:823`)
- Modify: `apps/web/src/components/settings/useAvailableSettingsSearchItems.ts` (beside `:45-50`)
- Test: `apps/web/src/components/settings/settingsSearch.test.ts`

**Design invariant covered:** I11.

- [ ] **Step 1: Write the failing test**

In `apps/web/src/components/settings/settingsSearch.test.ts`, extend the existing capability-gate
test (`:218-231`) with the same two assertions the crew row has:

```ts
// The same silent-snap-back gate: an older server strips the unknown
// `allowSpendingCredits` key from the patch, so an ungated row would accept the flip
// and revert with no error — and here the direction it reverts to is "keep spending".
expect(without.some((item) => item.id === "allow-spending-credits")).toBe(false);
expect(with_.some((item) => item.id === "allow-spending-credits")).toBe(true);
```

and add `hasAllowSpendingCredits: true` / `false` to the two availability objects in that test.

- [ ] **Step 2: Run the test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd apps/web && pnpm exec vp test run src/components/settings/settingsSearch.test.ts --project unit
```

Expected: FAIL — no item with that id.

- [ ] **Step 3: Add the search item and its gate**

`settingsSearch.ts` — beside `requiresCrew` (`:62`): `readonly requiresAllowSpendingCredits?: boolean;`
In the catalog, beside `subagent-offload` (`:342-349`):

```ts
  {
    id: "allow-spending-credits",
    title: "Allow to spend credits",
    to: "/settings/general",
    searchTerms: ["credits spend usage limit 100% stop pause provider budget"],
    requiresAllowSpendingCredits: true,
  },
```

In the availability type and the filter (`:941-942`):

```ts
      (!item.requiresAllowSpendingCredits || availability.hasAllowSpendingCredits) &&
```

`useAvailableSettingsSearchItems.ts` — beside `hasCrew` (`:49`):

```ts
        hasAllowSpendingCredits: environments.some(
          (environment) =>
            environment.serverConfig?.environment.capabilities.allowSpendingCredits === true,
        ),
```

- [ ] **Step 4: Add the Settings row**

In `SettingsPanels.tsx`, beside `supportsSubagentOffload` (`:2229`):

```ts
const supportsAllowSpendingCredits =
  connectedEnvironments.length > 0 &&
  connectedEnvironments.every(
    (target) => target.serverConfig?.environment.capabilities.allowSpendingCredits === true,
  );
```

and the row itself, immediately after the subagent-offload row (`:2814`), mirroring its shape
including the per-row reset:

```tsx
{
  supportsAllowSpendingCredits ? (
    <SettingsRow
      serverScoped
      {...searchableSetting("allow-spending-credits")}
      description="Let providers keep working after a usage window reaches 100%. Off stops running turns on that provider, refuses new ones, and withholds Cursor subagent offload until the window resets. Only affects providers that report usage limits in Usage → Limits."
      resetAction={
        settings.allowSpendingCredits !== DEFAULT_UNIFIED_SETTINGS.allowSpendingCredits ? (
          <SettingResetButton
            label="allow to spend credits"
            onClick={() =>
              updateSettings({
                allowSpendingCredits: DEFAULT_UNIFIED_SETTINGS.allowSpendingCredits,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.allowSpendingCredits}
          onCheckedChange={(checked) => updateSettings({ allowSpendingCredits: Boolean(checked) })}
          aria-label="Allow to spend credits"
        />
      }
    />
  ) : null;
}
```

The "Only affects providers that report usage limits" sentence is required, not decorative: four of
the six drivers never report usage at all (design P1), so for them the switch does nothing and the
copy is the only thing that says so.

- [ ] **Step 5: Run the tests**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd apps/web && pnpm exec vp test run src/components/settings/ --project unit --project dom
```

Expected: PASS, including the pre-existing `keeps catalog result ids unique` test. Run from
`apps/web`, never the repo root, and pass both projects — the root config cannot resolve named
projects and `--project unit` alone silently skips every `*.dom.test.tsx`.

- [ ] **Step 6: Typecheck and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
cd apps/web && pnpm exec tsc --noEmit
git add apps/web/src/components/settings/
git commit -m "feat(web): add the Allow to spend credits setting"
```

---

### Task 9: User documentation

**Files:**

- Modify: `docs/user/usage.md` (after the "Track subscription limits" section, which ends near `:68`)

- [ ] **Step 1: Read the surrounding section**

```bash
sed -n '40,75p' docs/user/usage.md
```

Match its voice: shipped-product, task-focused, no implementation detail, no contributor tooling.

- [ ] **Step 2: Add the subsection**

```markdown
### Stop spending at the limit

In **Settings → General**, turn off **Allow to spend credits** when you want the server to pause
work once a provider's usage window reaches 100%. Running turns on that provider stop, and new ones
are refused until you turn spending back on or the window resets. Threads waiting in the sidebar
Queue pause rather than failing one by one. This only affects providers that report limits in
**Usage → Limits**.

If you downgrade to an older version of T3 Code, spending turns back on automatically — the older
server cannot enforce this setting.
```

- [ ] **Step 3: Format and commit**

```bash
export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"
pnpm fmt
git add docs/user/usage.md
git commit -m "docs(user): document the Allow to spend credits setting"
```

---

## Invariant → task map

Stage 9's mutation walk uses this. Every numbered invariant in the design has a task and a test.

| Invariant                                                  | Established in                     | Pinned by                                                                                                   |
| ---------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| I1 never refuse while the switch is on                     | Task 3, `creditSpendBlockedReason` | "never blocks while spending is allowed"                                                                    |
| I2 never refuse without an affirmative 100%                | Tasks 2 and 3                      | `exhaustedUsageWindows` table; "does not block below the cap"                                               |
| I3                                                         | _retired in design revision 2_     | —                                                                                                           |
| I4 toggle flip acts within one tick                        | Task 4                             | "skips the tick…" + the settings stream in the layer                                                        |
| I5 unblock restores, Cursor files rewritten on the edge    | Task 4                             | "interrupts nothing once spending is allowed again"; "reconciles… only when the Cursor block state changes" |
| I6 blocked Cursor never offloads                           | Task 7                             | "withholds offload while credits are blocked"                                                               |
| I7 interrupt only running turns on newly blocked instances | Task 4                             | "interrupts only running turns…" (3-thread fixture)                                                         |
| I8 a bad tick neither kills the fiber nor moves the memo   | Task 4                             | "skips the tick without touching the memo"                                                                  |
| I9 the gate never depends on the fiber                     | Tasks 3, 5, 6                      | Task 3's suite runs with no layer at all                                                                    |
| I10 a refused bootstrap creates nothing                    | Task 5                             | "uses the bootstrap selection…" + the Step 5 ordering check                                                 |
| I11 no row without the capability                          | Tasks 1 and 8                      | `ServerEnvironment.test.ts` assertion; `settingsSearch.test.ts` gate                                        |
| I12 a failed projection read still interrupts later        | Task 4                             | "retries the sweep when the projection read failed"                                                         |
| I13 one announcement per interrupted turn                  | Task 4                             | "announces each interrupted turn exactly once"                                                              |

## Verification tasks carried from Stage 6

- [ ] **Run the Task 4 Step 5 mutation table.** Stage 6 retired the safety lens on the explicit
      understanding that I13 would be checked as a mutation on running code rather than another round of
      design review. This is that check; it is not optional.
- [ ] **Settle the model-scoped weekly window question.** Claude publishes `seven_day_<model>` rows
      (`claudeUsageLimits.ts:62-77`). This design blocks on them like any other window. Add one case to
      Task 2's table asserting a `seven_day_fable` row at 100% is reported, so the behaviour is visible
      in a test rather than incidental, and note it in the Stage 10 report as a decision the user may
      want to revisit.
