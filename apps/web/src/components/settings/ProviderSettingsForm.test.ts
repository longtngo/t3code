import { describe, expect, it } from "vite-plus/test";
import { CLAUDE_OUTPUT_STYLES, ProviderDriverKind } from "@t3tools/contracts";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  readProviderConfigBoolean,
  readProviderConfigString,
  selectedOptionValue,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("derives visible provider config fields from the client definition schema", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")];

    expect(codex).toBeDefined();
    expect(deriveProviderSettingsFields(codex!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "shadowHomePath",
      "launchArgs",
    ]);
  });

  it("sources labels and descriptions from schema annotations", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverPassword = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverPassword",
    );

    expect(serverPassword).toMatchObject({
      label: "Server password",
      description: "Stored in plain text on disk.",
      control: "password",
    });
  });

  it("shows the auto-compaction threshold for Claude providers", () => {
    const claude = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("claudeAgent")];
    expect(claude).toBeDefined();

    expect(deriveProviderSettingsFields(claude!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      // FORK: `configDirPath` is a fork-only Claude field. Upstream's order has no
      // slot for it, so this assertion is retargeted rather than deleted — its
      // subject (autoCompactWindow shows up for Claude) still applies.
      "configDirPath",
      "autoCompactWindow",
      "outputStyle",
      "launchArgs",
    ]);
  });

  it("offers the output style as a closed set of choices", () => {
    const claude = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("claudeAgent")];
    expect(claude).toBeDefined();

    // The key list above would pass on a field whose options never reached the
    // renderer, which is exactly how `folder` behaves today. The renderer
    // branches on `options` being present, so that is what has to be asserted.
    const outputStyle = deriveProviderSettingsFields(claude!).find(
      (field) => field.key === "outputStyle",
    );
    expect(outputStyle?.options?.map((option) => option.value)).toEqual([
      "",
      ...CLAUDE_OUTPUT_STYLES,
    ]);
    expect(outputStyle?.options?.map((option) => option.label)).toEqual([
      "Use ~/.claude/settings.json",
      ...CLAUDE_OUTPUT_STYLES,
    ]);
    expect(outputStyle?.clearWhenEmpty).toBe("omit");
  });

  it("shows the empty choice for a stored value that is not on the list", () => {
    const claude = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("claudeAgent")];
    const outputStyle = deriveProviderSettingsFields(claude!).find(
      (field) => field.key === "outputStyle",
    );
    expect(outputStyle).toBeDefined();

    // The config blob is `Schema.Unknown`, so a hand-edited file or one written
    // by a build with more choices can hold a value this build does not offer.
    // A native select renders nothing selected for that, which reads as unset
    // while the blob still holds the old value.
    expect(selectedOptionValue({ outputStyle: "Explanatory" }, outputStyle!)).toBe("Explanatory");
    expect(selectedOptionValue({ outputStyle: "Creative" }, outputStyle!)).toBe("");
    expect(selectedOptionValue({}, outputStyle!)).toBe("");
    // Matched on value, not label. The empty row is the only option whose label
    // differs from its value, so it is the only case that can tell them apart.
    expect(selectedOptionValue({ outputStyle: "Use ~/.claude/settings.json" }, outputStyle!)).toBe(
      "",
    );
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("reads non-string config values as blank strings", () => {
    expect(readProviderConfigString({ binaryPath: 123 }, "binaryPath")).toBe("");
  });

  it("omits false boolean fields when clearWhenEmpty is omit", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: true },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: false,
      },
      false,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits true boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: false },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      true,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("preserves false boolean fields when clearWhenEmpty is persist", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "persist",
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("reads non-boolean config values as false booleans", () => {
    expect(readProviderConfigBoolean({ experimental: "true" }, "experimental")).toBe(false);
  });

  it("reads missing boolean config values from the supplied default", () => {
    expect(readProviderConfigBoolean({}, "experimental", true)).toBe(true);
  });
});
