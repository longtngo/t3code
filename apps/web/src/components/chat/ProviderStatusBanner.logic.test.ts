import { ProviderInstanceId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  providerStatusBannerKey,
  useDismissedProviderStatusBanners,
} from "./ProviderStatusBanner.logic";

describe("providerStatusBannerKey", () => {
  it("is stable across periodic refreshes of the same reported state", () => {
    const key = providerStatusBannerKey({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      status: "warning",
      message: "Could not verify Claude authentication status from initialization result.",
    });
    const refreshedKey = providerStatusBannerKey({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      status: "warning",
      message: "Could not verify Claude authentication status from initialization result.",
    });
    expect(refreshedKey).toBe(key);
  });

  it("changes when the status, message, or instance changes", () => {
    const base = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      status: "warning",
      message: "Could not verify Claude authentication status from initialization result.",
    } as const;
    const key = providerStatusBannerKey(base);

    expect(providerStatusBannerKey({ ...base, status: "error" })).not.toBe(key);
    expect(providerStatusBannerKey({ ...base, message: "Claude is disabled." })).not.toBe(key);
    expect(
      providerStatusBannerKey({
        ...base,
        instanceId: ProviderInstanceId.make("claudeAgent_personalsub"),
      }),
    ).not.toBe(key);
  });

  it("treats a missing message as empty", () => {
    expect(
      providerStatusBannerKey({
        instanceId: ProviderInstanceId.make("codex"),
        status: "warning",
        message: undefined,
      }),
    ).toBe("codex|warning|");
  });
});

describe("useDismissedProviderStatusBanners", () => {
  beforeEach(() => {
    useDismissedProviderStatusBanners.setState({ dismissedKeys: new Set<string>() });
  });

  it("accumulates dismissed keys", () => {
    const { dismiss } = useDismissedProviderStatusBanners.getState();
    dismiss("a|warning|m1");
    dismiss("b|error|m2");

    const { dismissedKeys } = useDismissedProviderStatusBanners.getState();
    expect(dismissedKeys.has("a|warning|m1")).toBe(true);
    expect(dismissedKeys.has("b|error|m2")).toBe(true);
    expect(dismissedKeys.has("a|warning|other")).toBe(false);
  });
});
