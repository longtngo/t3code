import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  clearOutbox,
  clearOutboxForTests,
  enqueueCommand,
  flushOutbox,
  getQueuedCommands,
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
  it("clearOutbox empties the queue", () => {
    enqueueCommand(turnStart("a"), "m-a" as never);
    enqueueCommand(turnStart("b"), "m-b" as never);
    expect(getQueuedCommands()).toHaveLength(2);
    clearOutbox();
    expect(getQueuedCommands()).toHaveLength(0);
  });

  it("flushes FIFO and dequeues on success", async () => {
    enqueueCommand(turnStart("a"), "m-a" as never);
    enqueueCommand(turnStart("b"), "m-b" as never);
    const sent: string[] = [];
    await flushOutbox(async (c) => { sent.push(c.commandId); });
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
      async (c) => { if (c.commandId === "a") throw new Error("Thread not found"); },
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

  it("ignores a double-enqueue of the same commandId", () => {
    enqueueCommand(turnStart("a"), "m-a" as never);
    enqueueCommand(turnStart("a"), "m-a" as never);
    expect(getQueuedCommands()).toHaveLength(1);
  });
});
