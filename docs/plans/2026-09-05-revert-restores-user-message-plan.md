# Revert restores the user message — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` to
> implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reverting to one of your own messages discards that message from the thread and puts its
text back in the composer.

**Architecture:** One retention predicate — a turnless message survives a revert only if it predates
the newest checkpoint the revert kept — applied in the client reducer (where the user sees the
thread) and in the durable projection (what a cold load serves). On the web client, the timeline row
hands the revert handler the text it already renders; a ref holds it until the message actually
disappears from the thread, then the existing send-failure draft-restore path writes it into the
composer.

**Tech Stack:** TypeScript, Effect/Schema, React, Vitest.

**Spec:** `docs/design/2026-09-05-revert-restores-user-message-design.md`

## Global Constraints

- Run web tests from `apps/web`, not the repo root. Server tests from `apps/server`.
- `vp` is not on PATH; use `./node_modules/.bin/vp` from the repo root or `../../node_modules/.bin/vp`
  from a package directory.
- Do **not** modify `apps/server/src/orchestration/projector.ts`. The design explains why; changing
  it alters `thread.settle` / `thread.snooze` behavior.
- Do **not** add rules to the assistant fallback in either retention function. Its candidate pool is
  empty on all live data.
- Inferred types over annotations. No `any`.
- Do not commit `pnpm-lock.yaml`; it was already dirty before this branch.

---

### Task 1: Bound turnless messages in the client reducer

This is the primary fix. Today the reverted message survives 100% of reverts on the live client.

**Files:**

- Modify: `packages/client-runtime/src/state/threadReducer.ts:564-611` and `:766-781`
- Test: `packages/client-runtime/src/state/threadReducer.test.ts:1218`

**Interfaces:**

