import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type {
  EnvironmentId,
  NotificationCategorySettings,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

import {
  __resetThreadNotificationStateForTest,
  classifyThreadCompletion,
  notifyThreadCompletions,
  registerThreadNotificationHost,
} from "./notifier";

const ALL_ON: NotificationCategorySettings = {
  finished: true,
  finishedBackground: true,
  needsInput: true,
  failed: true,
};

const ENV = "env-1" as EnvironmentId;
const tid = (value: string): ThreadId => value as ThreadId;

describe("classifyThreadCompletion", () => {
  it("fires on running -> completed", () => {
    expect(
      classifyThreadCompletion({
        threadId: tid("t1"),
        previousState: "running",
        nextTurnId: "turn-1",
        nextState: "completed",
        title: "My task",
      }),
    ).toEqual({ threadId: "t1", turnId: "turn-1", title: "My task", outcome: "completed" });
  });

  it("fires on running -> error", () => {
    expect(
      classifyThreadCompletion({
        threadId: tid("t1"),
        previousState: "running",
        nextTurnId: "turn-1",
        nextState: "error",
        title: "My task",
      })?.outcome,
    ).toBe("error");
  });

  it("fires on running -> interrupted", () => {
    expect(
      classifyThreadCompletion({
        threadId: tid("t1"),
        previousState: "running",
        nextTurnId: "turn-1",
        nextState: "interrupted",
        title: "My task",
      })?.outcome,
    ).toBe("interrupted");
  });

  it("returns null when the previous state was not running (hydration of a finished thread)", () => {
    expect(
      classifyThreadCompletion({
        threadId: tid("t1"),
        previousState: null,
        nextTurnId: "turn-1",
        nextState: "completed",
        title: "My task",
      }),
    ).toBeNull();
  });

  it("returns null while still running", () => {
    expect(
      classifyThreadCompletion({
        threadId: tid("t1"),
        previousState: "running",
        nextTurnId: "turn-1",
        nextState: "running",
        title: "My task",
      }),
    ).toBeNull();
  });

  it("returns null when there is no terminal turn id", () => {
    expect(
      classifyThreadCompletion({
        threadId: tid("t1"),
        previousState: "running",
        nextTurnId: null,
        nextState: "completed",
        title: "My task",
      }),
    ).toBeNull();
  });
});

describe("notifyThreadCompletions", () => {
  let created: Array<{ title: string; options: unknown }>;

  beforeEach(() => {
    __resetThreadNotificationStateForTest();
    created = [];

    class FakeNotification {
      static permission = "granted";
      constructor(
        readonly title: string,
        readonly options: unknown,
      ) {
        created.push({ title, options });
      }
      addEventListener(): void {}
      close(): void {}
    }

    (globalThis as { Notification?: unknown }).Notification = FakeNotification;
    (globalThis as { document?: unknown }).document = {
      visibilityState: "hidden",
      hasFocus: () => false,
    };
  });

  afterEach(() => {
    __resetThreadNotificationStateForTest();
    delete (globalThis as { Notification?: unknown }).Notification;
    delete (globalThis as { document?: unknown }).document;
  });

  const completion = {
    threadId: tid("t1"),
    turnId: "turn-1",
    title: "My task",
    outcome: "completed" as const,
    backgroundActive: false,
  };

  it("does nothing when the setting is disabled", () => {
    notifyThreadCompletions({
      environmentId: ENV,
      completions: [completion],
      enabled: false,
      categories: ALL_ON,
    });
    expect(created).toHaveLength(0);
  });

  it("raises a browser notification when enabled and not viewing the thread", () => {
    notifyThreadCompletions({
      environmentId: ENV,
      completions: [completion],
      enabled: true,
      categories: ALL_ON,
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.title).toBe("My task");
  });

  it("dedups the same thread+turn across batches", () => {
    notifyThreadCompletions({
      environmentId: ENV,
      completions: [completion],
      enabled: true,
      categories: ALL_ON,
    });
    notifyThreadCompletions({
      environmentId: ENV,
      completions: [completion],
      enabled: true,
      categories: ALL_ON,
    });
    expect(created).toHaveLength(1);
  });

  it("suppresses (and remembers) the thread the user is actively viewing", () => {
    (globalThis as { document?: unknown }).document = {
      visibilityState: "visible",
      hasFocus: () => true,
    };
    const unregister = registerThreadNotificationHost({
      navigateToThread: () => {},
      getActiveThreadRef: () => ({ environmentId: ENV, threadId: tid("t1") }) as ScopedThreadRef,
    });

    notifyThreadCompletions({
      environmentId: ENV,
      completions: [completion],
      enabled: true,
      categories: ALL_ON,
    });
    expect(created).toHaveLength(0);

    // Even after the window loses focus it must not re-fire for the same turn.
    (globalThis as { document?: unknown }).document = {
      visibilityState: "hidden",
      hasFocus: () => false,
    };
    notifyThreadCompletions({
      environmentId: ENV,
      completions: [completion],
      enabled: true,
      categories: ALL_ON,
    });
    expect(created).toHaveLength(0);
    unregister();
  });

  it("still fires when the user is viewing a different thread", () => {
    (globalThis as { document?: unknown }).document = {
      visibilityState: "visible",
      hasFocus: () => true,
    };
    const unregister = registerThreadNotificationHost({
      navigateToThread: () => {},
      getActiveThreadRef: () => ({ environmentId: ENV, threadId: tid("other") }) as ScopedThreadRef,
    });

    notifyThreadCompletions({
      environmentId: ENV,
      completions: [completion],
      enabled: true,
      categories: ALL_ON,
    });
    expect(created).toHaveLength(1);
    unregister();
  });

  it("gates a completed turn on `finished`", () => {
    notifyThreadCompletions({
      environmentId: ENV,
      completions: [{ ...completion, outcome: "completed" as const }],
      enabled: true,
      categories: { ...ALL_ON, finished: false },
    });
    expect(created).toHaveLength(0);
  });

  it("gates an interrupted turn on `finished` too, not a category of its own", () => {
    notifyThreadCompletions({
      environmentId: ENV,
      completions: [{ ...completion, outcome: "interrupted" as const }],
      enabled: true,
      categories: { ...ALL_ON, finished: false },
    });
    expect(created).toHaveLength(0);
  });

  it("gates an errored turn on `failed`, and keeps it when only `finished` is off", () => {
    notifyThreadCompletions({
      environmentId: ENV,
      completions: [{ ...completion, turnId: "a", outcome: "error" as const }],
      enabled: true,
      categories: { ...ALL_ON, finished: false },
    });
    expect(created).toHaveLength(1);

    notifyThreadCompletions({
      environmentId: ENV,
      completions: [{ ...completion, turnId: "b", outcome: "error" as const }],
      enabled: true,
      categories: { ...ALL_ON, failed: false },
    });
    expect(created).toHaveLength(1);
  });

  it("keeps a failure in its own category even while background work runs", () => {
    // Mirrors the server-side guarantee. Without this the client could
    // reclassify an error as an interim finish and swallow it behind the
    // noisy switch -- a mutant that did exactly that passed the suite.
    notifyThreadCompletions({
      environmentId: ENV,
      completions: [
        { ...completion, turnId: "err-bg", outcome: "error" as const, backgroundActive: true },
      ],
      enabled: true,
      categories: { ...ALL_ON, finishedBackground: false },
    });
    expect(created).toHaveLength(1);
  });

  it("routes a finish to `finishedBackground` only while other work is still running", () => {
    // Background work alive => interim finish, silenced by finishedBackground.
    notifyThreadCompletions({
      environmentId: ENV,
      completions: [
        { ...completion, turnId: "a", outcome: "completed" as const, backgroundActive: true },
      ],
      enabled: true,
      categories: { ...ALL_ON, finishedBackground: false },
    });
    expect(created).toHaveLength(0);

    // Nothing left running => the real completion, which must survive.
    notifyThreadCompletions({
      environmentId: ENV,
      completions: [
        { ...completion, turnId: "b", outcome: "completed" as const, backgroundActive: false },
      ],
      enabled: true,
      categories: { ...ALL_ON, finishedBackground: false },
    });
    expect(created).toHaveLength(1);
  });

  it("still records a category-suppressed completion so a later flip cannot replay it", () => {
    notifyThreadCompletions({
      environmentId: ENV,
      completions: [completion],
      enabled: true,
      categories: { ...ALL_ON, finished: false },
    });
    expect(created).toHaveLength(0);

    // Same thread+turn, category now on: this already happened, so it must not fire.
    notifyThreadCompletions({
      environmentId: ENV,
      completions: [completion],
      enabled: true,
      categories: ALL_ON,
    });
    expect(created).toHaveLength(0);
  });
});
