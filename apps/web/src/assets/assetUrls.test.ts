import {
  AuthFilesystemReadScope,
  EnvironmentId,
  ThreadId,
  type AssetResource,
  type AuthSessionState,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes"> | null,
  phase: "connected" as "connected" | "offline",
  assetAtom: {},
  mint: vi.fn(),
  assetQuery: vi.fn(),
}));

vi.mock("react", () => ({ useCallback: <A>(callback: A) => callback }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === state.assetAtom
      ? AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 })
      : AsyncResult.initial(false),
}));
// The real denial rule over the fixture's grant: no session yet is a grant still loading.
vi.mock("~/state/session", async () => {
  const { sessionResultDeniesScope } = await import("@t3tools/client-runtime/state/sessionScope");
  return {
    usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "https://host.test" } }),
    readEnvironmentScopeDenied: (_id: unknown, scope: typeof AuthFilesystemReadScope) =>
      sessionResultDeniesScope(
        state.session === null
          ? AsyncResult.initial(true)
          : AsyncResult.success(state.session as AuthSessionState),
        scope,
      ),
  };
});
vi.mock("~/state/filesystem", async () => {
  const { resolveFilesystemReadAccess } = await import("@t3tools/client-runtime/state/filesystem");
  return {
    useFilesystemReadAccess: () =>
      resolveFilesystemReadAccess({
        isCatalogReady: true,
        connection: { phase: state.phase, error: null },
        session: state.session,
        sessionError: null,
      }),
  };
});
vi.mock("~/state/assets", () => ({
  assetEnvironment: { createUrl: state.assetQuery },
}));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.mint }));

import { makeRevisionedAssetUrlFamily, useAssetUrlRefresh, useAssetUrlState } from "./assetUrls";

const environmentId = EnvironmentId.make("asset-environment");
const threadId = ThreadId.make("asset-thread");
const resource = { _tag: "media-file", threadId, path: "/repo/image.png" } as const;

beforeEach(() => {
  state.session = null;
  state.phase = "connected";
  state.assetQuery.mockReset().mockReturnValue(state.assetAtom);
  state.mint
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }));
});

it("sends no refresh for a host asset a loaded grant denies, and still refreshes attachments", async () => {
  state.session = { authenticated: true, scopes: [] };
  await expect(useAssetUrlRefresh(environmentId, resource)()).rejects.toThrow(
    "This connection cannot read host files.",
  );
  expect(state.mint).not.toHaveBeenCalled();

  const attachment = { _tag: "attachment", attachmentId: "a-1" } as const;
  await expect(useAssetUrlRefresh(environmentId, attachment)()).resolves.toBe(
    "https://host.test/api/assets/image.png",
  );
  expect(state.mint).toHaveBeenCalledWith({ environmentId, input: { resource: attachment } });
});

// Every kind the server serves from host files is gated, so none is minted for a denied grant.
const hostFileResources = [
  { _tag: "workspace-file", threadId, path: "src/image.png" },
  { _tag: "media-file", threadId, path: "/repo/image.png" },
  { _tag: "draft-workspace-file", cwd: "/repo", path: "src/image.png" },
] as const;

it.each(hostFileResources)("gates a $_tag asset on a denied grant", async (hostResource) => {
  state.session = { authenticated: true, scopes: [] };
  expect(useAssetUrlState(environmentId, hostResource)).toEqual({
    _tag: "Failure",
    reason: "missing-file-access",
  });
  expect(state.assetQuery).not.toHaveBeenCalled();
  await expect(useAssetUrlRefresh(environmentId, hostResource)()).rejects.toThrow(
    "This connection cannot read host files.",
  );
  expect(state.mint).not.toHaveBeenCalled();
});

const revisionEnvironmentId = EnvironmentId.make("environment-1");
const revisionResource: AssetResource = {
  _tag: "workspace-file",
  threadId: ThreadId.make("thread-1"),
  path: "docs/diagram.png",
};

type MintResult = AsyncResult.AsyncResult<{ relativeUrl: string; expiresAt: number }>;

const minted = (n: number): MintResult =>
  AsyncResult.success({ relativeUrl: `/a/${n}`, expiresAt: 0 });

// A stand-in for the asset URL query: a refresh starts a mint (counted, shown as
// waiting) and `settle` completes the latest one.
function setup(initial: MintResult) {
  let mints = 0;
  // Node removal runs on the registry's scheduler; `unmount` flushes it so the
  // next mount of the same revision builds a fresh node.
  const scheduled: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      scheduled.push(task);
      return () => {};
    },
  });
  const server = Atom.make(initial).pipe(Atom.keepAlive);
  const query = Atom.readable(
    (get) => get(server),
    () => {
      mints += 1;
      registry.set(server, AsyncResult.waiting(registry.get(server)));
    },
  ).pipe(Atom.keepAlive);
  const revisioned = makeRevisionedAssetUrlFamily(() => query);
  const mount = (revision: string | null) => {
    const release = registry.mount(
      revisioned({
        environmentId: revisionEnvironmentId,
        input: { resource: revisionResource },
        revision,
      }),
    );
    return () => {
      release();
      for (const task of scheduled.splice(0)) task();
    };
  };
  const settle = () => registry.set(server, minted(mints + 1));
  return { mount, settle, mints: () => mints };
}

describe("makeRevisionedAssetUrlFamily", () => {
  it("re-mints a settled URL on first read and on each new revision, not on remount", () => {
    const { mount, settle, mints } = setup(minted(0));

    mount("mutation-1")();
    expect(mints()).toBe(1);
    settle();

    mount("mutation-1")();
    expect(mints()).toBe(1);

    mount("mutation-2")();
    expect(mints()).toBe(2);
  });

  it("re-mints when a revert returns to an earlier revision", () => {
    const { mount, settle, mints } = setup(minted(0));

    mount("mutation-a")();
    settle();
    mount("mutation-b")();
    settle();
    expect(mints()).toBe(2);

    const reverted = mount("mutation-a");
    expect(mints()).toBe(3);
    reverted();
  });

  it("shares a mint in flight on the first read", () => {
    const { mount, mints } = setup(AsyncResult.initial(true));

    mount("mutation-1")();
    expect(mints()).toBe(0);
  });

  it("re-mints after a mint that was in flight when the revision changed", () => {
    const { mount, settle, mints } = setup(minted(0));

    const before = mount("mutation-1");
    settle();
    const edited = mount("mutation-2");
    expect(mints()).toBe(2);
    before();

    const stillMinting = mount("mutation-3");
    edited();
    expect(mints()).toBe(2);

    settle();
    expect(mints()).toBe(3);
    settle();
    expect(mints()).toBe(3);
    stillMinting();
  });
});
