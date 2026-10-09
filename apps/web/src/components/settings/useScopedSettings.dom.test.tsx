import { EnvironmentAuthorizationError, type AuthSessionState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";

type Grant = AsyncResult.AsyncResult<AuthSessionState, unknown>;

const fixture = vi.hoisted(() => ({
  writes: [] as Array<{ environmentId: string; label: string }>,
  grants: new Map<string, unknown>(),
  // How the server answers each environment; absent means success.
  replies: new Map<string, unknown>(),
  sent: [] as string[],
  toasts: [] as Array<{ title?: string; description?: string }>,
}));

vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ scope: { kind: "environment" }, environments: [] }),
  useOptionalSettingsScope: () => null,
}));
// The plan itself is covered by scopedSettings.test.ts; here it is the fixture's writes.
vi.mock("./scopedSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scopedSettings")>()),
  planScopedSettingsPatch: () => ({
    hasClientWrite: false,
    clientPatch: {},
    serverWrites: fixture.writes.map((write) => ({
      ...write,
      patch: { enableAssistantStreaming: true },
    })),
  }),
}));
// The real denial rule over each environment's grant.
vi.mock("../../state/session", async (importOriginal) => {
  const { sessionResultDeniesScope } = await import("@t3tools/client-runtime/state/sessionScope");
  return {
    ...(await importOriginal<typeof import("../../state/session")>()),
    readEnvironmentScopeDenied: (id: string, scope: never) =>
      sessionResultDeniesScope(fixture.grants.get(id) as Grant, scope),
    useEnvironmentsWithScope: () => new Set(),
  };
});
vi.mock("../../state/use-atom-command", async () => {
  const { AsyncResult: R } = await import("effect/reactivity");
  return {
    useAtomCommand: () => async (input: { environmentId: string }) => {
      fixture.sent.push(input.environmentId);
      const reply = fixture.replies.get(input.environmentId);
      return reply === undefined ? R.success(undefined) : reply;
    },
  };
});
vi.mock("../../hooks/useSettings", () => ({
  mergeEnvironmentSettings: (server: object, client: object) => ({ ...server, ...client }),
  persistClientSettingsPatch: () => undefined,
  useClientSettings: () => ({}),
}));
vi.mock("../ui/toast", () => ({
  toastManager: {
    add: (toast: { title?: string; description?: string }) => fixture.toasts.push(toast),
  },
}));

import { useUpdateScopedSettings } from "./useScopedSettings";

const granted = (permissions: readonly string[]): Grant =>
  AsyncResult.success({ authenticated: true, scopes: [], permissions } as never);
// Paired before the permission split: no `settings:write`.
const legacy = granted(["orchestration:read", "orchestration:operate"]);
const serverRefusal = AsyncResult.failure(
  Cause.fail(
    new EnvironmentAuthorizationError({
      message: "The authenticated token is missing required scope: settings:write.",
      requiredScope: "settings:write",
    }),
  ),
);

async function update() {
  let run: ReturnType<typeof useUpdateScopedSettings> | null = null;
  function Probe() {
    const next = useUpdateScopedSettings();
    useEffect(() => {
      run = next;
    });
    return null;
  }
  await renderDom(<Probe />);
  await act(async () => {
    run?.({ enableAssistantStreaming: true } as never);
  });
  expect(fixture.toasts).toHaveLength(1);
  return fixture.toasts[0]?.description;
}

const lastToastTitle = () => fixture.toasts.at(-1)?.title;

beforeEach(() => {
  fixture.grants.clear();
  fixture.replies.clear();
  fixture.sent = [];
  fixture.toasts = [];
});

describe("useUpdateScopedSettings", () => {
  it("tells the user a refused write lacks the settings permission, without sending it", async () => {
    fixture.writes = [{ environmentId: "local", label: "Local" }];
    fixture.grants.set("local", legacy);

    const description = await update();

    expect(fixture.sent).toEqual([]);
    expect(description).toBe(
      "The connection to Local does not have permission to change environment settings.",
    );
  });

  it("blames permission only for the environments refused for it", async () => {
    fixture.writes = [
      { environmentId: "legacy", label: "Legacy" },
      { environmentId: "loading", label: "Loading" },
      { environmentId: "flaky", label: "Flaky" },
    ];
    fixture.grants.set("legacy", legacy);
    fixture.grants.set("loading", AsyncResult.initial(true));
    fixture.grants.set("flaky", granted(["settings:write"]));
    // The loading grant is the server's to judge, and it refuses; the other just fails.
    fixture.replies.set("loading", serverRefusal);
    fixture.replies.set("flaky", AsyncResult.failure(Cause.fail(new Error("offline"))));

    const description = await update();

    expect(fixture.sent).toEqual(["loading", "flaky"]);
    expect(description).toBe(
      "Could not update Flaky. The connections to Legacy and Loading do not have permission to change environment settings.",
    );
  });

  it("says which environments saved when another was refused", async () => {
    fixture.writes = [
      { environmentId: "laptop", label: "Laptop" },
      { environmentId: "legacy", label: "Legacy" },
    ];
    fixture.grants.set("laptop", granted(["settings:write"]));
    fixture.grants.set("legacy", legacy);

    const description = await update();

    expect(fixture.sent).toEqual(["laptop"]);
    expect(lastToastTitle()).toBe("Setting saved on some environments");
    expect(description).toBe(
      "The connection to Legacy does not have permission to change environment settings. The other selected environments saved the change.",
    );
  });
});