- Produces: `retainMessagesAfterRevert(messages, retainedTurnIds, keptCheckpointCompletedAt)` —
  third parameter is `string | null`.

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe("thread.reverted", …)` block in
`packages/client-runtime/src/state/threadReducer.test.ts`. The existing
`"filters entities to retained turns"` test must keep passing unchanged — its `msg-1` predates the
kept checkpoint.

```ts
it("discards the user message that started the reverted turn", () => {
  const threadWithData: OrchestrationThread = {
    ...baseThread,
    messages: [
      {
        id: MessageId.make("msg-1"),
        role: "user",
        text: "First",
        turnId: null,
        streaming: false,
        createdAt: "2026-04-01T01:00:00.000Z",
        updatedAt: "2026-04-01T01:00:00.000Z",
      },
      {
        id: MessageId.make("msg-2"),
        role: "assistant",
        text: "Response 1",
        turnId: TurnId.make("turn-1"),
        streaming: false,
        createdAt: "2026-04-01T02:00:00.000Z",
        updatedAt: "2026-04-01T02:00:00.000Z",
      },
      {
        id: MessageId.make("msg-3"),
        role: "user",
        text: "Second",
        turnId: null,
        streaming: false,
        createdAt: "2026-04-01T02:30:00.000Z",
        updatedAt: "2026-04-01T02:30:00.000Z",
      },
    ],
    checkpoints: [
      {
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("ref-1"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.make("msg-2"),
        completedAt: "2026-04-01T02:00:00.000Z",
      },
      {
        turnId: TurnId.make("turn-2"),
        checkpointTurnCount: 2,
        checkpointRef: CheckpointRef.make("ref-2"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-04-01T03:00:00.000Z",
      },
    ],
  };

  const result = applyThreadDetailEvent(threadWithData, {
    ...baseEventFields,
    sequence: 14,
    occurredAt: "2026-04-01T04:00:00.000Z",
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    type: "thread.reverted",
    payload: { threadId: ThreadId.make("thread-1"), turnCount: 1 },
  });

  expect(result.kind).toBe("updated");
  if (result.kind === "updated") {
    expect(result.thread.messages.map((message) => message.id)).toEqual(["msg-1", "msg-2"]);
  }
});

it("discards a turnless message created on the kept checkpoint's own timestamp", () => {
  // A checkpoint is captured lazily, when the next turn starts, so the next turn's user
  // message and the previous checkpoint routinely share a timestamp.
  const threadWithData: OrchestrationThread = {
    ...baseThread,
    messages: [
      {
        id: MessageId.make("msg-1"),
        role: "user",
        text: "First",
        turnId: null,
        streaming: false,
        createdAt: "2026-04-01T01:00:00.000Z",
        updatedAt: "2026-04-01T01:00:00.000Z",
      },
      {
        id: MessageId.make("msg-2"),
        role: "user",
        text: "Second",
        turnId: null,
        streaming: false,
        createdAt: "2026-04-01T02:00:00.000Z",
        updatedAt: "2026-04-01T02:00:00.000Z",
      },
    ],
    checkpoints: [
      {
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("ref-1"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-04-01T02:00:00.000Z",
      },
    ],
  };

  const result = applyThreadDetailEvent(threadWithData, {
    ...baseEventFields,
    sequence: 15,
    occurredAt: "2026-04-01T04:00:00.000Z",
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    type: "thread.reverted",
    payload: { threadId: ThreadId.make("thread-1"), turnCount: 1 },
  });

  expect(result.kind).toBe("updated");
  if (result.kind === "updated") {
    expect(result.thread.messages.map((message) => message.id)).toEqual(["msg-1"]);
  }
});

it("keeps system messages and drops every turnless message when reverting to turn 0", () => {
  const threadWithData: OrchestrationThread = {
    ...baseThread,
    messages: [
      {
        id: MessageId.make("sys-1"),
        role: "system",
        text: "Session started",
        turnId: null,
        streaming: false,
        createdAt: "2026-04-01T00:30:00.000Z",
        updatedAt: "2026-04-01T00:30:00.000Z",
      },
      {
        id: MessageId.make("msg-1"),
        role: "user",
        text: "First",
        turnId: null,
        streaming: false,
        createdAt: "2026-04-01T01:00:00.000Z",
        updatedAt: "2026-04-01T01:00:00.000Z",
      },
    ],
    checkpoints: [
      {
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("ref-1"),
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-04-01T02:00:00.000Z",
      },
    ],
  };

  const result = applyThreadDetailEvent(threadWithData, {
    ...baseEventFields,
    sequence: 16,
    occurredAt: "2026-04-01T04:00:00.000Z",
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    type: "thread.reverted",
    payload: { threadId: ThreadId.make("thread-1"), turnCount: 0 },
  });

  expect(result.kind).toBe("updated");
  if (result.kind === "updated") {
    expect(result.thread.messages.map((message) => message.id)).toEqual(["sys-1"]);
  }
});
```

- [ ] **Step 2: Run the tests and watch them fail**

From the repo root:

```bash
./node_modules/.bin/vp test run packages/client-runtime/src/state/threadReducer.test.ts
```

Expected: the three new tests FAIL (each keeps a message it should drop); every other test passes.
If a new test passes before the implementation, it is not testing anything — fix it before going on.

- [ ] **Step 3: Implement the bound**

Replace `retainMessagesAfterRevert` at `threadReducer.ts:766`:

```ts
function retainMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  keptCheckpointCompletedAt: string | null,
): OrchestrationMessage[] {
  // A user message is persisted before its turn exists and the link is never backfilled, so
  // `turnId` is null for all of them and a turn match cannot decide their fate. The revert point
  // decides it instead: a turnless message survives only if it predates the newest checkpoint the
  // revert kept. The comparison includes equality because a checkpoint is captured lazily, when
  // the next turn starts, so the next turn's message and this checkpoint often share a timestamp.
  return Arr.filter(messages, (message) => {
    if (message.role === "system") {
      return true;
    }
    if (message.turnId === null) {
      return keptCheckpointCompletedAt !== null && message.createdAt < keptCheckpointCompletedAt;
    }
    return retainedTurnIds.has(message.turnId);
  });
}
```

Then at the call site (`threadReducer.ts:576`), pass the kept checkpoint's timestamp. `checkpoints`
is already filtered to the revert target and sorted by `checkpointOrder`:

```ts
const retainedTurnIds = new Set(Arr.map(checkpoints, (entry) => entry.turnId));
const messages = retainMessagesAfterRevert(
  thread.messages,
  retainedTurnIds,
  checkpoints.at(-1)?.completedAt ?? null,
);
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
./node_modules/.bin/vp test run packages/client-runtime/src/state/threadReducer.test.ts packages/client-runtime/src/state/threads-pagination.test.ts
```

Expected: PASS, including the pre-existing `"filters entities to retained turns"` and the
pagination test that also emits `thread.reverted`.

- [ ] **Step 5: Commit**

```bash
git add packages/client-runtime/src/state/threadReducer.ts packages/client-runtime/src/state/threadReducer.test.ts
git commit -m "fix(client-runtime): drop the reverted user message from the thread"
```

---

### Task 2: Bound the durable projection's fallback pool

Same predicate, so a cold load agrees with the live client.

**Files:**

- Modify: `apps/server/src/orchestration/Layers/ProjectionPipeline.ts:219-301`
- Test: `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces: no exported signature change; `retainProjectionMessagesAfterRevert` keeps its
  `(messages, turns, turnCount)` signature and derives the cutoff from `turns`.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts`. Follow the file's existing
revert test for how it builds rows and asserts; the shape below reproduces the live defect in
miniature — a kept turn with no `pendingMessageId` manufactures the phantom deficit that re-admits
the discarded message.

```ts
it("does not re-admit the user message of a discarded turn", async () => {
  // Two kept turns, one of which was auto-started and has no pending message, so
  // `missingUserCount` is 1 while the only candidate is the message being reverted away.
  // Build the thread with turns 1 and 2 checkpointed, turn 3 discarded, then apply
  // `thread.reverted` with turnCount 2 and assert the turn-3 user message is gone while the
  // turn-1 user message survives.
});
```

Write it concretely against the file's existing helpers — read the neighbouring revert test first
and mirror its construction rather than inventing a new harness.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/server && ../../node_modules/.bin/vp test run src/orchestration/Layers/ProjectionPipeline.test.ts
```

Expected: FAIL — the discarded user message is retained.

- [ ] **Step 3: Implement the bound**

In `retainProjectionMessagesAfterRevert`, after `keptTurns` is computed, derive the cutoff, and add
one clause to the **user** fallback filter only. Leave the assistant fallback untouched.

```ts
// The revert point. A turnless message survives only if it predates the newest checkpoint the
// revert kept; `>=` because a checkpoint is captured lazily, when the next turn starts, so the
// next turn's message and this checkpoint often share a timestamp.
let keptCheckpointCompletedAt: string | null = null;
for (const turn of keptTurns) {
  if (
    turn.completedAt !== null &&
    (keptCheckpointCompletedAt === null || turn.completedAt > keptCheckpointCompletedAt)
  ) {
    keptCheckpointCompletedAt = turn.completedAt;
  }
}
```

and inside the `missingUserCount > 0` block's `.filter(...)` predicate, add:

```ts
          (keptCheckpointCompletedAt === null ||
            message.createdAt < keptCheckpointCompletedAt) &&
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
cd apps/server && ../../node_modules/.bin/vp test run src/orchestration/Layers/ProjectionPipeline.test.ts src/orchestration/projector.test.ts
```

Expected: PASS. `projector.test.ts` must be untouched and green — this task does not modify
`projector.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/orchestration/Layers/ProjectionPipeline.ts apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts
git commit -m "fix(server): stop the revert fallback re-admitting discarded user messages"
```

---

### Task 3: Hand the revert handler the text it needs

**Files:**

- Modify: `apps/web/src/components/chat/MessagesTimeline.tsx:212`, `:322`, `:1437`, `:1448-1471`
- Test: `apps/web/src/components/chat/MessagesTimeline.test.tsx`

**Interfaces:**

- Produces: `onRevertUserMessage: (messageId: MessageId, promptText: string, attachmentCount: number) => void`
  — consumed by Task 4.

- [ ] **Step 1: Widen the prop type in both declarations**

At `:212` and `:322`, replace:

```ts
  onRevertUserMessage: (messageId: MessageId) => void;
```

with:

```ts
  /** `promptText` is the text as rendered, so the composer gets back what the user sees. */
  onRevertUserMessage: (
    messageId: MessageId,
    promptText: string,
    attachmentCount: number,
  ) => void;
```

- [ ] **Step 2: Pass the row's already-computed values into the button**

`UserTimelineRow` computes `elementContextState.promptText` at `:1263` and has
`row.message.attachments` in scope. At `:1437`:

```tsx
{
  canRevertAgentWork && (
    <RevertUserMessageButton
      messageId={row.message.id}
      promptText={elementContextState.promptText}
      attachmentCount={row.message.attachments?.length ?? 0}
    />
  );
}
```

and widen the component:

```tsx
function RevertUserMessageButton({
  messageId,
  promptText,
  attachmentCount,
}: {
  messageId: MessageId;
  promptText: string;
  attachmentCount: number;
}) {
```

with the click handler becoming:

```tsx
            onClick={() => ctx.onRevertUserMessage(messageId, promptText, attachmentCount)}
```

- [ ] **Step 3: Update the test mock and add a test**

Find the `onRevertUserMessage` mock in `MessagesTimeline.test.tsx` (around `:184`) and widen it.
Add a test that clicking the revert control passes the rendered text and the attachment count —
assert on the arguments the handler receives, not on markup.

- [ ] **Step 4: Run the tests**

```bash
cd apps/web && ../../node_modules/.bin/vp test run src/components/chat/MessagesTimeline.test.tsx --project unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/MessagesTimeline.tsx apps/web/src/components/chat/MessagesTimeline.test.tsx
git commit -m "refactor(web): pass the reverted message's text to the revert handler"
```

---

### Task 4: Restore the text when the message leaves the thread

**Files:**

- Modify: `apps/web/src/components/ChatView.logic.ts` (add the decision function)
- Modify: `apps/web/src/components/ChatView.tsx:8109` (the handler), plus a new ref and effect
- Test: `apps/web/src/components/ChatView.logic.test.ts`

**Interfaces:**

- Consumes: `onRevertUserMessage(messageId, promptText, attachmentCount)` from Task 3.
- Produces: `PendingRevertRestore`, `resolvePendingRevertRestore(input)` returning
  `"idle" | "wait" | "restore" | "discard"`.

- [ ] **Step 1: Write the failing test for the decision function**

Add to `apps/web/src/components/ChatView.logic.test.ts`:

```ts
describe("resolvePendingRevertRestore", () => {
  const pending = {
    messageId: MessageId.make("msg-1"),
    text: "take this back",
    attachmentCount: 0,
    threadKey: "thread-1",
    targetTurnCount: 1,
    requestedAt: "2026-09-05T10:00:00.000Z",
  };

  it("waits while the message is still in the thread", () => {
    expect(
      resolvePendingRevertRestore({
        pending,
        activeThreadKey: "thread-1",
        hasMessage: true,
        maxCheckpointTurnCount: 2,
        latestRevertFailureAt: null,
      }),
    ).toBe("wait");
  });

  it("waits when the message is gone but a discarded checkpoint remains", () => {
    // A re-window or a reconnect empties the message list without a revert landing.
    expect(
      resolvePendingRevertRestore({
        pending,
        activeThreadKey: "thread-1",
        hasMessage: false,
        maxCheckpointTurnCount: 2,
        latestRevertFailureAt: null,
      }),
    ).toBe("wait");
  });

  it("restores once the message is gone and the checkpoints match the target", () => {
    expect(
      resolvePendingRevertRestore({
        pending,
        activeThreadKey: "thread-1",
        hasMessage: false,
        maxCheckpointTurnCount: 1,
        latestRevertFailureAt: null,
      }),
    ).toBe("restore");
  });

  it("restores when reverting to turn 0 empties the thread", () => {
    expect(
      resolvePendingRevertRestore({
        pending: { ...pending, targetTurnCount: 0 },
        activeThreadKey: "thread-1",
        hasMessage: false,
        maxCheckpointTurnCount: null,
        latestRevertFailureAt: null,
      }),
    ).toBe("restore");
  });

  it("discards on a thread switch", () => {
    expect(
      resolvePendingRevertRestore({
        pending,
        activeThreadKey: "thread-2",
        hasMessage: false,
        maxCheckpointTurnCount: 1,
        latestRevertFailureAt: null,
      }),
    ).toBe("discard");
  });

  it("discards when the revert failed after it was requested", () => {
    expect(
      resolvePendingRevertRestore({
        pending,
        activeThreadKey: "thread-1",
        hasMessage: true,
        maxCheckpointTurnCount: 2,
        latestRevertFailureAt: "2026-09-05T10:00:01.000Z",
      }),
    ).toBe("discard");
  });

  it("ignores a failure that predates the request", () => {
    expect(
      resolvePendingRevertRestore({
        pending,
        activeThreadKey: "thread-1",
        hasMessage: true,
        maxCheckpointTurnCount: 2,
        latestRevertFailureAt: "2026-09-05T09:59:59.000Z",
      }),
    ).toBe("wait");
  });

  it("is idle with nothing pending", () => {
    expect(
      resolvePendingRevertRestore({
        pending: null,
        activeThreadKey: "thread-1",
        hasMessage: false,
        maxCheckpointTurnCount: null,
        latestRevertFailureAt: null,
      }),
    ).toBe("idle");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && ../../node_modules/.bin/vp test run src/components/ChatView.logic.test.ts --project unit
```

Expected: FAIL — `resolvePendingRevertRestore` is not exported.

- [ ] **Step 3: Implement the decision function**

Add to `apps/web/src/components/ChatView.logic.ts`:

```ts
export type PendingRevertRestore = {
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachmentCount: number;
  readonly threadKey: string;
  readonly targetTurnCount: number;
  readonly requestedAt: string;
};

/**
 * Decides what to do with a revert whose text is waiting to go back in the composer.
 *
 * The message leaving the thread is the signal that the revert landed, but absence alone is not
 * enough: a re-window, a reconnect, a cold subscribe or a withdraw can all empty the message list
 * without a revert. The checkpoint check is what separates them — only a landed revert removes the
 * checkpoints newer than the target.
 */
export function resolvePendingRevertRestore(input: {
  pending: PendingRevertRestore | null;
  activeThreadKey: string | null;
  hasMessage: boolean;
  maxCheckpointTurnCount: number | null;
  latestRevertFailureAt: string | null;
}): "idle" | "wait" | "restore" | "discard" {
  const { pending } = input;
  if (pending === null) return "idle";
  if (input.activeThreadKey !== pending.threadKey) return "discard";
  if (input.latestRevertFailureAt !== null && input.latestRevertFailureAt >= pending.requestedAt) {
    return "discard";
  }
  if (input.hasMessage) return "wait";
  if (
    input.maxCheckpointTurnCount !== null &&
    input.maxCheckpointTurnCount > pending.targetTurnCount
  ) {
    return "wait";
  }
  return "restore";
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd apps/web && ../../node_modules/.bin/vp test run src/components/ChatView.logic.test.ts --project unit
```

Expected: PASS.

- [ ] **Step 5: Commit the pure part**

```bash
git add apps/web/src/components/ChatView.logic.ts apps/web/src/components/ChatView.logic.test.ts
git commit -m "feat(web): decide when a reverted message's text goes back to the composer"
```

- [ ] **Step 6: Wire it in ChatView**

Import `appendRecalledPrompt` alongside the other client-runtime state imports:

```ts
import { appendRecalledPrompt } from "@t3tools/client-runtime/state/held-messages";
```

Add the ref beside the existing revert refs at `ChatView.tsx:8105`, and record the entry in the
handler. Keep the `useCallback` dependency array empty — it is a `TimelineRowCtx` dependency and a
fresh reference remounts every rendered markdown node.

```ts
const pendingRevertRestoreRef = useRef<PendingRevertRestore | null>(null);
const activeThreadKeyRef = useRef(activeThreadKey);
activeThreadKeyRef.current = activeThreadKey;
const onRevertUserMessage = useCallback(
  (messageId: MessageId, promptText: string, attachmentCount: number) => {
    const targetTurnCount = revertTurnCountRef.current.get(messageId);
    if (typeof targetTurnCount !== "number") {
      return;
    }
    const threadKey = activeThreadKeyRef.current;
    pendingRevertRestoreRef.current =
      threadKey === null
        ? null
        : {
            messageId,
            text: promptText,
            attachmentCount,
            threadKey,
            targetTurnCount,
            requestedAt: new Date().toISOString(),
          };
    void onRevertToTurnCountRef.current(targetTurnCount);
  },
  [],
);
```

Then the effect. Place it after `timelineMessages` and the composer draft helpers are in scope:

```ts
// The text goes back only once the message has actually left the thread — 36% of revert
// requests are accepted and then fail silently, and restoring on acceptance would leave the
// text in the composer with the message still above it.
useEffect(() => {
  const pending = pendingRevertRestoreRef.current;
  if (pending === null) return;
  const decision = resolvePendingRevertRestore({
    pending,
    activeThreadKey,
    hasMessage: timelineMessages.some((message) => message.id === pending.messageId),
    maxCheckpointTurnCount:
      activeThread?.checkpoints.reduce<number | null>(
        (max, checkpoint) =>
          max === null || checkpoint.checkpointTurnCount > max
            ? checkpoint.checkpointTurnCount
            : max,
        null,
      ) ?? null,
    latestRevertFailureAt:
      activeThread?.activities.reduce<string | null>(
        (latest, activity) =>
          activity.kind === "checkpoint.revert.failed" &&
          (latest === null || activity.createdAt > latest)
            ? activity.createdAt
            : latest,
        null,
      ) ?? null,
  });
  if (decision === "wait" || decision === "idle") return;
  pendingRevertRestoreRef.current = null;
  if (decision === "discard") return;

  const nextPrompt = appendRecalledPrompt(promptRef.current, pending.text);
  if (nextPrompt !== promptRef.current) {
    promptRef.current = nextPrompt;
    setComposerDraftPrompt(composerDraftTarget, nextPrompt);
    composerRef.current?.resetCursorState({
      cursor: collapseExpandedComposerCursor(nextPrompt, nextPrompt.length),
      prompt: nextPrompt,
      detectTrigger: true,
    });
  }
  if (pending.attachmentCount > 0) {
    toastManager.add({
      type: "warning",
      title: `Attachment${pending.attachmentCount === 1 ? "" : "s"} not restored`,
      description: `The text came back, but ${
        pending.attachmentCount === 1 ? "the file" : `all ${String(pending.attachmentCount)} files`
      } will need attaching again.`,
      data: { hideCopyButton: true },
    });
  }
}, [
  activeThread?.activities,
  activeThread?.checkpoints,
  activeThreadKey,
  composerDraftTarget,
  composerRef,
  promptRef,
  setComposerDraftPrompt,
  timelineMessages,
]);
```

- [ ] **Step 7: Typecheck and run the web suite**

```bash
cd apps/web && ../../node_modules/.bin/vp test run --project unit
cd /Users/longngo/src/playground/t3code && ./node_modules/.bin/vp run --filter @t3tools/web typecheck
```

Expected: PASS, 0 type errors. If `activeThreadKey` is not the identifier in scope, use whatever
ChatView already calls the active thread's stable key — do not introduce a second notion of it.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/ChatView.tsx
git commit -m "feat(web): put a reverted message back in the composer"
```

---

### Task 5: Document it

**Files:**

- Modify: `docs/user/composer.md`

- [ ] **Step 1: Read the file and match its voice**

Shipped-product voice, no repo paths, no source references.

- [ ] **Step 2: Add a short section**

```markdown
## Taking a message back

Every message you send has an undo control. Reverting to a message rolls the thread and the working
tree back to just before you sent it, discards what the agent did in response, and puts your original
text back in the composer so you can change it and send again. Anything already typed in the composer
is kept — the recalled text is added below it.

Attachments are not restored. If the message had files, attach them again before sending.
```

- [ ] **Step 3: Commit**

```bash
git add docs/user/composer.md
git commit -m "docs(user): describe taking a message back"
```

---

## Self-review notes

- **Spec coverage:** client reducer (Task 1), durable projection (Task 2), text hand-off (Task 3),
  restore trigger and draft write (Task 4), docs (Task 5). The spec's deliberate omissions —
  `projector.ts`, the assistant fallback, attachment re-hydration — are called out in Global
  Constraints so no task quietly adds them.
- **Type consistency:** `onRevertUserMessage(messageId, promptText, attachmentCount)` is declared in
  Task 3 and consumed with the same argument order in Task 4. `PendingRevertRestore` and
  `resolvePendingRevertRestore` are defined once, in Task 4.
- **Known gap:** Task 2's test body is described rather than written out, because it must mirror the
  neighbouring revert test's row-construction helpers, which the implementer will read. That is the
  one place this plan asks for judgement.
