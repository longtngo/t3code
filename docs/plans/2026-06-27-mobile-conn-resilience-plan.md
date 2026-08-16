# Mobile Connection Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the t3code web app quiet and lossless on a flaky mobile connection — silence brief disconnect/reconnect blips, show an ambient connection dot, queue user messages while disconnected and flush them on reconnect, and never give up reconnecting.

**Architecture:** Four changes, all in `apps/web` + one client-runtime constant. (1) `reconnectBackoff.maxRetries → null` for infinite retry. (2) A grace window in `WebSocketConnectionCoordinator` derived from `status.disconnectedAt`. (3) A `SidebarConnectionStatus` dot. (4) An in-memory `commandOutbox` (zustand) that `ChatView.onSend` enqueues into when disconnected and a coordinator flushes on reconnect — safe because the server dedupes by `commandId`.

**Tech Stack:** TypeScript, React, Effect-TS, zustand, `vite-plus/test` (vitest), Playwright browser tests.

## Global Constraints

- Test runner: `vp test` (alias for vitest via `vite-plus/test`). Unit project default; browser project via `--project browser`.
- From the worktree root, run web unit tests with: `pnpm --filter @t3tools/web test run <path>` (or `cd apps/web && pnpm vp test run <path>`). Client-runtime: `pnpm --filter @t3tools/client-runtime test run <path>`.
- The outbox MUST stay OFF the `WsRpcClient`/`EnvironmentApi` surface (call the existing `api.orchestration.dispatchCommand`); adding an RPC method breaks 3 typed mocks.
- Reuse `isTransportConnectionErrorMessage` from `@t3tools/client-runtime` for transport-error classification — do not invent a new matcher.
- Server idempotency keys on `commandId` (`OrchestrationEngine.ts:147-156`): replaying an accepted command returns its cached receipt; a previously-rejected command throws `OrchestrationCommandPreviouslyRejectedError`.
- Pure-logic convention: extract decision logic into a `*.logic.ts`-style module and unit-test it (mirrors `shouldAutoReconnect`).
- Commit after each task with a conventional-commit message.

---

### Task 1: Infinite retry + decouple reconnect display constants

**Files:**

- Modify: `packages/client-runtime/src/reconnectBackoff.ts` (the `DEFAULT_RECONNECT_BACKOFF` literal)
- Modify: `packages/client-runtime/src/reconnectBackoff.test.ts` (3 inverted assertions)
- Modify: `apps/web/src/rpc/wsConnectionState.ts:10-14` (decouple `WS_RECONNECT_*`)
- Modify: `apps/web/src/rpc/wsConnectionState.test.ts:95-106` (exhausted test)
- Modify: `apps/web/src/components/WebSocketConnectionSurface.tsx:44-50` (`formatReconnectAttemptLabel`, drop `/max`) and line 11 (remove `WS_RECONNECT_MAX_ATTEMPTS` import)

**Interfaces:**

- Produces: `DEFAULT_RECONNECT_BACKOFF.maxRetries === null`; `getReconnectDelayMs(n)` returns a capped `64_000` for all `n` (never `null`); `applyDisconnectState` never reaches `reconnectPhase: "exhausted"` for in-range retries.

- [ ] **Step 1: Update the backoff test to the infinite-retry expectations**

In `packages/client-runtime/src/reconnectBackoff.test.ts`, change the three assertions that hardcode the finite cap. Find `expect(getReconnectDelayMs(7)).toBeNull()` → `expect(getReconnectDelayMs(7)).toBe(64_000)`; `expect(getReconnectDelayMs(100)).toBeNull()` → `expect(getReconnectDelayMs(100)).toBe(64_000)`; `expect(DEFAULT_RECONNECT_BACKOFF.maxRetries).toBe(7)` → `expect(DEFAULT_RECONNECT_BACKOFF.maxRetries).toBeNull()`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @t3tools/client-runtime test run src/reconnectBackoff.test.ts`
Expected: FAIL (current `maxRetries: 7` still returns `null` at index 7).

- [ ] **Step 3: Flip `maxRetries` to null**

In `packages/client-runtime/src/reconnectBackoff.ts`, change the `DEFAULT_RECONNECT_BACKOFF` literal field `maxRetries: 7,` to `maxRetries: null,`. Update the doc comment above it from "up to 7 retries" to "retries forever at the capped delay".

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @t3tools/client-runtime test run src/reconnectBackoff.test.ts`
Expected: PASS.

- [ ] **Step 5: Decouple the web display constants**

In `apps/web/src/rpc/wsConnectionState.ts`, replace lines 13-14:

```ts
export const WS_RECONNECT_MAX_RETRIES = DEFAULT_RECONNECT_BACKOFF.maxRetries!;
export const WS_RECONNECT_MAX_ATTEMPTS = WS_RECONNECT_MAX_RETRIES + 1;
```

