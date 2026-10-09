import {
  AuthFilesystemReadScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ThreadId,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, expect, it, vi } from "vite-plus/test";

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

import { useAssetUrlRefresh, useAssetUrlState } from "./assetUrls";

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

it.each(["workspace-file", "media-file"] as const)(
  "keeps %s loading until its file grant resolves",
  (_tag) => {
    expect(useAssetUrlState(environmentId, { ...resource, _tag })).toEqual({ _tag: "Loading" });
    expect(state.assetQuery).not.toHaveBeenCalled();

    state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
    expect(useAssetUrlState(environmentId, { ...resource, _tag })).toEqual({
      _tag: "Success",
      expiresAt: 1,
      url: "https://host.test/api/assets/image.png",
    });
  },
);

it("hides host assets with a denied grant while preserving attachments", () => {
  state.session = { authenticated: true, scopes: [] };
  expect(useAssetUrlState(environmentId, resource)).toEqual({ _tag: "Failure" });
  expect(state.assetQuery).not.toHaveBeenCalled();
  expect(useAssetUrlState(environmentId, { _tag: "attachment", attachmentId: "upload" })).toEqual({
    _tag: "Success",
    expiresAt: 1,
    url: "https://host.test/api/assets/image.png",
  });
});

it("stops waiting for an unresolved grant when the connection is offline", () => {
  state.phase = "offline";
  expect(useAssetUrlState(environmentId, resource)).toEqual({ _tag: "Failure" });
  expect(state.assetQuery).not.toHaveBeenCalled();
});

it("lets the server authorize an explicit refresh before the client grant loads", async () => {
  await expect(useAssetUrlRefresh(environmentId, resource)()).resolves.toBe(
    "https://host.test/api/assets/image.png",
  );
  expect(state.mint).toHaveBeenCalledWith({ environmentId, input: { resource } });

  const denied = new EnvironmentAuthorizationError({
    message: "This connection cannot read host files.",
    requiredScope: AuthFilesystemReadScope,
  });
  state.mint.mockResolvedValue(AsyncResult.failure(Cause.fail(denied)));
  await expect(useAssetUrlRefresh(environmentId, resource)()).rejects.toBe(denied);
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
  expect(useAssetUrlState(environmentId, hostResource)).toEqual({ _tag: "Failure" });
  expect(state.assetQuery).not.toHaveBeenCalled();
  await expect(useAssetUrlRefresh(environmentId, hostResource)()).rejects.toThrow(
    "This connection cannot read host files.",
  );
  expect(state.mint).not.toHaveBeenCalled();
});
