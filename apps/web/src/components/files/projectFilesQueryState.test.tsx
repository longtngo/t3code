import {
  AuthFilesystemReadScope,
  EnvironmentId,
  type AuthSessionState,
  ProjectReadFileError,
  type ProjectReadFileResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const authorizationMocks = vi.hoisted(() => ({
  sessionAtom: null as Atom.Atom<
    AsyncResult.AsyncResult<Pick<AuthSessionState, "authenticated" | "scopes">, Error>
  > | null,
  phase: "connected" as "connected" | "offline",
}));

vi.mock("~/state/session", () => ({
  environmentSession: { sessionStateAtom: () => authorizationMocks.sessionAtom },
  useEnvironmentScope: () => false,
}));

vi.mock("~/state/presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: authorizationMocks.phase, error: null } },
  }),
}));

const projectMocks = vi.hoisted(() => ({
  listEntries: vi.fn(),
  optimisticFile: vi.fn(),
  readFile: vi.fn(),
  readTrustedFile: vi.fn(),
  renderTrustedMarkdown: vi.fn(),
}));

const filesystemMocks = vi.hoisted(() => ({ browse: vi.fn() }));

const atomHooks = vi.hoisted(() => ({
  registry: null as {
    get(atom: object): unknown;
    refresh(atom: object): void;
  } | null,
}));

const reactHooks = vi.hoisted(() => {
  let cursor = 0;
  let refs: Array<{ current: unknown }> = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      refs = [];
    },
    useCallback<A>(callback: A): A {
      nextIndex();
      return callback;
    },
    useEffect(effect: () => void): void {
      nextIndex();
      effect();
    },
    useRef<A>(initialValue: A): { current: A } {
      const index = nextIndex();
      refs[index] ??= { current: initialValue };
      return refs[index] as { current: A };
    },
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomRefresh: (atom: object) => () => {
    atomHooks.registry?.refresh(atom);
  },
  useAtomValue: (atom: object) => atomHooks.registry?.get(atom),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: reactHooks.useCallback,
    useEffect: reactHooks.useEffect,
    useMemo: <A,>(factory: () => A) => factory(),
    useRef: reactHooks.useRef,
  };
});

vi.mock("~/state/filesystem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/filesystem")>()),
  filesystemEnvironment: filesystemMocks,
}));

vi.mock("~/state/projects", () => ({
  projectEnvironment: projectMocks,
}));

vi.mock("~/state/queries", () => ({
  useProjectPathSearch: vi.fn(),
}));

