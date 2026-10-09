import { RegistryContext } from "@effect/atom-react";
import { RemoteEnvironmentAuthTimeoutError } from "@t3tools/client-runtime/rpc";
import { AuthFilesystemReadScope, EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({ sessionAtom: null as unknown }));

// The real hook reads the session atom through the connection runtime; here it reads the fixture.
vi.mock("./session", async (importOriginal) => {
  const { useAtomValue } = await import("@effect/atom-react");
  const { sessionResultGrantsScope } = await import("@t3tools/client-runtime/state/sessionScope");
  return {
    ...(await importOriginal<typeof import("./session")>()),
    environmentSession: { sessionStateAtom: () => fixture.sessionAtom },
    useEnvironmentScope: (id: unknown, scope: never) => {
      const granted = sessionResultGrantsScope(useAtomValue(fixture.sessionAtom as never), scope);
      return id === "env-1" && scope === ("filesystem:read" as never) && granted;
    },
  };
});
// The refresh failure is what the query hook reports as an error string.
vi.mock("./query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: "session refresh failed", isPending: false }),
}));
vi.mock("./presentation", () => ({
  useEnvironmentPresentation: () => ({ isReady: true, presentation: null }),
}));

import { renderDom } from "../testing/renderDom";
import { useFilesystemReadAccess } from "./filesystem";

const environmentId = EnvironmentId.make("env-1");
const grantedSession = {
  authenticated: true,
  scopes: [AuthFilesystemReadScope],
} as unknown as AuthSessionState;

const failedRefresh = (error: unknown) =>
  AsyncResult.failure<AuthSessionState, unknown>(Cause.fail(error), {
    previousSuccess: Option.some(AsyncResult.success(grantedSession)) as never,
  });

async function readAccess(error: unknown) {
  fixture.sessionAtom = Atom.make(failedRefresh(error));
  let seen = null as ReturnType<typeof useFilesystemReadAccess> | null;
  const registry = AtomRegistry.make();
  function Probe() {
    const access = useFilesystemReadAccess(environmentId);
    useEffect(() => {
      seen = access;
    });
    return null;
  }
  await renderDom(
    <RegistryContext.Provider value={registry}>
      <Probe />
    </RegistryContext.Provider>,
  );
  return seen;
}

describe("useFilesystemReadAccess", () => {
  it("keeps file access when the session refresh never reached the server", async () => {
    expect(
      await readAccess(new RemoteEnvironmentAuthTimeoutError("https://env.test", 6_000)),
    ).toEqual({ canReadFiles: true, isPending: false, error: null });
  });

  it("drops file access when the server rejected the refresh", async () => {
    expect((await readAccess(new Error("rejected")))?.canReadFiles).toBe(false);
  });
});
