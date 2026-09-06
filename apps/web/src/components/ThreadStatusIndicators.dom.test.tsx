import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { renderDom } from "../testing/renderDom";
import { ThreadWorktreeIndicator } from "./ThreadStatusIndicators";

describe("ThreadWorktreeIndicator", () => {
  it("renders the worktree folder and branch in an accessible label", async () => {
    const view = await renderDom(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "feature/sidebar-indicator",
          worktreePath: "/tmp/worktrees/sidebar-indicator",
        }}
      />,
    );

    const indicator = view.find('[data-testid="thread-worktree-thread-1"]');
    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute("role")).toBe("img");
    expect(indicator?.getAttribute("aria-label")).toBe(
      "Worktree: sidebar-indicator (feature/sidebar-indicator)",
    );
  });

  it.each([null, "", "   "])(
    "renders nothing for an absent worktree path",
    async (worktreePath) => {
      const view = await renderDom(
        <ThreadWorktreeIndicator
          thread={{
            id: ThreadId.make("thread-1"),
            branch: "main",
            worktreePath,
          }}
        />,
      );

      expect(view.container.innerHTML).toBe("");
    },
  );
});
