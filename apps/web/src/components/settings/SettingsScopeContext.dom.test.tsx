import {
  AuthFilesystemReadScope,
  DEFAULT_SERVER_SETTINGS,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";

const grant = (permissions: readonly string[]) =>
  AsyncResult.success({
    authenticated: true,
    scopes: [],
    permissions,
  } as unknown as AuthSessionState);

// One checkout per grant state. Every t3.json that is read says `worktree`.
const sessions = new Map<string, Atom.Atom<AsyncResult.AsyncResult<AuthSessionState, unknown>>>([
  ["granted", Atom.make(grant(["orchestration:read", AuthFilesystemReadScope]))],
  // Paired before the permission split: no `filesystem:read`.
  ["legacy", Atom.make(grant(["orchestration:read", "orchestration:operate"]))],
  ["loading", Atom.make(AsyncResult.initial<AuthSessionState>(true))],
  // A refresh the server answered with an error says nothing about this scope.
  [
    "flaky",
    Atom.make(AsyncResult.failure<AuthSessionState, unknown>(Cause.fail(new Error("500")))),
  ],
]);
const environmentIds = [...sessions.keys()];

const checkouts = environmentIds.map((environmentId) => ({
  id: `proj-${environmentId}`,
  environmentId,
  physicalProjectKey: `${environmentId}:proj-${environmentId}`,
  environmentLabel: environmentId,
  title: "web",
  members: [],
  scripts: [],
  workspaceRoot: `/srv/${environmentId}/web`,
}));
const group = {
  ...checkouts[0],
  projectKey: "group-1",
  displayName: "web",
  groupedProjectCount: checkouts.length,
  memberProjects: checkouts,
  memberProjectRefs: checkouts.map(({ environmentId, id }) => ({ environmentId, projectId: id })),
  remoteEnvironmentLabels: [],
  allRemoteMembersAreDesktopLocal: false,
};

vi.mock("../../sidebarProjectGrouping", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sidebarProjectGrouping")>()),
  buildSidebarProjectSnapshots: () => [group],
}));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  useEnvironments: () => ({
    environments: environmentIds.map((environmentId) => ({
      environmentId,
      label: environmentId,
      connection: { phase: "connected" },
      serverConfig: { settings: DEFAULT_SERVER_SETTINGS },
    })),
  }),
  usePrimaryEnvironmentId: () => "granted",
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  environmentSession: { sessionStateAtom: (id: string) => sessions.get(id) },
}));
vi.mock("../files/projectFilesQueryState", async (importOriginal) => {
  const contents = JSON.stringify({ defaultThreadEnvMode: "worktree" });
  return {
    ...(await importOriginal<typeof import("../files/projectFilesQueryState")>()),
    getProjectFileQueryAtom: () =>
      Atom.make(
        AsyncResult.success({
          relativePath: "t3.json",
          contents,
          byteLength: contents.length,
          truncated: false,
        }),
      ),
  };
});

describe("SettingsScopeProvider member project files", () => {
  it("settles a denied checkout as having no t3.json and reads every other one", async () => {
    const { SettingsScopeProvider, useSettingsScope } = await import("./SettingsScopeContext");
    const seen = new Map<string, { value: unknown; source: unknown }>();
    function Probe() {
      const { targets } = useSettingsScope();
      useEffect(() => {
        for (const target of targets) {
          seen.set(target.environmentId, {
            value: target.settings.defaultThreadEnvMode,
            source: target.sources.defaultThreadEnvMode,
          });
        }
      });
      return null;
    }
    await renderDom(
      <SettingsScopeProvider search={{ project: "group-1" }} onChange={() => {}}>
        <Probe />
      </SettingsScopeProvider>,
    );

    const fromFile = { value: "worktree", source: "t3.json" };
    expect(Object.fromEntries(seen)).toEqual({
      granted: fromFile,
      loading: fromFile,
      flaky: fromFile,
      // No file: the built-in default, as a refused read used to produce.
      legacy: { value: "local", source: "environment" },
    });
  });
});
