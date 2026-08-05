import { assert, describe, it } from "vite-plus/test";

import {
  describePrBaseSource,
  gateMemberAction,
  shouldWritePrBase,
} from "./gitMemberActions.logic";

describe("gateMemberAction", () => {
  it("allows a repository this thread already owns", () => {
    assert.deepEqual(
      gateMemberAction({ state: "owned-by-self", branch: "t3code/x-abc12345" }, "uniuni_api_prm"),
      { kind: "allowed" },
    );
  });

  it("allows a repository sitting on its integration branch", () => {
    assert.deepEqual(gateMemberAction({ state: "idle", branch: "pickup-v2" }, "uniuni_api_prm"), {
      kind: "allowed",
    });
  });

  // A branch the user pinned by hand is theirs to drive; the panel shows it and
  // acts on it, it just never cuts anything.
  it("allows a repository the user is driving", () => {
    assert.deepEqual(gateMemberAction({ state: "unmanaged", branch: "hotfix" }, "prm_portal_api"), {
      kind: "allowed",
    });
  });

  it("blocks a repository another thread is working in, naming the branch", () => {
    const gate = gateMemberAction(
      { state: "owned-by-other", branch: "t3code/other-abc12345" },
      "uniuni_api_prm",
    );
    assert.equal(gate.kind, "blocked");
    if (gate.kind === "blocked") {
      assert.include(gate.reason, "uniuni_api_prm");
      assert.include(gate.reason, "t3code/other-abc12345");
    }
  });

  it("passes through why a repository could not be read", () => {
    const gate = gateMemberAction(
      { state: "unavailable", branch: null, detail: "Not a readable git repository." },
      "prm_portal_api",
    );
    assert.deepEqual(gate, { kind: "blocked", reason: "Not a readable git repository." });
  });

  it("still says something when an unreadable repository gave no detail", () => {
    const gate = gateMemberAction({ state: "unavailable", branch: null }, "prm_portal_api");
    assert.equal(gate.kind, "blocked");
    if (gate.kind === "blocked") assert.include(gate.reason, "prm_portal_api");
  });
});

describe("describePrBaseSource", () => {
  it("distinguishes a record from an inference", () => {
    assert.notEqual(describePrBaseSource("configured"), describePrBaseSource("reflog"));
    assert.notEqual(describePrBaseSource("reflog"), describePrBaseSource("integration"));
  });
});

describe("shouldWritePrBase", () => {
  // An inferred base becomes sticky only once the user has seen it, which is
  // the whole reason the write is separate from the resolution.
  it("writes an inferred base the user confirmed", () => {
    assert.isTrue(
      shouldWritePrBase({ confirmedBase: "main", resolvedBase: "main", source: "reflog" }),
    );
    assert.isTrue(
      shouldWritePrBase({ confirmedBase: "main", resolvedBase: "main", source: "integration" }),
    );
  });

  it("writes an edited base over a recorded one", () => {
    assert.isTrue(
      shouldWritePrBase({ confirmedBase: "develop", resolvedBase: "main", source: "configured" }),
    );
  });

  it("skips rewriting a recorded base unchanged", () => {
    assert.isFalse(
      shouldWritePrBase({ confirmedBase: "main", resolvedBase: "main", source: "configured" }),
    );
  });

  it("never writes an empty base", () => {
    assert.isFalse(
      shouldWritePrBase({ confirmedBase: "   ", resolvedBase: "main", source: "reflog" }),
    );
  });
});