with display-decoupled literals (no longer derived from the now-nullable config):

```ts
// Display-only: the reconnect UI no longer shows a finite attempt ceiling
// (retries are unbounded). Kept for back-compat of the status shape.
export const WS_RECONNECT_MAX_ATTEMPTS = 8;
```

Remove the now-unused `WS_RECONNECT_MAX_RETRIES` export and, if `getReconnectDelayMsForRetry`/other code referenced it, confirm via grep there are no remaining importers: `grep -rn 'WS_RECONNECT_MAX_RETRIES' apps/web/src` must return nothing.

- [ ] **Step 6: Simplify the attempt label**

In `apps/web/src/components/WebSocketConnectionSurface.tsx`, change `formatReconnectAttemptLabel` (lines 44-50) to drop the denominator and the clamp:

```ts
function formatReconnectAttemptLabel(status: WsConnectionStatus): string {
  return `Attempt ${Math.max(1, status.reconnectAttemptCount)}`;
}
```

Remove `WS_RECONNECT_MAX_ATTEMPTS` from the import on line 11 if it is no longer referenced elsewhere in the file (grep within the file).

- [ ] **Step 7: Fix the exhausted unit test to use an explicit finite config**

In `apps/web/src/rpc/wsConnectionState.test.ts`, the test at ~95-106 ("marks the reconnect cycle as exhausted after the final attempt fails") can no longer reach `exhausted` via the default backoff. Rewrite it to assert the new reality: drive `recordWsConnectionErrored()` a few times and assert the phase stays `"waiting"` with a non-null `nextRetryAt` and a growing `reconnectAttemptCount` — i.e. it never becomes `"exhausted"`. Concretely replace the loop+exhausted assertion with:

```ts
recordWsConnectionAttempt("wss://x");
recordWsConnectionOpened();
for (let attempt = 0; attempt < 12; attempt += 1) {
  recordWsConnectionAttempt("wss://x");
  recordWsConnectionErrored("boom");
}
expect(getWsConnectionStatus()).toMatchObject({
  reconnectPhase: "waiting",
});
expect(getWsConnectionStatus().nextRetryAt).not.toBeNull();
```

(Keep the surrounding `resetWsConnectionStateForTests()` setup.)

- [ ] **Step 8: Run the affected web tests**

