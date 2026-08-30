// @effect-diagnostics nodeBuiltinImport:off -- reads a sibling source file as text
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  isStalePendingApprovalDetail,
  isStalePendingUserInputDetail,
  isStaleRequestDetail,
  STALE_PENDING_USER_INPUT_DETAILS,
} from "./staleRequestDetail.ts";

/**
 * These strings are how orchestration learns a pending request is gone. The
 * decider, the projector and the command reactor each used to carry their own
 * copy, and they had drifted: only the reactor knew Codex's approval phrasing,
 * so a stale Codex approval left a thread with a blocking request it could
 * never clear and could not be settled.
 */
const codexApproval =
  "Provider adapter request failed (codex) for item/tool/requestApproval: " +
  "Unknown pending Codex approval request: approval-1";
const codexUserInput =
  "Provider adapter request failed (codex) for item/tool/requestUserInput: " +
  "Unknown pending Codex user input request: user-input-1";

describe("isStalePendingApprovalDetail", () => {
  it("recognises the generic phrasings", () => {
    expect(isStalePendingApprovalDetail("Stale pending approval request: a")).toBe(true);
    expect(isStalePendingApprovalDetail("Unknown pending approval request: a")).toBe(true);
    expect(isStalePendingApprovalDetail("Unknown pending permission request: a")).toBe(true);
  });

  it("recognises the Codex phrasing, which names the provider", () => {
    // The regression this module exists for.
    expect(isStalePendingApprovalDetail(codexApproval)).toBe(true);
  });

  it("does not fire on an ordinary approval failure", () => {
    // The control: a real failure must keep the request open, or a provider
    // hiccup would silently discard an approval the user still owes an answer to.
    expect(isStalePendingApprovalDetail("Provider approval response failed: timeout")).toBe(false);
    expect(isStalePendingApprovalDetail(null)).toBe(false);
  });
});

describe("isStalePendingUserInputDetail", () => {
  it("recognises every spelling, hyphenated or not", () => {
    expect(isStalePendingUserInputDetail("Stale pending user-input request: a")).toBe(true);
    expect(isStalePendingUserInputDetail("Unknown pending user-input request: a")).toBe(true);
    expect(isStalePendingUserInputDetail("Unknown pending user input request: a")).toBe(true);
    expect(isStalePendingUserInputDetail(codexUserInput)).toBe(true);
  });

  it("does not treat an approval detail as user input", () => {
    expect(isStalePendingUserInputDetail(codexApproval)).toBe(false);
  });
});

describe("isStaleRequestDetail", () => {
  it("covers both kinds for callers that cannot tell them apart", () => {
    // The decider gets a bare payload and does not know which request failed.
    expect(isStaleRequestDetail(codexApproval)).toBe(true);
    expect(isStaleRequestDetail(codexUserInput)).toBe(true);
    expect(isStaleRequestDetail("something else entirely")).toBe(false);
  });
});

describe("ProjectionSnapshotQuery LIKE clauses", () => {
  // The pinning query cannot import this list: it is a tagged template and its
  // clause count is fixed at authoring time. So the patterns are duplicated
  // there as SQL literals, and this asserts the copy is complete.
  const querySource = NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "Layers", "ProjectionSnapshotQuery.ts"),
    "utf8",
  );
  const missingFrom = (patterns: readonly string[]) =>
    patterns.filter((pattern) => !querySource.includes(`LIKE '%${pattern}%'`));

  it("pins an activity for every stale user-input phrasing", () => {
    expect(missingFrom(STALE_PENDING_USER_INPUT_DETAILS)).toEqual([]);
  });

  it("would notice a phrasing the query does not cover", () => {
    // Liveness: without this, the assertion above passes on an empty file.
    expect(missingFrom(["unknown pending nowhere request"])).toEqual([
      "unknown pending nowhere request",
    ]);
  });
});
