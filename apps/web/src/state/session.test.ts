import { AuthFilesystemReadScope, EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const store = vi.hoisted(() => ({ registry: null as object | null }));

// The app's store module, pointed at a registry this test builds once the real session atoms
// exist. Importing them inside the mock factory would deadlock on this very module.
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: new Proxy(
    {},
    {
      get: (_target, key) => {
        const registry = store.registry as Record<PropertyKey, unknown>;
        const value = registry[key];
        return typeof value === "function" ? value.bind(registry) : value;
      },
    },
  ),
}));

import { environmentSession, readEnvironmentScopeDenied } from "./session";

const LEGACY = EnvironmentId.make("legacy");
const GRANTED = EnvironmentId.make("granted");
const LOADING = EnvironmentId.make("loading");

const session = (permissions: readonly string[]) =>
  AsyncResult.success({
    authenticated: true,
    scopes: [],
    permissions,
  } as unknown as AuthSessionState);

describe("readEnvironmentScopeDenied", () => {
  it("denies only a loaded grant that lacks the scope", () => {
    // Two answered sessions. The third environment has no connection, so its real session
    // atom never settles: a grant still loading.
    store.registry = AtomRegistry.make({
      initialValues: [
        // Paired before the permission split: no `filesystem:read`.
        [
          environmentSession.sessionStateAtom(LEGACY),
          session(["orchestration:read", "orchestration:operate"]),
        ],
        [
          environmentSession.sessionStateAtom(GRANTED),
          session(["orchestration:read", AuthFilesystemReadScope]),
        ],
      ],
    });

    expect(readEnvironmentScopeDenied(LOADING, AuthFilesystemReadScope)).toBe(false);
    expect(readEnvironmentScopeDenied(LEGACY, AuthFilesystemReadScope)).toBe(true);
    expect(readEnvironmentScopeDenied(GRANTED, AuthFilesystemReadScope)).toBe(false);
  });
});
