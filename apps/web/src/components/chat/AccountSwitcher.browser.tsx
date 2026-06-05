import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { AccountSwitcher } from "./AccountSwitcher";
import type { ProviderInstanceEntry } from "../../providerInstances";

const claudeKind = ProviderDriverKind.make("claudeAgent");
const codexKind = ProviderDriverKind.make("codex");

function makeEntry(args: {
  id: string;
  driverKind?: ProviderDriverKind;
  displayName: string;
  email?: string;
  type?: string;
  enabled?: boolean;
  isAvailable?: boolean;
  continuationGroupKey?: string;
}): ProviderInstanceEntry {
  return {
    instanceId: ProviderInstanceId.make(args.id),
    driverKind: args.driverKind ?? claudeKind,
    displayName: args.displayName,
    accentColor: undefined,
    continuationGroupKey: args.continuationGroupKey,
    enabled: args.enabled ?? true,
    installed: true,
    status: "ready",
    isDefault: false,
    isAvailable: args.isAvailable ?? true,
    snapshot: {
      auth: {
        status: "authenticated",
        ...(args.email ? { email: args.email } : {}),
        ...(args.type ? { type: args.type } : {}),
      },
    } as unknown as ProviderInstanceEntry["snapshot"],
    models: [],
  } satisfies ProviderInstanceEntry;
}

const work = makeEntry({
  id: "claudeAgent",
  displayName: "Work",
  email: "work@uni.com",
  type: "max",
});
const personal = makeEntry({
  id: "claude_personal",
  displayName: "Personal",
  email: "me@home.com",
  type: "pro",
});
const codex = makeEntry({ id: "codex", driverKind: codexKind, displayName: "Codex" });

const switcher = () => document.querySelector('[data-chat-account-switcher="true"]');

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

describe("AccountSwitcher", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("renders nothing with fewer than two Claude accounts", async () => {
    await render(
      <AccountSwitcher
        instanceEntries={[work, codex]}
        activeInstanceId={work.instanceId}
        onSelectAccount={vi.fn()}
      />,
    );
    expect(switcher()).toBeNull();
  });

  it("renders nothing when the active instance is not a Claude account", async () => {
    await render(
      <AccountSwitcher
        instanceEntries={[work, personal, codex]}
        activeInstanceId={codex.instanceId}
        onSelectAccount={vi.fn()}
      />,
    );
    expect(switcher()).toBeNull();
  });

  it("renders nothing when only one Claude account is enabled/available", async () => {
    const disabledPersonal = makeEntry({
      id: "claude_personal",
      displayName: "Personal",
      enabled: false,
    });
    await render(
      <AccountSwitcher
        instanceEntries={[work, disabledPersonal]}
        activeInstanceId={work.instanceId}
        onSelectAccount={vi.fn()}
      />,
    );
    expect(switcher()).toBeNull();
  });

  it("renders nothing when both Claude accounts share one login (same continuation group)", async () => {
    const sharedKey = "claude:home:/Users/x:config:";
    const workShared = makeEntry({
      id: "claudeAgent",
      displayName: "Work",
      continuationGroupKey: sharedKey,
    });
    const personalShared = makeEntry({
      id: "claude_personal",
      displayName: "Personal",
      continuationGroupKey: sharedKey,
    });
    await render(
      <AccountSwitcher
        instanceEntries={[workShared, personalShared]}
        activeInstanceId={workShared.instanceId}
        onSelectAccount={vi.fn()}
      />,
    );
    expect(switcher()).toBeNull();
  });

  it("shows the active account display name on the trigger with two Claude accounts", async () => {
    await render(
      <AccountSwitcher
        instanceEntries={[work, personal]}
        activeInstanceId={work.instanceId}
        onSelectAccount={vi.fn()}
      />,
    );
    const el = switcher();
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain("Work");
    expect(el?.textContent).not.toContain("work@uni.com");
  });

  it("renders a disabled trigger that cannot open the menu when disabled", async () => {
    await render(
      <AccountSwitcher
        instanceEntries={[work, personal]}
        activeInstanceId={work.instanceId}
        disabled
        onSelectAccount={vi.fn()}
      />,
    );
    const el = switcher();
    expect(el).not.toBeNull();
    expect(el).toHaveProperty("disabled", true);
    await userEvent.click(el!, { force: true });
    expect(page.getByRole("menuitem").all()).toHaveLength(0);
  });

  it("shows the switch tooltip on hover while enabled", async () => {
    await render(
      <AccountSwitcher
        instanceEntries={[work, personal]}
        activeInstanceId={work.instanceId}
        onSelectAccount={vi.fn()}
      />,
    );
    await userEvent.hover(switcher()!);
    await expectTooltipText("Switch Claude account");
  });

  it("shows the locked tooltip on hover while disabled", async () => {
    await render(
      <AccountSwitcher
        instanceEntries={[work, personal]}
        activeInstanceId={work.instanceId}
        disabled
        onSelectAccount={vi.fn()}
      />,
    );
    await userEvent.hover(switcher()!, { force: true });
    await expectTooltipText("Account is locked for this thread");
  });

  it("collapses same-login instances to one menu row", async () => {
    const sharedKey = "claude:home:/Users/x:config:";
    const workA = makeEntry({
      id: "claudeAgent",
      displayName: "Work A",
      continuationGroupKey: sharedKey,
    });
    const workB = makeEntry({
      id: "claude_twin",
      displayName: "Work B",
      continuationGroupKey: sharedKey,
    });
    const personalDistinct = makeEntry({
      id: "claude_personal",
      displayName: "Personal",
      continuationGroupKey: "claude:home:/Users/x:config:/Users/x/.claude-personal",
    });
    await render(
      <AccountSwitcher
        instanceEntries={[workA, workB, personalDistinct]}
        activeInstanceId={workA.instanceId}
        onSelectAccount={vi.fn()}
      />,
    );
    await userEvent.click(switcher()!);
    const items = page.getByRole("menuitem");
    await expect.element(items.first()).toBeVisible();
    expect(items.all()).toHaveLength(2);
    expect(document.body.textContent).toContain("Work A");
    expect(document.body.textContent).not.toContain("Work B");
  });

  it("calls onSelectAccount with the chosen instance and empty model when no memory", async () => {
    const onSelectAccount = vi.fn();
    await render(
      <AccountSwitcher
        instanceEntries={[work, personal]}
        activeInstanceId={work.instanceId}
        onSelectAccount={onSelectAccount}
      />,
    );
    await userEvent.click(switcher()!);
    await userEvent.click(page.getByRole("menuitem", { name: /Personal/ }));
    expect(onSelectAccount).toHaveBeenCalledWith(personal.instanceId, "");
  });
});
