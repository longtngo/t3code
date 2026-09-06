import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { renderDom } from "../../testing/renderDom";
import {
  getProviderStatusBannerKey,
  getProviderStatusMessage,
  ProviderStatusBanner,
  shouldShowProviderStatusBanner,
} from "./ProviderStatusBanner";

function warningProvider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "warning",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-23T12:00:00.000Z",
    message: "Provider is temporarily degraded.",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("ProviderStatusBanner", () => {
  it("waits for an Antigravity auth result before showing a sign-in warning", () => {
    const status: ServerProvider = {
      ...warningProvider(),
      instanceId: ProviderInstanceId.make("google_work"),
      driver: ProviderDriverKind.make("antigravity"),
      auth: { status: "unknown" },
      message: "Antigravity is installed. Google account access is not checked yet.",
    };

    expect(shouldShowProviderStatusBanner(status, null)).toBe(false);
    expect(
      shouldShowProviderStatusBanner(
        {
          ...status,
          auth: { status: "unauthenticated" },
          message: "Sign in with Google to use Antigravity.",
        },
        null,
      ),
    ).toBe(true);
  });

  it("shows Antigravity installation and startup failures before auth is checked", () => {
    const status: ServerProvider = {
      ...warningProvider(),
      driver: ProviderDriverKind.make("antigravity"),
      auth: { status: "unknown" },
    };

    expect(shouldShowProviderStatusBanner({ ...status, installed: false }, null)).toBe(true);
    expect(shouldShowProviderStatusBanner({ ...status, status: "error" }, null)).toBe(true);
    expect(
      shouldShowProviderStatusBanner({ ...status, driver: ProviderDriverKind.make("codex") }, null),
    ).toBe(true);
  });

  it("stays hidden after its current warning is dismissed", () => {
    const status = warningProvider();

    expect(shouldShowProviderStatusBanner(status, null)).toBe(true);
    expect(shouldShowProviderStatusBanner(status, getProviderStatusBannerKey(status))).toBe(false);
  });

  it("renders an accessible dismiss control for provider warnings", async () => {
    const view = await renderDom(
      <ProviderStatusBanner status={warningProvider()} onDismiss={() => {}} />,
    );

    expect(view.find('[role="alert"]')).not.toBeNull();
    // Pinned to the banner's own corner rather than laid out in the flow, so a
    // long message cannot push the dismiss control out of reach.
    expect(
      view.find('button[aria-label="Dismiss Codex provider warning"].absolute.top-2.right-2'),
    ).not.toBeNull();
  });

  // The banner covers the top of the timeline, so it is the only way back to
  // the conversation; a dismiss control that renders but reports nothing is
  // exactly the failure static markup could not see. Upstream dropped the matching
  // assertions from its own copy in #10148 as styling detail; they are kept here
  // because all three still render, and the glass surface is what stops the
  // timeline reading through the banner.
  it("reports a dismiss to its owner", async () => {
    const onDismiss = vi.fn();
    const view = await renderDom(
      <ProviderStatusBanner status={warningProvider()} onDismiss={onDismiss} />,
    );

    await view.click(view.find('button[aria-label="Dismiss Codex provider warning"]'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders on a glass surface so the timeline never reads through the banner", async () => {
    const view = await renderDom(
      <ProviderStatusBanner status={warningProvider()} onDismiss={() => {}} />,
    );

    expect(view.find(".alert-glass")).not.toBeNull();
    expect(view.find('[data-variant="warning"]')).not.toBeNull();
  });

  it("labels error dismiss controls with the correct severity", async () => {
    const view = await renderDom(
      <ProviderStatusBanner
        status={{ ...warningProvider(), status: "error" }}
        onDismiss={() => {}}
      />,
    );

    expect(view.find('[aria-label="Dismiss Codex provider error"]')).not.toBeNull();
  });
});

describe("getProviderStatusMessage", () => {
  it("preserves the environment's authentication error", () => {
    const message = "SUBSCRIPTION_REQUIRED: This Google account cannot use Antigravity.";
    expect(
      getProviderStatusMessage({
        ...warningProvider(),
        driver: ProviderDriverKind.make("antigravity"),
        status: "error",
        auth: { status: "unauthenticated" },
        message,
      }),
    ).toBe(message);
  });

  it("points a signed-out Antigravity account to Google sign-in without a CLI command", () => {
    expect(
      getProviderStatusMessage({
        ...warningProvider(),
        driver: ProviderDriverKind.make("antigravity"),
        status: "error",
        auth: { status: "unauthenticated" },
        message: "",
      }),
    ).toBe("Open provider setup to sign in with Google.");
  });

  it("requires installation on the environment before sign-in", () => {
    expect(
      getProviderStatusMessage({
        ...warningProvider(),
        driver: ProviderDriverKind.make("antigravity"),
        displayName: "Google work account",
        installed: false,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "",
      }),
    ).toBe("Open provider setup to install Antigravity on this environment.");
  });

  it("keeps CLI sign-in advice for a provider without integrated setup", () => {
    expect(
      getProviderStatusMessage({
        ...warningProvider(),
        status: "error",
        auth: { status: "unauthenticated" },
        message: "",
      }),
    ).toBe("Sign in via the CLI to authenticate again.");
  });
});
