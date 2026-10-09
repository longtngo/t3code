import { RegistryContext } from "@effect/atom-react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  type AuthSessionState,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

/** `useEnvironmentScopeDenied` over a stubbed session source; the denial rule is the real one. */

const fixture = vi.hoisted(() => ({ session: null as unknown }));

vi.mock("@t3tools/client-runtime/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: () => fixture.session }),
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));

import { useEnvironmentScopeDenied } from "./session";
import { renderDom } from "../testing/renderDom";

const env = EnvironmentId.make("env-session");

function Probe() {
  const denied = useEnvironmentScopeDenied(env, AuthOrchestrationOperateScope);
  return createElement("output", null, denied ? "denied" : "not denied");
}

const render = () =>
  renderDom(
    createElement(RegistryContext.Provider, { value: AtomRegistry.make() }, createElement(Probe)),
  );

const session = (permissions: AuthSessionState["permissions"]) =>
  ({
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
    },
    scopes: permissions ?? [],
    permissions,
  }) as AuthSessionState;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

describe("useEnvironmentScopeDenied", () => {
  it("is not a denial while the grant is loading", async () => {
    fixture.session = Atom.make(AsyncResult.initial<AuthSessionState>());
    expect((await render()).text()).toBe("not denied");
  });

  it("is a denial when the current grant lacks the scope", async () => {
    fixture.session = Atom.make(AsyncResult.success(session([])));
    expect((await render()).text()).toBe("denied");
  });

  it("is not a denial when the grant holds the scope", async () => {
    fixture.session = Atom.make(AsyncResult.success(session([AuthOrchestrationOperateScope])));
    expect((await render()).text()).toBe("not denied");
  });
});
