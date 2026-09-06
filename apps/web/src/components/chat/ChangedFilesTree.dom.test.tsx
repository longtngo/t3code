import { TurnId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";
import { ChangedFilesCard, ChangedFilesTree } from "./ChangedFilesTree";

describe("ChangedFilesCard", () => {
  it("keeps its compact header sticky while preserving singular labels", async () => {
    const view = await renderDom(
      <ChangedFilesCard
        turnId={TurnId.make("turn-1")}
        files={[{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }]}
        allDirectoriesExpanded
        resolvedTheme="light"
        onToggleAllDirectories={() => {}}
        onOpenTurnDiff={() => {}}
      />,
    );

    expect(view.find('[data-changed-files-state="tree"]')).not.toBeNull();
    expect(view.find('[aria-label="Open diff"]')).not.toBeNull();
    expect(view.find('[role="group"][aria-label="2 additions, 1 deletions"]')).not.toBeNull();
    expect(view.text()).toContain("1 changed file");
    expect(view.text()).not.toContain("1 changed files");
  });

  it("shows collapsed folders and root files together", async () => {
    const view = await renderDom(
      <ChangedFilesCard
        turnId={TurnId.make("turn-1")}
        files={[
          { path: "apps/web/src/App.tsx", kind: "modified", additions: 120, deletions: 20 },
          { path: "apps/web/src/App.test.tsx", kind: "modified", additions: 30, deletions: 2 },
          {
            path: "packages/shared/src/git.ts",
            kind: "modified",
            additions: 15,
            deletions: 4,
          },
          { path: "README.md", kind: "modified", additions: 3, deletions: 0 },
        ]}
        allDirectoriesExpanded={false}
        resolvedTheme="light"
        onToggleAllDirectories={() => {}}
        onOpenTurnDiff={() => {}}
      />,
    );

    expect(view.find('[data-changed-files-state="tree"]')).not.toBeNull();
    expect(view.find('[aria-expanded="false"]')).not.toBeNull();
    expect(view.text()).toContain("apps/web/src");
    expect(view.text()).not.toContain("App.tsx");
    expect(view.text()).toContain("packages/shared/src");
    expect(view.text()).not.toContain("git.ts");
    expect(view.text()).toContain("README.md");
    expect(view.text()).not.toContain("Show all");
    expect(view.text()).not.toContain("App.test.tsx");
  });

  it("keeps the folder tree visible when folders are collapsed", async () => {
    const view = await renderDom(
      <ChangedFilesCard
        turnId={TurnId.make("turn-1")}
        files={[{ path: "apps/web/src/App.tsx", kind: "modified", additions: 120, deletions: 20 }]}
        allDirectoriesExpanded={false}
        resolvedTheme="light"
        onToggleAllDirectories={() => {}}
        onOpenTurnDiff={() => {}}
      />,
    );

    expect(view.find('[data-changed-files-state="tree"]')).not.toBeNull();
    expect(view.text()).toContain("1 changed file");
    expect(view.text()).toContain("apps/web/src");
    expect(view.text()).not.toContain("Show all");
    expect(view.text()).not.toContain("App.tsx");
  });

  // The header's two controls only ever existed as markup in these tests, so nothing proved
  // either was wired to the prop it is named after.
  it("opens the turn diff on the first file when the header control is pressed", async () => {
    const onOpenTurnDiff = vi.fn();
    const view = await renderDom(
      <ChangedFilesCard
        turnId={TurnId.make("turn-1")}
        files={[
          { path: "apps/web/src/App.tsx", kind: "modified", additions: 120, deletions: 20 },
          { path: "README.md", kind: "modified", additions: 3, deletions: 0 },
        ]}
        allDirectoriesExpanded={false}
        resolvedTheme="light"
        onToggleAllDirectories={() => {}}
        onOpenTurnDiff={onOpenTurnDiff}
      />,
    );

    await view.click(view.find('[aria-label="Open diff"]'));

    expect(onOpenTurnDiff).toHaveBeenCalledTimes(1);
    expect(onOpenTurnDiff).toHaveBeenCalledWith(TurnId.make("turn-1"), "apps/web/src/App.tsx");
  });

  it("asks its owner to flip collapse-all when the folder control is pressed", async () => {
    const onToggleAllDirectories = vi.fn();
    const view = await renderDom(
      <ChangedFilesCard
        turnId={TurnId.make("turn-1")}
        files={[{ path: "apps/web/src/App.tsx", kind: "modified", additions: 120, deletions: 20 }]}
        allDirectoriesExpanded={false}
        resolvedTheme="light"
        onToggleAllDirectories={onToggleAllDirectories}
        onOpenTurnDiff={() => {}}
      />,
    );

    // Collapsed, so the control offers the way back out.
    await view.click(view.find('[aria-label="Expand all folders"]'));

    expect(onToggleAllDirectories).toHaveBeenCalledTimes(1);
  });

  it("offers no folder control when nothing is nested", async () => {
    const view = await renderDom(
      <ChangedFilesCard
        turnId={TurnId.make("turn-1")}
        files={[{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }]}
        allDirectoriesExpanded
        resolvedTheme="light"
        onToggleAllDirectories={() => {}}
        onOpenTurnDiff={() => {}}
      />,
    );

    expect(view.find('[aria-label="Collapse all folders"]')).toBeNull();
    expect(view.find('[aria-label="Expand all folders"]')).toBeNull();
  });
});

describe("ChangedFilesTree", () => {
  it.each([
    {
      name: "a compacted single-chain directory",
      files: [
        { path: "apps/web/src/index.ts", kind: "modified", additions: 2, deletions: 1 },
        { path: "apps/web/src/main.ts", kind: "modified", additions: 3, deletions: 0 },
      ],
      visibleLabels: ["apps/web/src"],
      hiddenLabels: ["index.ts", "main.ts"],
    },
    {
      name: "a branch point after a compacted prefix",
      files: [
        {
          path: "apps/server/src/git/Layers/GitCore.ts",
          kind: "modified",
          additions: 4,
          deletions: 3,
        },
        {
          path: "apps/server/src/provider/Layers/CodexAdapter.ts",
          kind: "modified",
          additions: 7,
          deletions: 2,
        },
      ],
      visibleLabels: ["apps/server/src"],
      hiddenLabels: ["git", "provider", "GitCore.ts", "CodexAdapter.ts"],
    },
    {
      name: "mixed root files and nested compacted directories",
      files: [
        { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
        { path: "packages/shared/src/git.ts", kind: "modified", additions: 8, deletions: 2 },
        {
          path: "packages/contracts/src/orchestration.ts",
          kind: "modified",
          additions: 13,
          deletions: 3,
        },
      ],
      visibleLabels: ["README.md", "packages"],
      hiddenLabels: ["shared/src", "contracts/src", "git.ts", "orchestration.ts"],
    },
  ])(
    "renders $name collapsed on the first render when collapse-all is active",
    async ({ files, visibleLabels, hiddenLabels }) => {
      const view = await renderDom(
        <ChangedFilesTree
          turnId={TurnId.make("turn-1")}
          files={files}
          allDirectoriesExpanded={false}
          resolvedTheme="light"
          onOpenTurnDiff={() => {}}
        />,
      );

      for (const label of visibleLabels) {
        expect(view.text()).toContain(label);
      }
      for (const label of hiddenLabels) {
        expect(view.text()).not.toContain(label);
      }
    },
  );

  it.each([
    {
      name: "a compacted single-chain directory",
      files: [
        { path: "apps/web/src/index.ts", kind: "modified", additions: 2, deletions: 1 },
        { path: "apps/web/src/main.ts", kind: "modified", additions: 3, deletions: 0 },
      ],
      visibleLabels: ["apps/web/src", "index.ts", "main.ts"],
    },
    {
      name: "a branch point after a compacted prefix",
      files: [
        {
          path: "apps/server/src/git/Layers/GitCore.ts",
          kind: "modified",
          additions: 4,
          deletions: 3,
        },
        {
          path: "apps/server/src/provider/Layers/CodexAdapter.ts",
          kind: "modified",
          additions: 7,
          deletions: 2,
        },
      ],
      visibleLabels: [
        "apps/server/src",
        "git/Layers",
        "provider/Layers",
        "GitCore.ts",
        "CodexAdapter.ts",
      ],
    },
    {
      name: "mixed root files and nested compacted directories",
      files: [
        { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
        { path: "packages/shared/src/git.ts", kind: "modified", additions: 8, deletions: 2 },
        {
          path: "packages/contracts/src/orchestration.ts",
          kind: "modified",
          additions: 13,
          deletions: 3,
        },
      ],
      visibleLabels: [
        "README.md",
        "packages",
        "shared/src",
        "contracts/src",
        "git.ts",
        "orchestration.ts",
      ],
    },
  ])(
    "renders $name expanded on the first render when expand-all is active",
    async ({ files, visibleLabels }) => {
      const view = await renderDom(
        <ChangedFilesTree
          turnId={TurnId.make("turn-1")}
          files={files}
          allDirectoriesExpanded
          resolvedTheme="light"
          onOpenTurnDiff={() => {}}
        />,
      );

      for (const label of visibleLabels) {
        expect(view.text()).toContain(label);
      }
    },
  );

  it("opens the diff for the file row that was pressed, not the first one", async () => {
    const onOpenTurnDiff = vi.fn();
    const view = await renderDom(
      <ChangedFilesTree
        turnId={TurnId.make("turn-1")}
        files={[
          { path: "apps/web/src/index.ts", kind: "modified", additions: 2, deletions: 1 },
          { path: "apps/web/src/main.ts", kind: "modified", additions: 3, deletions: 0 },
        ]}
        allDirectoriesExpanded
        resolvedTheme="light"
        onOpenTurnDiff={onOpenTurnDiff}
      />,
    );

    const mainRow = view.findAll("button").find((row) => row.textContent?.includes("main.ts"));
    expect(mainRow).toBeDefined();
    await view.click(mainRow ?? null);

    expect(onOpenTurnDiff).toHaveBeenCalledTimes(1);
    expect(onOpenTurnDiff).toHaveBeenCalledWith(TurnId.make("turn-1"), "apps/web/src/main.ts");
  });

  // The collapse-all cases above only cover the first render. The folder row owns its own
  // expansion state, so a collapsed folder must still be openable on its own.
  it("reveals a collapsed folder's files when the folder row is pressed", async () => {
    const view = await renderDom(
      <ChangedFilesTree
        turnId={TurnId.make("turn-1")}
        files={[
          { path: "apps/web/src/index.ts", kind: "modified", additions: 2, deletions: 1 },
          { path: "apps/web/src/main.ts", kind: "modified", additions: 3, deletions: 0 },
        ]}
        allDirectoriesExpanded={false}
        resolvedTheme="light"
        onOpenTurnDiff={() => {}}
      />,
    );

    expect(view.text()).not.toContain("index.ts");

    await view.click(view.find('[aria-expanded="false"]'));

    expect(view.find('[aria-expanded="true"]')).not.toBeNull();
    expect(view.text()).toContain("index.ts");
    expect(view.text()).toContain("main.ts");
  });
});
