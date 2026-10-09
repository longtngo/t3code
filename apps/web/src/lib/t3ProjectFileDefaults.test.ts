import { AuthFilesystemReadScope, EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  // null while the grant is still loading.
  permissions: null as string[] | null,
  reads: [] as unknown[],
}));

// The session grant and the file read are stubbed; the decision to read and the decode are real.
vi.mock("~/state/session", async () => {
  const { sessionResultDeniesScope } = await import("@t3tools/client-runtime/state/sessionScope");
  const { AsyncResult: R } = await import("effect/reactivity");
  const grant = () =>
    fixture.permissions === null
      ? R.initial<AuthSessionState>(true)
      : R.success({
          authenticated: true,
          scopes: [],
          permissions: fixture.permissions,
        } as unknown as AuthSessionState);
  return {
    readEnvironmentScopeDenied: (_id: unknown, scope: never) =>
      sessionResultDeniesScope(grant(), scope),
  };
});
vi.mock("~/components/files/projectFilesQueryState", () => ({
  getProjectFileQueryAtom: (...args: unknown[]) => {
    fixture.reads.push(args);
    const contents = JSON.stringify({ defaultThreadEnvMode: "worktree" });
    return Atom.make(
      AsyncResult.success({
        relativePath: "t3.json",
        contents,
        byteLength: contents.length,
        truncated: false,
      }),
    );
  },
  resolveProjectFileQueryData: (_e: unknown, _c: unknown, _p: unknown, data: unknown) => data,
}));

import { readT3ProjectFile } from "./t3ProjectFileDefaults";

const environmentId = EnvironmentId.make("env-1");

beforeEach(() => {
  fixture.reads = [];
});

describe("readT3ProjectFile", () => {
  it("reads the project file when the login can read host files", async () => {
    fixture.permissions = ["orchestration:read", AuthFilesystemReadScope];
    const file = await readT3ProjectFile(environmentId, "/repo");
    expect(fixture.reads.length).toBeGreaterThan(0);
    expect(file).not.toBeNull();
  });

  it("sends no read and falls back to no file under a legacy grant", async () => {
    fixture.permissions = ["orchestration:read", "orchestration:operate"];
    const file = await readT3ProjectFile(environmentId, "/repo");
    expect(fixture.reads).toHaveLength(0);
    expect(file).toBeNull();
  });

  it("reads the project file while the grant is still loading, leaving the answer to the server", async () => {
    fixture.permissions = null;
    const file = await readT3ProjectFile(environmentId, "/repo");
    expect(fixture.reads.length).toBeGreaterThan(0);
    expect(file).not.toBeNull();
  });
});
