import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/**
 * Recall for a message that is waiting for the running turn to finish.
 *
 * Answers `{ withdrawn }` rather than the message itself: the caller is the
 * strip that is already rendering the text, so returning a second copy over the
 * wire would only create a version to disagree with. `withdrawn: false` is a
 * normal answer - the provider won the race, or this adapter cannot queue - and
 * the message stays a message.
 */
export function createHeldMessageEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    withdraw: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:held-messages:withdraw",
      tag: WS_METHODS.threadWithdrawQueuedMessage,
    }),
  };
}

/**
 * How a recalled message rejoins whatever the user has already typed.
 *
 * Appending rather than replacing is the load-bearing part. The composer clears
 * its draft *before* the send RPC, so the user is free to type immediately and
 * a non-empty draft at recall time is the common case, not the edge; a blind
 * replace would silently discard that newer text. Recalling a message with no
 * text of its own leaves the draft exactly as it was, rather than appending
 * blank lines for an attachment-only message.
 */
export function appendRecalledPrompt(currentPrompt: string, recalled: string): string {
  if (recalled.length === 0) return currentPrompt;
  return currentPrompt.trim().length
    ? `${currentPrompt.replace(/\s+$/, "")}\n\n${recalled}`
    : recalled;
}
