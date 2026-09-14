import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { resolveTurnStartInstanceId } from "./ws.ts";

const requested = ProviderInstanceId.make("requested");
const session = ProviderInstanceId.make("session");
const thread = ProviderInstanceId.make("thread");

const shell = { session: { providerInstanceId: session }, modelSelection: { instanceId: thread } };

describe("resolveTurnStartInstanceId", () => {
  it("prefers an explicitly requested instance", () => {
    expect(resolveTurnStartInstanceId({ requested, bootstrapInstanceId: undefined, shell })).toBe(
      requested,
    );
  });

  it("falls back to the live session's instance, not the thread default", () => {
    // Design P15: with a live session and no requested selection the reactor KEEPS the
    // session, so the turn runs on the session's instance while `desiredInstanceId`
    // holds the thread's. Gating on the thread default checks the wrong account.
    expect(
      resolveTurnStartInstanceId({ requested: undefined, bootstrapInstanceId: undefined, shell }),
    ).toBe(session);
  });

  it("falls back to the thread default when no session is live", () => {
    expect(
      resolveTurnStartInstanceId({
        requested: undefined,
        bootstrapInstanceId: undefined,
        shell: { session: null, modelSelection: { instanceId: thread } },
      }),
    ).toBe(thread);
  });

  it("uses the bootstrap selection when the thread does not exist yet", () => {
    // I10: a bootstrap turn is refused BEFORE thread.create, so there is no shell to read.
    expect(
      resolveTurnStartInstanceId({
        requested: undefined,
        bootstrapInstanceId: thread,
        shell: undefined,
      }),
    ).toBe(thread);
  });

  it("resolves to nothing when there is no instance to name", () => {
    expect(
      resolveTurnStartInstanceId({
        requested: undefined,
        bootstrapInstanceId: undefined,
        shell: undefined,
      }),
    ).toBeUndefined();
  });
});
