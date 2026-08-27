import { describe, expect, it } from "vite-plus/test";

import { appendRecalledPrompt } from "@t3tools/client-runtime/state/held-messages";
import { partitionHeldMessages } from "./heldMessages.logic";

const message = (id: string, role = "user") => ({ id, role, text: id });

describe("partitionHeldMessages", () => {
  it("returns the original array by reference when nothing is held", () => {
    const messages = [message("a"), message("b")];
    const partition = partitionHeldMessages(messages, new Set());
    expect(partition.transcript).toBe(messages);
    expect(partition.held).toEqual([]);
  });

  it("moves a held message out of the transcript and into the strip", () => {
    const messages = [message("a"), message("b"), message("c")];
    const partition = partitionHeldMessages(messages, new Set(["b"]));
    expect(partition.transcript.map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(partition.held.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("keeps held messages in send order, so two sent during one turn read correctly", () => {
    const messages = [message("a"), message("b"), message("c")];
    const partition = partitionHeldMessages(messages, new Set(["c", "b"]));
    expect(partition.held.map((entry) => entry.id)).toEqual(["b", "c"]);
    expect(partition.transcript.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("never routes an assistant message to the strip", () => {
    // Routing one there would hide the agent's reply rather than a queued send.
    const messages = [message("a"), message("b", "assistant")];
    const partition = partitionHeldMessages(messages, new Set(["b"]));
    expect(partition.transcript.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(partition.held).toEqual([]);
  });

  it("returns the original array when the held ids match nothing present", () => {
    // The held set is derived from server messages; the merged timeline can
    // legitimately not contain one yet.
    const messages = [message("a")];
    const partition = partitionHeldMessages(messages, new Set(["zzz"]));
    expect(partition.transcript).toBe(messages);
    expect(partition.held).toEqual([]);
  });
});

describe("appendRecalledPrompt", () => {
  it("appends to a draft the user typed after sending", () => {
    // The composer clears its draft before the send RPC, so this is the common
    // case: overwriting here would silently eat the newer text.
    expect(appendRecalledPrompt("newer thought", "held message")).toBe(
      "newer thought\n\nheld message",
    );
  });

  it("does not lead an empty draft with blank lines", () => {
    expect(appendRecalledPrompt("", "held message")).toBe("held message");
    expect(appendRecalledPrompt("   \n ", "held message")).toBe("held message");
  });

  it("collapses trailing whitespace to exactly one blank line", () => {
    expect(appendRecalledPrompt("newer thought  \n\n\n", "held message")).toBe(
      "newer thought\n\nheld message",
    );
  });

  it("leaves the draft untouched when the recalled message has no text", () => {
    // An attachment-only message must not append blank lines to real work.
    const draft = "newer thought";
    expect(appendRecalledPrompt(draft, "")).toBe(draft);
  });
});
