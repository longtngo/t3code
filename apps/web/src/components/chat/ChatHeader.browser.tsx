import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { ChatHeader } from "./ChatHeader";
import { SidebarProvider } from "../ui/sidebar";

function renderHeader(props?: Partial<Parameters<typeof ChatHeader>[0]>) {
  return render(
    <SidebarProvider>
      <ChatHeader
        activeThreadEnvironmentId={EnvironmentId.make("env-1")}
        activeThreadId={ThreadId.make("thread-1")}
        activeThreadTitle="Test thread"
        activeProjectName={undefined}
        isGitRepo={false}
        openInCwd={null}
        activeProjectScripts={undefined}
        preferredScriptId={null}
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        availableEditors={[]}
        terminalAvailable={false}
        terminalOpen={false}
        terminalToggleShortcutLabel={null}
        diffToggleShortcutLabel={null}
        gitCwd={null}
        diffOpen={false}
        onRunProjectScript={vi.fn()}
        onAddProjectScript={vi.fn()}
        onUpdateProjectScript={vi.fn()}
        onDeleteProjectScript={vi.fn()}
        onToggleTerminal={vi.fn()}
        onToggleDiff={vi.fn()}
        {...props}
      />
    </SidebarProvider>,
  );
}

async function expectTooltipText(text: string) {
  await vi.waitFor(
    () => {
      const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
      expect(tooltip).not.toBeNull();
      expect(tooltip?.textContent).toContain(text);
    },
    { timeout: 8_000, interval: 16 },
  );
}

describe("ChatHeader", () => {
  it("shows the terminal-unavailable tooltip on hover while the toggle is disabled", async () => {
    await renderHeader();
    const toggle = document.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle terminal drawer"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.disabled).toBe(true);
    await userEvent.hover(toggle!, { force: true });
    await expectTooltipText("Terminal is unavailable until this thread has an active project.");
  });

  it("shows the diff-unavailable tooltip on hover while the toggle is disabled", async () => {
    await renderHeader();
    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="Toggle diff panel"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.disabled).toBe(true);
    await userEvent.hover(toggle!, { force: true });
    await expectTooltipText(
      "Diff panel is unavailable because this project is not a git repository.",
    );
  });

  it("shows the shortcut tooltip on hover while the terminal toggle is enabled", async () => {
    await renderHeader({ terminalAvailable: true, terminalToggleShortcutLabel: "⌘J" });
    const toggle = document.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle terminal drawer"]',
    );
    expect(toggle?.disabled).toBe(false);
    await userEvent.hover(toggle!);
    await expectTooltipText("Toggle terminal drawer (⌘J)");
  });
});
