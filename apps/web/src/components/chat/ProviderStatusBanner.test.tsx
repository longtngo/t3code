import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProviderStatusBanner } from "./ProviderStatusBanner";

const warningStatus = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "UniSub",
  status: "warning",
  message: "Could not verify Claude authentication status from initialization result.",
  checkedAt: "2026-06-06T00:00:00.000Z",
} as Partial<ServerProvider> as ServerProvider;

// Dismissal itself is exercised in ProviderStatusBanner.logic.test.ts — the
// zustand hook reads the store's *initial* state under renderToString, so the
// post-dismiss hidden state is not observable via server rendering.
describe("ProviderStatusBanner", () => {
  it("renders a degraded status with its message and a dismiss button", () => {
    const html = renderToString(createElement(ProviderStatusBanner, { status: warningStatus }));
    expect(html).toContain("UniSub provider status");
    expect(html).toContain("Could not verify Claude authentication status");
    expect(html).toContain("Dismiss provider status notice");
  });

  it("renders nothing for ready or absent statuses", () => {
    const readyStatus = { ...warningStatus, status: "ready" } as ServerProvider;
    expect(renderToString(createElement(ProviderStatusBanner, { status: readyStatus }))).toBe("");
    expect(renderToString(createElement(ProviderStatusBanner, { status: null }))).toBe("");
  });
});