import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import {
  useDirectoryListingQuery,
  useProjectEntriesQuery,
  useProjectFileQuery,
  useTrustedFileQuery,
  useTrustedMarkdownHtmlQuery,
} from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-1");

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function file(contents: string): ProjectReadFileResult {
  return {
    relativePath: "src/preview.ts",
    contents,
    byteLength: contents.length,
    truncated: false,
  };
}

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("project query refresh", () => {
  beforeEach(() => {
    authorizationMocks.sessionAtom = Atom.make(
      AsyncResult.success({ authenticated: true, scopes: [AuthFilesystemReadScope] }),
    );
    authorizationMocks.phase = "connected";
    projectMocks.listEntries.mockReset();
    projectMocks.optimisticFile.mockReset();
    projectMocks.readFile.mockReset();
    reactHooks.reset();
  });

  it("does not query or expose optimistic file contents without read permission", () => {
    authorizationMocks.sessionAtom = Atom.make(
      AsyncResult.success({ authenticated: true, scopes: [] }),
    );
    const registry = AtomRegistry.make();
    atomHooks.registry = registry;
    projectMocks.optimisticFile.mockReturnValue(Atom.make({ data: file("cached contents") }));
    try {
      const query = useProjectFileQuery(environmentId, "/repo", "src/preview.ts");
      expect(projectMocks.readFile).not.toHaveBeenCalled();
      expect(query.data).toBeNull();
      expect(query.error).toBe("This connection cannot read host files.");
      expect(query.isPending).toBe(false);
      const entries = useProjectEntriesQuery(environmentId, "/repo");
      expect(projectMocks.listEntries).not.toHaveBeenCalled();
      expect(entries.data).toBeNull();
      expect(entries.error).toBe("This connection cannot read host files.");
      expect(entries.isPending).toBe(false);
    } finally {
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("replaces an in-flight initial read when a workspace mutation arrives", async () => {
    const requests: Array<ReturnType<typeof deferred<ProjectReadFileResult>>> = [];
    const readAtom = Atom.make(
      Effect.promise(() => {
        const request = deferred<ProjectReadFileResult>();
        requests.push(request);
        return request.promise;
      }),
    ).pipe(Atom.swr({ staleTime: 30_000, revalidateOnMount: true }));
    const registry = AtomRegistry.make();
    const unmount = registry.mount(readAtom);
    projectMocks.readFile.mockReturnValue(readAtom);
    projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
    atomHooks.registry = registry;
    let renderedContents: string | null = null;

    const render = (mutationId: string | null) => {
      reactHooks.beginRender();
      const query = useProjectFileQuery(environmentId, "/repo", "src/preview.ts");
      expect(query.readError).toBeNull();
      renderedContents = query.data?.contents ?? null;
      useWorkspaceMutationRefresh({
        mutationId,
        refresh: query.refresh,
        resourceKey: "file:environment-1:/repo:src/preview.ts",
      });
    };

    try {
      render(null);
      await flushEffects();
      expect(requests).toHaveLength(1);

      render("mutation-1");
      await flushEffects();
      expect(requests).toHaveLength(2);

      requests[1]!.resolve(file("fresh"));
      await flushEffects();
      render("mutation-1");
      expect(renderedContents).toBe("fresh");

      requests[0]!.resolve(file("stale"));
      await flushEffects();
      render("mutation-1");
      expect(renderedContents).toBe("fresh");
    } finally {
      unmount();
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("confirms files from reads and preserves that identity until a definitive folder result", () => {
    const contents = file("# readme");
    const success = AsyncResult.success(contents);
    const failure = (kind: ProjectReadFileError["failure"], cached = false) =>
      AsyncResult.failure(
        Cause.fail(
          new ProjectReadFileError({ cwd: "/repo", relativePath: "src/preview.ts", failure: kind }),
        ),
        { previousSuccess: cached ? Option.some(success) : Option.none() },
      );
    const states = [
      ["initial read", AsyncResult.initial(true), false, false, null],
      ["unknown path", failure("operation_failed"), false, false, null],
      ["binary file", failure("binary_file"), true, false, null],
      ["read success", success, true, false, contents],
      ["pending refresh", AsyncResult.waiting(success), true, false, contents],
      ["transient refresh failure", failure("operation_failed", true), true, false, contents],
      ["became a folder", failure("path_not_file", true), false, true, contents],
    ] as const;
    const readAtom = Atom.make<
      AsyncResult.AsyncResult<ProjectReadFileResult, ProjectReadFileError>
    >(AsyncResult.initial(true));
    const registry = AtomRegistry.make();
    const unmount = registry.mount(readAtom);
    projectMocks.readFile.mockReturnValue(readAtom);
    projectMocks.optimisticFile.mockReturnValue(Atom.make(null));
    atomHooks.registry = registry;

    try {
      for (const [label, result, isFile, isNotFile, data] of states) {
        registry.set(readAtom, result);
        reactHooks.beginRender();
        const query = useProjectFileQuery(environmentId, "/repo", "src/preview.ts");
        expect(query.isFile, label).toBe(isFile);
        expect(query.isNotFile, label).toBe(isNotFile);
        expect(query.data, label).toBe(data);
        expect(query.isPending, label).toBe(result.waiting);
      }
    } finally {
      unmount();
      registry.dispose();
      atomHooks.registry = null;
    }
  });
});

describe("cannot read host files", () => {
  const permissionMessage = "This connection cannot read host files.";

  beforeEach(() => {
    authorizationMocks.sessionAtom = Atom.make(
      AsyncResult.success({ authenticated: true, scopes: [AuthFilesystemReadScope] }),
    );
    authorizationMocks.phase = "connected";
    projectMocks.readTrustedFile.mockReset();
    projectMocks.renderTrustedMarkdown.mockReset();
    filesystemMocks.browse.mockReset();
    reactHooks.reset();
  });

  function withRegistry(run: () => void) {
    const registry = AtomRegistry.make();
    atomHooks.registry = registry;
    try {
      run();
    } finally {
      registry.dispose();
      atomHooks.registry = null;
    }
  }

  function withoutAccess() {
    authorizationMocks.sessionAtom = Atom.make(
      AsyncResult.success({ authenticated: true, scopes: [] }),
    );
  }

  it("does not read a trusted file without access", () => {
    withoutAccess();
    withRegistry(() => {
      const query = useTrustedFileQuery(environmentId, "/a.md");
      expect(projectMocks.readTrustedFile).not.toHaveBeenCalled();
      expect(query.error).toBe(permissionMessage);
      expect(query.data).toBeNull();
      expect(query.isPending).toBe(false);
    });
  });

  it("does not read a trusted file while access is pending", () => {
    authorizationMocks.sessionAtom = Atom.make(AsyncResult.initial());
    withRegistry(() => {
      const query = useTrustedFileQuery(environmentId, "/a.md");
      expect(projectMocks.readTrustedFile).not.toHaveBeenCalled();
      expect(query.error).toBeNull();
      expect(query.isPending).toBe(true);
    });
  });

  it("reports no error for a successful trusted read", async () => {
    const readAtom = Atom.make(Effect.succeed(file("hello")));
    projectMocks.readTrustedFile.mockReturnValue(readAtom);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(readAtom);
    atomHooks.registry = registry;
    try {
      await flushEffects();
      const query = useTrustedFileQuery(environmentId, "/a.md");
      expect(query.error).toBeNull();
      expect(query.data?.contents).toBe("hello");
    } finally {
      unmount();
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("reports no error for a pending trusted read", () => {
    projectMocks.readTrustedFile.mockReturnValue(Atom.make(Effect.never));
    withRegistry(() => {
      const query = useTrustedFileQuery(environmentId, "/a.md");
      expect(query.error).toBeNull();
      expect(query.isPending).toBe(true);
    });
  });

  it("reports the cause message of a failed trusted read", async () => {
    const readAtom = Atom.make(Effect.fail(new Error("boom")));
    projectMocks.readTrustedFile.mockReturnValue(readAtom);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(readAtom);
    atomHooks.registry = registry;
    try {
      await flushEffects();
      expect(useTrustedFileQuery(environmentId, "/a.md").error).toBe("boom");
    } finally {
      unmount();
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("reports no error for a pending or successful folder listing", async () => {
    filesystemMocks.browse.mockReturnValue(Atom.make(Effect.never));
    withRegistry(() => {
      const query = useDirectoryListingQuery(environmentId, "/dir");
      expect(query.error).toBeNull();
      expect(query.isPending).toBe(true);
    });

    const listing = { parentPath: "/dir", entries: [], listedFiles: true };
    const listedAtom = Atom.make(Effect.succeed(listing));
    filesystemMocks.browse.mockReturnValue(listedAtom);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(listedAtom);
    atomHooks.registry = registry;
    try {
      await flushEffects();
      const query = useDirectoryListingQuery(environmentId, "/dir");
      expect(query.error).toBeNull();
      expect(query.data).not.toBeNull();
    } finally {
      unmount();
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("reports that a server answering without a listing cannot list folders", async () => {
    const legacyAtom = Atom.make(Effect.succeed({ parentPath: "/dir", entries: [] }));
    filesystemMocks.browse.mockReturnValue(legacyAtom);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(legacyAtom);
    atomHooks.registry = registry;
    try {
      await flushEffects();
      const query = useDirectoryListingQuery(environmentId, "/dir");
      expect(query.error).toBe("This server cannot list folders.");
      expect(query.data).toBeNull();
    } finally {
      unmount();
      registry.dispose();
      atomHooks.registry = null;
    }
  });

  it("reports no error for a pending markdown render", () => {
    projectMocks.renderTrustedMarkdown.mockReturnValue(Atom.make(Effect.never));
    withRegistry(() => {
      const query = useTrustedMarkdownHtmlQuery(environmentId, "/a.md");
      expect(query.error).toBeNull();
      expect(query.isPending).toBe(true);
    });
  });

  it("stays idle without an environment or path", () => {
    withRegistry(() => {
      for (const query of [useTrustedFileQuery(null, null), useDirectoryListingQuery(null, null)]) {
        expect(query.error).toBeNull();
        expect(query.isPending).toBe(false);
      }
    });
  });

  it("reports no access error for a disabled query", () => {
    withoutAccess();
    withRegistry(() => {
      const query = useTrustedFileQuery(environmentId, null);
      expect(query.error).toBeNull();
      expect(query.isPending).toBe(false);
    });
  });

  it("gates directory listings and rendered markdown without access", () => {
    withoutAccess();
    withRegistry(() => {
      const listing = useDirectoryListingQuery(environmentId, "/dir");
      const html = useTrustedMarkdownHtmlQuery(environmentId, "/a.md");
      expect(filesystemMocks.browse).not.toHaveBeenCalled();
      expect(projectMocks.renderTrustedMarkdown).not.toHaveBeenCalled();
      expect(listing.error).toBe(permissionMessage);
      expect(html.error).toBe(permissionMessage);
    });
  });
});
