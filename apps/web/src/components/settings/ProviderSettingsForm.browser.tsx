import { ProviderDriverKind } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import { ProviderSettingsForm } from "./ProviderSettingsForm";
import { __resetLocalApiForTests } from "../../localApi";

const claude = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("claudeAgent")]!;

describe("ProviderSettingsForm folder control", () => {
  afterEach(async () => {
    delete (window as { desktopBridge?: unknown }).desktopBridge;
    await __resetLocalApiForTests();
  });

  it("renders folder fields as plain inputs without a Browse button on web", async () => {
    await render(
      <ProviderSettingsForm
        definition={claude}
        value={{}}
        idPrefix="test"
        variant="dialog"
        onChange={vi.fn()}
      />,
    );

    expect(document.querySelector("#test-configDirPath")).not.toBeNull();
    expect(
      Array.from(document.querySelectorAll("button")).filter((button) =>
        button.textContent?.includes("Browse"),
      ),
    ).toEqual([]);
  });

  it("writes the picked folder into the field via the desktop Browse button", async () => {
    const pickFolder = vi.fn().mockResolvedValue("/Users/x/.claude-personal");
    window.desktopBridge = {
      pickFolder,
      getLocalEnvironmentBootstrap: () => null,
    } as unknown as NonNullable<typeof window.desktopBridge>;
    const onChange = vi.fn();

    await render(
      <ProviderSettingsForm
        definition={claude}
        value={{ configDirPath: "~/.claude-personal" }}
        idPrefix="test"
        variant="dialog"
        onChange={onChange}
      />,
    );

    const configDirRow = document.querySelector("#test-configDirPath")?.closest("label");
    const browseButton = configDirRow?.querySelector("button");
    expect(browseButton?.textContent).toContain("Browse");
    browseButton!.click();

    await vi.waitFor(() => {
      expect(pickFolder).toHaveBeenCalledWith({ initialPath: "~/.claude-personal" });
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ configDirPath: "/Users/x/.claude-personal" }),
      );
    });
  });
});
