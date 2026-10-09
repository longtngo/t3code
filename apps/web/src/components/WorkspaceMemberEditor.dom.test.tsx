import {
  AuthFilesystemReadScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  sessionAtom: null as unknown,
  browse: [] as unknown[],
  // While set, the browse never answers.
  browsePending: false,
  // While set, the browse fails with it.
  browseError: null as Error | null,
  // While set, the folder is listed empty.
  browseEmpty: false,
}));

// The session atom and the browse RPC are stubbed; the access hook and the editor are real.
vi.mock("../state/session", async (importOriginal) => {
  const { useAtomValue } = await import("@effect/atom-react");
  const { sessionResultDeniesScope, sessionResultGrantsScope } =
    await import("@t3tools/client-runtime/state/sessionScope");
  return {
    ...(await importOriginal<typeof import("../state/session")>()),
    environmentSession: { sessionStateAtom: () => fixture.sessionAtom },
    useEnvironmentScope: (_id: unknown, scope: never) =>
      sessionResultGrantsScope(useAtomValue(fixture.sessionAtom as never), scope),
    useEnvironmentScopeDenied: (_id: unknown, scope: never) =>
      sessionResultDeniesScope(useAtomValue(fixture.sessionAtom as never), scope),
  };
});
vi.mock("../state/presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: "connected", error: null } },
  }),
}));
vi.mock("../state/filesystem", async (importOriginal) => {
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  return {
    ...(await importOriginal<typeof import("../state/filesystem")>()),
    filesystemEnvironment: {
      browse: (input: unknown) => {
        fixture.browse.push(input);
        if (fixture.browsePending) return A.make(R.initial(true));
        if (fixture.browseError) return A.make(R.failure(Cause.fail(fixture.browseError)));
        return A.make(
          R.success({
            parentPath: "/Users/dev/",
            entries: fixture.browseEmpty ? [] : [{ name: "api", fullPath: "/Users/dev/api" }],
          }),
        );
      },
    },
  };
});

import { renderDom } from "../testing/renderDom";
import WorkspaceMemberEditor from "./WorkspaceMemberEditor";

function session(permissions: readonly string[]) {
  return Atom.make(
    AsyncResult.success({
      authenticated: true,
      scopes: [],
      permissions,
    } as unknown as AuthSessionState),
  );
}

async function typePath(value: string) {
  const dom = await renderDom(
    <WorkspaceMemberEditor
      environmentId={EnvironmentId.make("local")}
      members={[]}
      editing={null}
      onSubmit={async () => true}
      onCancel={() => {}}
    />,
  );
  const input = dom.find<HTMLInputElement>('input[placeholder="~/src/uni/prm_portal_api"]');
  if (!input) throw new Error("path field not found");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    input.focus();
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // The suggestion list opens on ArrowDown, as it would from the keyboard.
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  return document.body.textContent ?? "";
}

beforeEach(() => {
  fixture.browse = [];
  fixture.browsePending = false;
  fixture.browseError = null;
  fixture.browseEmpty = false;
});

describe("WorkspaceMemberEditor repository path", () => {
  it("lists folders when the connection can read host files", async () => {
    fixture.sessionAtom = session(["orchestration:read", AuthFilesystemReadScope]);
    const text = await typePath("/Users/dev/");
    expect(fixture.browse.length).toBeGreaterThan(0);
    expect(text).toContain("api");
  });

  it("explains the missing permission instead of browsing under a legacy grant", async () => {
    fixture.sessionAtom = session(["orchestration:read", "orchestration:operate"]);
    const text = await typePath("/Users/dev/");
    expect(fixture.browse).toHaveLength(0);
    expect(text).toContain("This connection cannot browse host folders.");
  });

  it("browses while the grant is still loading, and says it is reading", async () => {
    fixture.sessionAtom = Atom.make(AsyncResult.initial(true));
    fixture.browsePending = true;
    // The root, so no "Go up" row hides the empty state.
    const text = await typePath("/");
    expect(fixture.browse.length).toBeGreaterThan(0);
    expect(text).toContain("Reading folder…");
  });

  it("browses after a failed session refresh, without showing its error", async () => {
    fixture.sessionAtom = Atom.make(AsyncResult.failure(Cause.fail(new Error("500"))));
    const text = await typePath("/Users/dev/");
    expect(fixture.browse.length).toBeGreaterThan(0);
    expect(text).toContain("api");
    expect(text).not.toContain("500");
  });

  it.each([
    [
      "refused",
      new EnvironmentAuthorizationError({
        message: "The authenticated token is missing required scope: filesystem:read.",
        requiredScope: AuthFilesystemReadScope,
      }),
    ],
    ["failed", new Error("EIO: i/o error, scandir '/'")],
  ])("says a %s browse could not list the folder, without its error text", async (_c, error) => {
    // A grant still loading, so the browse runs and the server answers.
    fixture.sessionAtom = Atom.make(AsyncResult.initial(true));
    fixture.browseError = error;
    // The root, so no "Go up" row hides the empty state.
    const text = await typePath("/");
    expect(fixture.browse.length).toBeGreaterThan(0);
    expect(text).toContain("Could not list this folder.");
    expect(text).not.toContain(error.message);
    expect(text).not.toContain("No folders here.");
  });

  it("says a folder listed without subfolders has none", async () => {
    fixture.sessionAtom = session(["orchestration:read", AuthFilesystemReadScope]);
    fixture.browseEmpty = true;
    // The root, so no "Go up" row hides the empty state.
    const text = await typePath("/");
    expect(fixture.browse.length).toBeGreaterThan(0);
    expect(text).toContain("No folders here.");
    expect(text).not.toContain("Could not list this folder.");
  });
});
