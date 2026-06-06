import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import {
  __resetThreadNotificationStateForTest,
  classifyThreadCompletion,
  notifyThreadCompletions,
  registerThreadNotificationHost,
} from "./notifier";

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
  };

  it("does nothing when the setting is disabled", () => {
    notifyThreadCompletions({ environmentId: ENV, completions: [completion], enabled: false });
    expect(created).toHaveLength(0);
  });

  it("raises a browser notification when enabled and not viewing the thread", () => {
    notifyThreadCompletions({ environmentId: ENV, completions: [completion], enabled: true });
    expect(created).toHaveLength(1);
    expect(created[0]?.title).toBe("My task");
  });

  it("dedups the same thread+turn across batches", () => {
    notifyThreadCompletions({ environmentId: ENV, completions: [completion], enabled: true });
    notifyThreadCompletions({ environmentId: ENV, completions: [completion], enabled: true });
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

    notifyThreadCompletions({ environmentId: ENV, completions: [completion], enabled: true });
    expect(created).toHaveLength(0);

    // Even after the window loses focus it must not re-fire for the same turn.
    (globalThis as { document?: unknown }).document = {
      visibilityState: "hidden",
      hasFocus: () => false,
    };
    notifyThreadCompletions({ environmentId: ENV, completions: [completion], enabled: true });
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

    notifyThreadCompletions({ environmentId: ENV, completions: [completion], enabled: true });
    expect(created).toHaveLength(1);
    unregister();
  });
});
