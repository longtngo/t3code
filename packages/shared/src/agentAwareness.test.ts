import { describe, expect, it } from "@effect/vitest";

import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";

import { projectThreadAwareness } from "./agentAwareness.ts";

const NOW = "2026-05-22T12:00:00.000Z";

const project = {
  title: "t3code",
} satisfies Pick<OrchestrationProjectShell, "title">;

function thread(
  overrides: Partial<OrchestrationThreadShell> = {},
): Pick<
  OrchestrationThreadShell,
  | "id"
  | "title"
  | "modelSelection"
  | "session"
  | "latestTurn"
  | "updatedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
> {
  return {
    id: "thread-1" as ThreadId,
    title: "Fix failing CI",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    session: null,
    latestTurn: null,
    updatedAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

describe("projectThreadAwareness", () => {
  it("returns null for idle threads without an active awareness state", () => {
    expect(
      projectThreadAwareness({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: thread(),
      }),
    ).toBeNull();
  });

  it("prioritizes approval requests over running state", () => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        hasPendingApprovals: true,
        session: {
          threadId: "thread-1" as ThreadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: "turn-1" as TurnId,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    });

    expect(state?.phase).toBe("waiting_for_approval");
    expect(state?.headline).toBe("Approval needed");
  });

  it("projects running provider sessions", () => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        session: {
          threadId: "thread-1" as ThreadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: "turn-1" as TurnId,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    });

    expect(state).toMatchObject({
      phase: "running",
      headline: "Agent is working",
      detail: "Codex is active.",
      modelTitle: "gpt-5.4",
      deepLink: "/threads/env-1/thread-1",
    });
  });

  // `session.providerName` carries the driver kind the server stores
  // (`claudeAgent`, `codex`), never a label - and this detail line is read on a
  // phone, so it has to be spelled the way a person would.
  it.each([
    ["claudeAgent", "Claude is active."],
    ["codex", "Codex is active."],
    ["cursor", "Cursor is active."],
    ["grok", "Grok is active."],
    ["opencode", "OpenCode is active."],
  ])("labels a running %s session with its display name", (providerName, expected) => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        session: {
          threadId: "thread-1" as ThreadId,
          status: "running",
          providerName,
          runtimeMode: "full-access",
          activeTurnId: "turn-1" as TurnId,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    });

    expect(state?.detail).toBe(expected);
  });

  // Driver kinds are an open set and the field itself is only a non-empty
  // string, so two kinds of name arrive without a display name: a valid
  // third-party slug, and a value that is not a slug at all. Both keep what
  // they came with rather than dropping the detail line.
  it.each([["acme-agent"], ["Legacy Agent 9"]])(
    "keeps %s as-is when it has no display name",
    (providerName) => {
      const state = projectThreadAwareness({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: thread({
          session: {
            threadId: "thread-1" as ThreadId,
            status: "running",
            providerName,
            runtimeMode: "full-access",
            activeTurnId: "turn-1" as TurnId,
            lastError: null,
            updatedAt: NOW,
          },
        }),
      });

      expect(state?.detail).toBe(`${providerName} is active.`);
    },
  );

  it("projects completed turns as completed even when teardown settled them as interrupted", () => {
    const finishedTurn = {
      turnId: "turn-1" as TurnId,
      state: "interrupted" as const,
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: null,
    };
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({ latestTurn: finishedTurn }),
    });

    // Session teardown settles still-running turns by session status, and
    // that write can race turn.completed; the completion timestamp is the
    // durable signal. Without this the thread resolves to null persistently
    // and gets tombstoned off the lock-screen card instead of showing Done.
    expect(state?.phase).toBe("completed");

    const trulyInterrupted = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({ latestTurn: { ...finishedTurn, completedAt: null } }),
    });
    expect(trulyInterrupted).toBeNull();
  });

  it("projects ready sessions with no materialized turn as completed", () => {
    // Quick threads without code changes never get a checkpoint, so the SQL
    // shell has no latestTurn row and latest_turn_id is cleared when the
    // session settles; the ready session is the only completion signal left.
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        session: {
          threadId: "thread-1" as ThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      }),
    });

    expect(state?.phase).toBe("completed");
  });

  it("projects failures with the session error detail", () => {
    const state = projectThreadAwareness({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: thread({
        session: {
          threadId: "thread-1" as ThreadId,
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "Provider process exited.",
          updatedAt: NOW,
        },
      }),
    });

    expect(state).toMatchObject({
      phase: "failed",
      headline: "Agent failed",
      detail: "Provider process exited.",
    });
  });
});
