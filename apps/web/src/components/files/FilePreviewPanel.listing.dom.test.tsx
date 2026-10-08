import { EnvironmentId, ThreadId, type FilesystemBrowseResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";

/**
 * A fake host with one real folder. A listing asked for any other path fails, the way `filesystem.browse` does for a folder that is not there.
 */
const host = vi.hoisted(() => ({
  folder: "",
  listings: [] as string[],
}));

vi.mock("./projectFilesQueryState", () => ({
  getOptimisticProjectFileQueryData: () => null,
  getProjectFileContents: () => null,
  setProjectFileQueryData: () => undefined,
  // The read of a folder fails; that failure is what sends the panel to the listing.
  useProjectFileQuery: () => ({
    data: null,
    error: "Failed to read workspace file.",
    isPending: false,
    readError: null,
    isNotFile: false,
    refresh: () => undefined,
  }),
  useDirectoryListingQuery: (environmentId: unknown, directoryPath: string | null) => {
    if (environmentId !== null && directoryPath !== null) host.listings.push(directoryPath);
    const found = environmentId !== null && directoryPath === host.folder;
    const data: FilesystemBrowseResult | null = found
      ? {
          parentPath: host.folder,
          listedFiles: true,
          entries: [{ name: "summary.md", fullPath: `${host.folder}/summary.md`, kind: "file" }],
        }
      : null;
    return {
      data,
      error: found || directoryPath === null ? null : "No such folder.",
      isPending: false,
      refresh: () => undefined,
    };
  },
}));
vi.mock("~/state/filesystem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/filesystem")>()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("~/hooks/useWorkspaceRepos", () => ({
  useWorkspaceRepos: () => [],
  resolveActiveRepo: () => null,
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  useEnvironmentScope: () => true,
}));
vi.mock("~/state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/environments")>()),
  usePrimaryEnvironmentId: () => null,
  useEnvironmentHttpBaseUrl: () => null,
}));
vi.mock("~/remoteOpen", () => ({ useRemoteOpenState: () => ({ mode: "local-exec" }) }));
vi.mock("~/browser/previewRuntime", () => ({ usePreviewAvailable: () => false }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./FileBreadcrumbs", () => ({ FileBreadcrumbs: () => null }));

import FilePreviewPanel from "./FilePreviewPanel";

const environmentId = EnvironmentId.make("env-1");
const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };

function renderPanel(relativePath: string) {
  return renderDom(
    <FilePreviewPanel
      environmentId={environmentId}
      cwd="/Users/me/project"
      projectName="project"
      relativePath={relativePath}
      threadRef={threadRef}
      composerDraftTarget={threadRef}
      keybindings={[]}
      availableEditors={[]}
      revealLine={null}
      revealRequestId={0}
      onOpenFile={() => undefined}
      onPendingChange={() => undefined}
      selectedFilePending={false}
      workspaceMutationId={null}
    />,
  );
}

describe("FilePreviewPanel folder fallback", () => {
  it.each([
    [
      "outside the project, by the absolute path it was opened with",
      "/Users/me/reports",
      "/Users/me/reports",
    ],
    ["inside the project, under the project folder", "docs", "/Users/me/project/docs"],
  ])("lists a folder %s", async (_case, openedPath, folder) => {
    host.folder = folder;
    host.listings.length = 0;
    const panel = await renderPanel(openedPath);

    // Asked for that one folder, never a path grafted under (or missing) the project cwd.
    expect(host.listings.length).toBeGreaterThan(0);
    expect(new Set(host.listings)).toEqual(new Set([folder]));
    expect(panel.text()).toContain("summary.md");
    expect(panel.find("[role='alert']")).toBeNull();
  });
});