Run: `pnpm --filter @t3tools/web test run src/rpc/wsConnectionState.test.ts src/components/WebSocketConnectionSurface.logic.test.ts`
Expected: PASS (the logic test's `reconnectMaxAttempts: 8` fixture is inert; the exhausted-focus test still passes because it constructs the state directly).

- [ ] **Step 9: Commit**

```bash
git add packages/client-runtime/src/reconnectBackoff.ts packages/client-runtime/src/reconnectBackoff.test.ts apps/web/src/rpc/wsConnectionState.ts apps/web/src/rpc/wsConnectionState.test.ts apps/web/src/components/WebSocketConnectionSurface.tsx
git commit -m "feat(web): never give up reconnecting (infinite backoff) and drop the attempt ceiling"
```

---

### Task 2: Grace period — silence brief blips

**Files:**

- Modify: `apps/web/src/components/WebSocketConnectionSurface.tsx` (add consts + pure helpers + wire `WebSocketConnectionCoordinator`)
- Modify: `apps/web/src/components/WebSocketConnectionSurface.logic.test.ts` (tests for the helpers)

**Interfaces:**

- Produces:
  - `WS_OUTAGE_GRACE_MS = 3_000`, `WS_OFFLINE_GRACE_MS = 0`
  - `outageGraceMs(uiState: WsConnectionUiState): number`
  - `shouldSurfaceOutage(status: WsConnectionStatus, nowMs: number, graceMs: number): boolean`

- [ ] **Step 1: Write the failing helper tests**

In `apps/web/src/components/WebSocketConnectionSurface.logic.test.ts`, add (the file already imports `makeStatus`; reuse it):

```ts
import {
  outageGraceMs,
  shouldSurfaceOutage,
  WS_OUTAGE_GRACE_MS,
} from "./WebSocketConnectionSurface";

describe("shouldSurfaceOutage", () => {
  const start = Date.parse("2026-04-03T20:00:00.000Z");
  it("stays silent before the grace window elapses", () => {
    const status = makeStatus({
      hasConnected: true,
      disconnectedAt: new Date(start).toISOString(),
      reconnectPhase: "waiting",
    });
    expect(shouldSurfaceOutage(status, start + 1_000, WS_OUTAGE_GRACE_MS)).toBe(false);
  });
  it("surfaces once the grace window elapses", () => {
    const status = makeStatus({
      hasConnected: true,
      disconnectedAt: new Date(start).toISOString(),
      reconnectPhase: "waiting",
    });
    expect(shouldSurfaceOutage(status, start + 3_000, WS_OUTAGE_GRACE_MS)).toBe(true);
  });
  it("surfaces immediately when exhausted regardless of timing", () => {
    const status = makeStatus({ hasConnected: true, reconnectPhase: "exhausted" });
    expect(shouldSurfaceOutage(status, start, WS_OUTAGE_GRACE_MS)).toBe(true);
  });
  it("stays silent when there is no active outage", () => {
    expect(shouldSurfaceOutage(makeStatus({ disconnectedAt: null }), start, 0)).toBe(false);
  });
});

describe("outageGraceMs", () => {
  it("surfaces offline immediately and other outages after the window", () => {
    expect(outageGraceMs("offline")).toBe(0);
    expect(outageGraceMs("reconnecting")).toBe(WS_OUTAGE_GRACE_MS);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @t3tools/web test run src/components/WebSocketConnectionSurface.logic.test.ts`
Expected: FAIL ("shouldSurfaceOutage is not exported").

- [ ] **Step 3: Add the consts + pure helpers**

In `apps/web/src/components/WebSocketConnectionSurface.tsx`, near the top (by `FORCED_WS_RECONNECT_DEBOUNCE_MS`, line 16):

```ts
export const WS_OUTAGE_GRACE_MS = 3_000;
export const WS_OFFLINE_GRACE_MS = 0;

export function outageGraceMs(uiState: WsConnectionUiState): number {
  return uiState === "offline" ? WS_OFFLINE_GRACE_MS : WS_OUTAGE_GRACE_MS;
}

export function shouldSurfaceOutage(
  status: WsConnectionStatus,
  nowMs: number,
  graceMs: number,
): boolean {
  if (status.reconnectPhase === "exhausted") {
    return true;
  }
  if (status.disconnectedAt === null) {
    return false;
  }
  return nowMs - new Date(status.disconnectedAt).getTime() >= graceMs;
}
```

- [ ] **Step 4: Run to verify the helpers pass**

Run: `pnpm --filter @t3tools/web test run src/components/WebSocketConnectionSurface.logic.test.ts`
Expected: PASS.

- [ ] **Step 5: Widen the 1s tick to run during any outage**

In `WebSocketConnectionCoordinator`, the interval effect (lines 223-236) currently only ticks while `reconnectPhase === "waiting" && nextRetryAt !== null`. Change its guard so it also ticks during the silent grace window: run the interval whenever `getWsConnectionUiState(status) !== "connected"`. Replace the early-return condition at the top of that effect:

```ts
useEffect(() => {
  if (getWsConnectionUiState(status) === "connected") {
    return;
  }
  setNowMs(Date.now());
  const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000);
  return () => window.clearInterval(intervalId);
}, [status]);
```

- [ ] **Step 6: Add the `outageSurfacedRef` and gate the toast effect**

In `WebSocketConnectionCoordinator`, add a ref next to the others (lines 152-155): `const outageSurfacedRef = useRef(false);`. In the toast effect (lines 270-368), after computing `uiState` and the three `shouldShow*` booleans, compute:

```ts
const isOutage = shouldShowReconnectToast || shouldShowOfflineToast || shouldShowExhaustedToast;
const surfaced = isOutage && shouldSurfaceOutage(status, nowMs, outageGraceMs(uiState));
if (surfaced) {
  outageSurfacedRef.current = true;
}
```

Then change the render condition: where the code currently does `if (shouldShowReconnectToast || shouldShowOfflineToast || shouldShowExhaustedToast) { …render toast… } else if (toastIdRef.current) { close }`, replace the leading condition with `if (surfaced)`. Leave the inner add/update toast block (lines 286-336) unchanged — it already reads live `status`/`nowMs`.

- [ ] **Step 7: Gate the success toast on having surfaced, then reset**

In the same effect, the success-toast block (lines 338-364) fires on the transition to `connected`. Wrap its condition to also require `outageSurfacedRef.current`:

```ts
    if (
      uiState === "connected" &&
      (previousUiState === "offline" || previousUiState === "reconnecting") &&
      previousDisconnectedAt !== null &&
      outageSurfacedRef.current
    ) {
      …existing success toast…
    }
    if (uiState === "connected") {
      outageSurfacedRef.current = false;
    }
```

(The `outageSurfacedRef` reset on every connected run guarantees the next outage starts un-surfaced.)

- [ ] **Step 8: Run the full file's tests + typecheck**

Run: `pnpm --filter @t3tools/web test run src/components/WebSocketConnectionSurface.logic.test.ts && pnpm --filter @t3tools/web exec tsc --noEmit -p tsconfig.json`
Expected: PASS / no type errors. (If the repo uses a different typecheck command, prefer `pnpm --filter @t3tools/web typecheck`.)

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/WebSocketConnectionSurface.tsx apps/web/src/components/WebSocketConnectionSurface.logic.test.ts
git commit -m "feat(web): add a grace window so brief connection blips stay silent"
```

---

### Task 3: Ambient connection indicator

**Files:**

- Create: `apps/web/src/components/sidebar/SidebarConnectionStatus.tsx`
- Create: `apps/web/src/components/sidebar/sidebarConnectionStatus.logic.ts`
- Create: `apps/web/src/components/sidebar/sidebarConnectionStatus.logic.test.ts`
- Modify: `apps/web/src/components/Sidebar.tsx` (mount in `SidebarFooter` ~line 2546 and beside `SidebarTrigger` ~line 2500)

**Interfaces:**

- Consumes: `useWsConnectionStatus`, `getWsConnectionUiState` (`apps/web/src/rpc/wsConnectionState.ts`); `formatConnectionMoment`, `formatRetryCountdown` (export these two from `WebSocketConnectionSurface.tsx` if not already exported).
- Produces: `connectionDotTone(uiState): { colorClass: string; pulse: boolean; label: string }`; default-exported `<SidebarConnectionStatus />` and a `<SidebarConnectionDot />` compact variant (same component, `compact` prop).

- [ ] **Step 1: Write the failing tone-helper test**

Create `apps/web/src/components/sidebar/sidebarConnectionStatus.logic.test.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";
import { connectionDotTone } from "./sidebarConnectionStatus.logic";

describe("connectionDotTone", () => {
  it("is green and steady when connected", () => {
    expect(connectionDotTone("connected")).toMatchObject({ pulse: false, label: "Connected" });
  });
  it("pulses amber while reconnecting/connecting", () => {
    expect(connectionDotTone("reconnecting").pulse).toBe(true);
    expect(connectionDotTone("connecting").pulse).toBe(true);
  });
  it("is red when offline or errored", () => {
    expect(connectionDotTone("offline").label).toBe("Offline");
    expect(connectionDotTone("error").label).toBe("Disconnected");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @t3tools/web test run src/components/sidebar/sidebarConnectionStatus.logic.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the tone helper**

Create `apps/web/src/components/sidebar/sidebarConnectionStatus.logic.ts`:

```ts
import type { WsConnectionUiState } from "../../rpc/wsConnectionState";

export interface ConnectionDotTone {
  readonly colorClass: string;
  readonly pulse: boolean;
  readonly label: string;
}

export function connectionDotTone(uiState: WsConnectionUiState): ConnectionDotTone {
  switch (uiState) {
    case "connected":
      return { colorClass: "bg-emerald-500", pulse: false, label: "Connected" };
    case "connecting":
      return { colorClass: "bg-amber-500", pulse: true, label: "Connecting" };
    case "reconnecting":
      return { colorClass: "bg-amber-500", pulse: true, label: "Reconnecting" };
    case "offline":
      return { colorClass: "bg-red-500", pulse: false, label: "Offline" };
    case "error":
      return { colorClass: "bg-red-500", pulse: false, label: "Disconnected" };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @t3tools/web test run src/components/sidebar/sidebarConnectionStatus.logic.test.ts`
Expected: PASS.

- [ ] **Step 5: Export the two formatters from WebSocketConnectionSurface.tsx**

In `apps/web/src/components/WebSocketConnectionSurface.tsx`, add `export` to `formatConnectionMoment` (line 27) and `formatRetryCountdown` (line 35) so the indicator can reuse them for the tooltip.

- [ ] **Step 6: Implement the component**

Create `apps/web/src/components/sidebar/SidebarConnectionStatus.tsx`:

```tsx
import { getWsConnectionUiState, useWsConnectionStatus } from "../../rpc/wsConnectionState";
import { formatConnectionMoment, formatRetryCountdown } from "../WebSocketConnectionSurface";
import { connectionDotTone } from "./sidebarConnectionStatus.logic";

function buildTitle(status: ReturnType<typeof useWsConnectionStatus>, label: string): string {
  if (label === "Connected") {
    const since = formatConnectionMoment(status.connectedAt);
    return since ? `Connected since ${since}` : "Connected";
  }
  const dropped = formatConnectionMoment(status.disconnectedAt);
  const retry =
    status.nextRetryAt !== null
      ? ` · retry in ${formatRetryCountdown(status.nextRetryAt, Date.now())}`
      : "";
  return `${label}${dropped ? ` since ${dropped}` : ""}${retry}`;
}

export default function SidebarConnectionStatus({
  compact = false,
}: {
  readonly compact?: boolean;
}) {
  const status = useWsConnectionStatus();
  const tone = connectionDotTone(getWsConnectionUiState(status));
  const dot = (
    <span
      aria-hidden
      className={`inline-block size-2 rounded-full ${tone.colorClass} ${tone.pulse ? "animate-pulse" : ""}`}
    />
  );
  if (compact) {
    return (
      <span
        className="flex items-center"
        title={buildTitle(status, tone.label)}
        aria-label={tone.label}
      >
        {dot}
      </span>
    );
  }
  return (
    <div
      className="flex items-center gap-2 px-2 py-1 text-muted-foreground text-xs"
      title={buildTitle(status, tone.label)}
    >
      {dot}
      <span>{tone.label}</span>
    </div>
  );
}
```

- [ ] **Step 7: Mount it in the sidebar**

In `apps/web/src/components/Sidebar.tsx`: import the component (`import SidebarConnectionStatus from "./sidebar/SidebarConnectionStatus";`). Render `<SidebarConnectionStatus />` inside `SidebarFooter` (~line 2546, above/below the existing footer content). Render `<SidebarConnectionStatus compact />` directly next to the `<SidebarTrigger className="shrink-0 md:hidden" />` at ~line 2500 (wrap both in a flex container if needed) so the dot is visible on mobile when the sidebar is off-canvas.

- [ ] **Step 8: Run web unit suite for the new files + typecheck**

Run: `pnpm --filter @t3tools/web test run src/components/sidebar/sidebarConnectionStatus.logic.test.ts && pnpm --filter @t3tools/web typecheck`
Expected: PASS / no type errors.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/sidebar/SidebarConnectionStatus.tsx apps/web/src/components/sidebar/sidebarConnectionStatus.logic.ts apps/web/src/components/sidebar/sidebarConnectionStatus.logic.test.ts apps/web/src/components/Sidebar.tsx apps/web/src/components/WebSocketConnectionSurface.tsx
git commit -m "feat(web): show an ambient connection-status dot in the sidebar"
```

---

### Task 4: Offline outbox store + send-disposition helper

**Files:**

- Create: `apps/web/src/rpc/commandOutbox.ts`
- Create: `apps/web/src/rpc/commandOutbox.test.ts`
- Modify: `apps/web/src/components/ChatView.logic.ts` (add `decideSendDisposition`)
- Modify: `apps/web/src/components/ChatView.logic.test.ts` (tests)

**Interfaces:**

- Consumes: `ClientOrchestrationCommand` types from `@t3tools/contracts` (the `dispatchCommand` input union); `isTransportConnectionErrorMessage` from `@t3tools/client-runtime`; `MessageId` from `@t3tools/contracts`.
- Produces:
  - `commandOutbox.ts`: `isQueueableCommand(cmd): boolean` (true iff `cmd.type === "thread.turn.start"`); a zustand store via `useCommandOutbox`; `enqueueCommand(command, messageId)`; `getQueuedCommands(): readonly QueuedCommand[]`; `clearOutboxForTests()`; `flushOutbox(send): Promise<void>` where `send: (command) => Promise<unknown>`.
  - `QueuedCommand = { command: <turn.start command>; messageId: MessageId; enqueuedAt: string }`.
  - `ChatView.logic.ts`: `decideSendDisposition(input: { hasConnected: boolean; uiState: WsConnectionUiState }): "dispatch" | "queue"` and `shouldQueueOnError(errorMessage: string | null): boolean`.

- [ ] **Step 1: Write failing tests for the disposition helper**

In `apps/web/src/components/ChatView.logic.test.ts`, add:

```ts
import { decideSendDisposition, shouldQueueOnError } from "./ChatView.logic";

describe("decideSendDisposition", () => {
  it("dispatches when connected", () => {
    expect(decideSendDisposition({ hasConnected: true, uiState: "connected" })).toBe("dispatch");
  });
  it("queues when previously connected and now in an outage", () => {
    expect(decideSendDisposition({ hasConnected: true, uiState: "reconnecting" })).toBe("queue");
    expect(decideSendDisposition({ hasConnected: true, uiState: "offline" })).toBe("queue");
  });
  it("dispatches before the first successful connection (so tests/initial load are not mis-queued)", () => {
    expect(decideSendDisposition({ hasConnected: false, uiState: "connecting" })).toBe("dispatch");
  });
});

describe("shouldQueueOnError", () => {
  it("queues on transport errors, not on app errors", () => {
    expect(shouldQueueOnError("SocketCloseError: gone")).toBe(true);
    expect(shouldQueueOnError("Thread not found")).toBe(false);
    expect(shouldQueueOnError(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @t3tools/web test run src/components/ChatView.logic.test.ts`
Expected: FAIL (helpers not exported).

- [ ] **Step 3: Implement the disposition helpers**

In `apps/web/src/components/ChatView.logic.ts`, add (import the type + classifier at the top):

```ts
import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime";
import type { WsConnectionUiState } from "../rpc/wsConnectionState";

export function decideSendDisposition(input: {
  readonly hasConnected: boolean;
  readonly uiState: WsConnectionUiState;
}): "dispatch" | "queue" {
  return input.hasConnected && input.uiState !== "connected" ? "queue" : "dispatch";
}

export function shouldQueueOnError(errorMessage: string | null): boolean {
  return isTransportConnectionErrorMessage(errorMessage);
}
```

- [ ] **Step 4: Run to verify the helpers pass**

Run: `pnpm --filter @t3tools/web test run src/components/ChatView.logic.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing tests for the outbox store**

Create `apps/web/src/rpc/commandOutbox.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  clearOutboxForTests,
  enqueueCommand,
  flushOutbox,
  getQueuedCommands,
  isQueueableCommand,
} from "./commandOutbox";

function turnStart(id: string) {
  return {
    type: "thread.turn.start" as const,
    commandId: id,
    threadId: "t1",
    message: { messageId: `m-${id}`, role: "user" as const, text: "hi", attachments: [] },
    runtimeMode: "local" as const,
    interactionMode: "chat" as const,
    createdAt: "2026-06-27T00:00:00.000Z",
  };
}

beforeEach(() => clearOutboxForTests());

describe("commandOutbox", () => {
  it("recognizes only turn.start as queueable", () => {
    expect(isQueueableCommand(turnStart("a"))).toBe(true);
    expect(isQueueableCommand({ type: "thread.delete", commandId: "x" } as never)).toBe(false);
  });

  it("flushes FIFO and dequeues on success", async () => {
    enqueueCommand(turnStart("a"), "m-a" as never);
    enqueueCommand(turnStart("b"), "m-b" as never);
    const sent: string[] = [];
    await flushOutbox(async (c) => {
      sent.push(c.commandId);
    });
    expect(sent).toEqual(["a", "b"]);
    expect(getQueuedCommands()).toHaveLength(0);
  });

  it("stops and keeps the remainder on a transport error", async () => {
    enqueueCommand(turnStart("a"), "m-a" as never);
    enqueueCommand(turnStart("b"), "m-b" as never);
    await flushOutbox(async (c) => {
      if (c.commandId === "a") throw new Error("SocketCloseError: gone");
    });
    expect(getQueuedCommands().map((q) => q.command.commandId)).toEqual(["a", "b"]);
  });

  it("drops the head on a terminal (non-transport) error and continues", async () => {
    const onTerminal = vi.fn();
    enqueueCommand(turnStart("a"), "m-a" as never);
    enqueueCommand(turnStart("b"), "m-b" as never);
    await flushOutbox(
      async (c) => {
        if (c.commandId === "a") throw new Error("Thread not found");
      },
      { onTerminalError: onTerminal },
    );
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(getQueuedCommands().map((q) => q.command.commandId)).toEqual([]);
  });

  it("is a no-op flush when empty", async () => {
    const send = vi.fn();
    await flushOutbox(send as never);
    expect(send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter @t3tools/web test run src/rpc/commandOutbox.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 7: Implement the outbox store**

Create `apps/web/src/rpc/commandOutbox.ts`:

```ts
import type { MessageId } from "@t3tools/contracts";
import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime";
import { create } from "zustand";

// v1 queues only user turn-starts. Widen this predicate to add more later.
type QueueableCommand = { readonly type: "thread.turn.start"; readonly commandId: string } & Record<
  string,
  unknown
>;

export interface QueuedCommand {
  readonly command: QueueableCommand;
  readonly messageId: MessageId;
  readonly enqueuedAt: string;
}

interface OutboxState {
  readonly queue: readonly QueuedCommand[];
}

export const useCommandOutbox = create<OutboxState>(() => ({ queue: [] }));

export function isQueueableCommand(command: {
  readonly type?: string;
}): command is QueueableCommand {
  return command.type === "thread.turn.start";
}

export function getQueuedCommands(): readonly QueuedCommand[] {
  return useCommandOutbox.getState().queue;
}

export function isMessageQueued(messageId: MessageId): boolean {
  return useCommandOutbox.getState().queue.some((q) => q.messageId === messageId);
}

export function enqueueCommand(command: QueueableCommand, messageId: MessageId): void {
  useCommandOutbox.setState((state) =>
    state.queue.some((q) => q.command.commandId === command.commandId)
      ? state
      : { queue: [...state.queue, { command, messageId, enqueuedAt: new Date().toISOString() }] },
  );
}

function dropHead(): void {
  useCommandOutbox.setState((state) => ({ queue: state.queue.slice(1) }));
}

export function clearOutboxForTests(): void {
  useCommandOutbox.setState({ queue: [] });
}

export async function flushOutbox(
  send: (command: QueueableCommand) => Promise<unknown>,
  options?: { readonly onTerminalError?: (queued: QueuedCommand, error: unknown) => void },
): Promise<void> {
  // Sequential FIFO. Re-read the live head each iteration so a concurrent
  // enqueue/dequeue cannot desync the cursor.
  for (;;) {
    const head = useCommandOutbox.getState().queue[0];
    if (head === undefined) return;
    try {
      await send(head.command);
      dropHead(); // idempotent server-side (dedupe by commandId), so a re-send is safe
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTransportConnectionErrorMessage(message)) {
        return; // transport dropped again — keep the remainder for the next reconnect
      }
      options?.onTerminalError?.(head, error); // rejected receipt / invalid command — drop so it can't wedge FIFO
      dropHead();
    }
  }
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm --filter @t3tools/web test run src/rpc/commandOutbox.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/rpc/commandOutbox.ts apps/web/src/rpc/commandOutbox.test.ts apps/web/src/components/ChatView.logic.ts apps/web/src/components/ChatView.logic.test.ts
git commit -m "feat(web): add in-memory command outbox + send-disposition helpers"
```

---

### Task 5: Wire the outbox into ChatView + flush coordinator

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx` (`onSend`: hoist `commandId`, dispatch-or-queue, transport-error catch, queued badge)
- Create: `apps/web/src/components/OutboxFlushCoordinator.tsx`
- Modify: `apps/web/src/routes/__root.tsx` (mount the coordinator)

**Interfaces:**

- Consumes: `decideSendDisposition`, `shouldQueueOnError` (Task 4); `enqueueCommand`, `flushOutbox`, `useCommandOutbox`, `isMessageQueued` (Task 4); `getWsConnectionStatus`, `getWsConnectionUiState`, `useWsConnectionStatus` (`wsConnectionState.ts`); `api.orchestration.dispatchCommand` (existing).

- [ ] **Step 1: Hoist `commandId` and build the envelope once**

In `apps/web/src/components/ChatView.tsx onSend`, next to `const messageIdForSend = newMessageId();` (line 3186) add `const commandIdForSend = newCommandId();`. Build the turn-start command as a local `const turnStartCommand = { type: "thread.turn.start", commandId: commandIdForSend, threadId: threadIdForSend, message: { messageId: messageIdForSend, role: "user", text: outgoingMessageText, attachments: turnAttachments }, modelSelection: ctxSelectedModelSelection, titleSeed: title, runtimeMode, interactionMode, ...(bootstrap ? { bootstrap } : {}), createdAt: messageCreatedAt } as const;` (replacing the inline object currently passed at line 3329).

- [ ] **Step 2: Branch dispatch-vs-queue up front**

Replace the `await api.orchestration.dispatchCommand({…inline…})` at line 3329 with a disposition branch. Import `decideSendDisposition`, `shouldQueueOnError` from `./ChatView.logic` and `enqueueCommand` from `../rpc/commandOutbox`, plus `getWsConnectionStatus`, `getWsConnectionUiState` from `../rpc/wsConnectionState`:

```ts
const wsStatus = getWsConnectionStatus();
const disposition = decideSendDisposition({
  hasConnected: wsStatus.hasConnected,
  uiState: getWsConnectionUiState(wsStatus),
});
if (disposition === "queue") {
  enqueueCommand(turnStartCommand, messageIdForSend);
  markMessageQueued(messageIdForSend); // see Step 4
  turnStartSucceeded = true; // keep the optimistic bubble; do NOT revert
} else {
  await api.orchestration.dispatchCommand(turnStartCommand);
  turnStartSucceeded = true;
}
```

- [ ] **Step 3: On a transport error, queue instead of reverting (no double-text)**

In the existing `.catch` (lines 3347-3379), add an early branch BEFORE the revert block: if the error is a transport error, enqueue and keep the bubble — skip the draft-restore entirely.

```ts
    })().catch(async (err: unknown) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (!turnStartSucceeded && shouldQueueOnError(errorMessage)) {
        enqueueCommand(turnStartCommand, messageIdForSend);
        markMessageQueued(messageIdForSend);
        return; // keep the optimistic bubble; do NOT revert or restore the draft
      }
      // …existing revert + setThreadError block unchanged…
    });
```

- [ ] **Step 4: Track queued message ids for the badge**

The queued badge is driven by the outbox store (single source of truth), not a second React state. Define near the other ChatView render helpers a small `markMessageQueued` that is a no-op alias for readability (the enqueue already records the messageId): `const markMessageQueued = (_id: MessageId) => {};` — OR, simpler, delete the `markMessageQueued(...)` calls from Steps 2-3 and instead derive queued state in render via `useCommandOutbox`. In the message renderer for optimistic user messages, subscribe with `const queuedMessageIds = useCommandOutbox((s) => s.queue.map((q) => q.messageId));` and pass `isQueued={queuedMessageIds.includes(message.id)}` to the user-message bubble; when true, render a muted badge "Queued · sends when reconnected" near the message footer. (Reconciliation at `ChatView.tsx:2761-2787` already removes the optimistic bubble once the server echoes it; also remove it from the outbox there — see Step 5.)

- [ ] **Step 5: Dequeue on server echo**

In the reconcile effect (lines 2761-2787), when an optimistic message is removed because the server now has its id, also remove any matching outbox entry so a delivered turn can't be re-flushed. After computing `removedMessages`, add: `for (const m of removedMessages) { useCommandOutbox.setState((s) => ({ queue: s.queue.filter((q) => q.messageId !== m.id) })); }`. (Belt-and-suspenders with the server's `commandId` dedupe.)

- [ ] **Step 6: Create the flush coordinator**

Create `apps/web/src/components/OutboxFlushCoordinator.tsx`:

```tsx
import { useEffect, useRef } from "react";
import { flushOutbox, getQueuedCommands } from "../rpc/commandOutbox";
import { getWsConnectionUiState, useWsConnectionStatus } from "../rpc/wsConnectionState";
import { getPrimaryEnvironmentConnection } from "../environments/runtime";
import { toastManager } from "./ui/toast";

export function OutboxFlushCoordinator() {
  const status = useWsConnectionStatus();
  const uiState = getWsConnectionUiState(status);
  const flushingRef = useRef(false);

  useEffect(() => {
    if (uiState !== "connected") return;
    if (getQueuedCommands().length === 0) return; // no-op when empty (safe in tests)
    if (flushingRef.current) return;
    flushingRef.current = true;
    void flushOutbox(
      (command) =>
        getPrimaryEnvironmentConnection().api.orchestration.dispatchCommand(command as never),
      {
        onTerminalError: (queued) => {
          toastManager.add({
            type: "error",
            title: "Queued message failed",
            description: "A message queued while offline could not be sent and was dropped.",
            data: { dismissAfterVisibleMs: 8_000, hideCopyButton: true },
          });
          void queued;
        },
      },
    ).finally(() => {
      flushingRef.current = false;
    });
  }, [uiState, status.connectedAt]);

  return null;
}
```

(Verify the exact accessor for `dispatchCommand` against `getPrimaryEnvironmentConnection()` in `apps/web/src/environments/runtime`; if the API is reached differently — e.g. `readEnvironmentApi(environmentId)` as in `ChatView.tsx:3388` — use that same accessor. Match the existing call convention.)

- [ ] **Step 7: Mount the coordinator**

In `apps/web/src/routes/__root.tsx`, next to line 147-148, add under the same `primaryEnvironmentAuthenticated` guard: `{primaryEnvironmentAuthenticated ? <OutboxFlushCoordinator /> : null}` (import it at the top).

- [ ] **Step 8: Probe the existing browser send tests still dispatch (not queue)**

Run the existing ChatView browser send tests, which rely on `dispatchCommand` being called:
Run: `pnpm --filter @t3tools/web test run --project browser src/components/ChatView.browser`
Expected: PASS. (The disposition gate requires `hasConnected && uiState !== "connected"` to queue; in these tests the msw ws harness opens the socket so the status is `connected` — or `hasConnected` is false pre-connect — both → dispatch. If any send test now mis-queues, set the ws status to connected in that test's setup via `recordWsConnectionOpened()` from `wsConnectionState`, or confirm the harness drives it.)

- [ ] **Step 9: Typecheck + commit**

Run: `pnpm --filter @t3tools/web typecheck`
Expected: no errors.

```bash
git add apps/web/src/components/ChatView.tsx apps/web/src/components/OutboxFlushCoordinator.tsx apps/web/src/routes/__root.tsx
git commit -m "feat(web): queue user messages while offline and flush them on reconnect"
```

---

## Self-Review notes

- **Spec coverage:** 1A grace → Task 2; 1B indicator → Task 3; 1C outbox → Tasks 4-5; prong 2 infinite retry → Task 1. All four design items mapped.
- **Type consistency:** `decideSendDisposition`/`shouldQueueOnError` (Task 4) consumed in Task 5; `enqueueCommand(command, messageId)` signature consistent across Tasks 4-5; `connectionDotTone` (Task 3) matches its test.
- **Known integration risk (Task 5):** the exact `dispatchCommand` accessor and the optimistic-message renderer wiring must be matched against live code by the implementer — Steps 6/4 call this out. The two-stage review in Stage 8 covers it.
- **Verify gate (Stage 9):** `pnpm verify` = typecheck + lint + test + test:browser. A fresh worktree already has the global Playwright chromium cache + `mockServiceWorker.js`; no Electron/`path.txt` setup needed (desktop smoke is not in `verify`).
