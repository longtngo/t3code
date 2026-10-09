import { describe, expect, it } from "vite-plus/test";
import { CLAUDE_OUTPUT_STYLES, ProviderDriverKind } from "@t3tools/contracts";

import { providerClients } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  selectedOptionValue,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("derives visible provider config fields from the client definition schema", () => {
    const codex = providerClients.get(ProviderDriverKind.make("codex"));

    expect(codex).toBeDefined();
    expect(deriveProviderSettingsFields(codex!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "shadowHomePath",
      "launchArgs",
    ]);
  });

  it("sources labels and descriptions from schema annotations", () => {
    const opencode = providerClients.get(ProviderDriverKind.make("opencode"));
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

  it("uses a dedicated environment field instead of legacy Cursor CLI settings", () => {
    const cursor = providerClients.get(ProviderDriverKind.make("cursor"));

    expect(cursor).toBeDefined();
    expect(deriveProviderSettingsFields(cursor!)).toEqual([]);
    expect(cursor?.environmentFields).toEqual([
      {
        name: "CURSOR_API_KEY",
        label: "Cursor API key",
        description: "Optional. Overrides browser sign-in for this provider.",
        placeholder: "Paste API key",
        sensitive: true,
      },
    ]);
  });

  it("exposes ACP Registry as an instance-only configurable driver", () => {
    const acpRegistry = providerClients.get(ProviderDriverKind.make("acpRegistry"));

    expect(acpRegistry).toBeDefined();
    expect(acpRegistry?.hasDefaultInstance).toBe(false);
    expect(deriveProviderSettingsFields(acpRegistry!).map((field) => field.key)).toEqual([
      "source",
      "agentId",
      "commandPath",
      "authMethodId",
    ]);
  });

  it("shows the local executable without registry identity or authentication fields", () => {
    const acpRegistry = providerClients.get(ProviderDriverKind.make("acpRegistry"));
    expect(
      deriveProviderSettingsFields(acpRegistry!, { source: "local" }).map((field) => field.key),
    ).toEqual(["source", "commandPath"]);
  });

  it("derives a select control with its choices for the Antigravity sign-in method", () => {
    const antigravity = providerClients.get(ProviderDriverKind.make("antigravity"));
    expect(antigravity).toBeDefined();

    const fields = deriveProviderSettingsFields(antigravity!);
    expect(fields.map((field) => field.key)).toEqual([
      "authMethod",
      "apiKey",
      "gcpProject",
      "gcpLocation",
      "binaryPath",
    ]);
    const authMethod = fields.find((field) => field.key === "authMethod");
    expect(authMethod).toMatchObject({ control: "select", clearWhenEmpty: "omit" });
    expect(authMethod?.options?.map((option) => option.value)).toEqual([
      "oauth-personal",
      "oauth-business",
      "gemini-api-key",
      "agent-platform",
    ]);
    expect(fields.find((field) => field.key === "apiKey")?.control).toBe("password");
  });

  it("shows the auto-compaction threshold for Claude providers", () => {
    const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"));
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
    const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"));
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
    const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"));
    const outputStyle = deriveProviderSettingsFields(claude!).find(
      (field) => field.key === "outputStyle",
    );
    expect(outputStyle).toBeDefined();

    // The config blob is `Schema.Unknown`, so a hand-edited file or one written
    // by a build with more choices can hold a value this build does not offer.
    // The dropdown shows the clear row for that, which for `outputStyle` is what
    // the driver will do: `catchDecoding` recovers an unreadable value at spawn.
    expect(selectedOptionValue({ outputStyle: "Explanatory" }, outputStyle!)).toBe("Explanatory");
    expect(selectedOptionValue({ outputStyle: "Creative" }, outputStyle!)).toBe("");
    expect(selectedOptionValue({}, outputStyle!)).toBe("");
    // Matched on value, not label. The empty row is the only option whose label
    // differs from its value, so it is the only case that can tell them apart.
    expect(selectedOptionValue({ outputStyle: "Use ~/.claude/settings.json" }, outputStyle!)).toBe(
      "",
    );
  });

  it("writes a chosen style and omits the key for the clear row, for both select fields", () => {
    const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"));
    const outputStyle = deriveProviderSettingsFields(claude!).find(
      (field) => field.key === "outputStyle",
    )!;
    // The dropdown maps "picked the first row" to "" before calling this, so the
    // first row and an explicit "" both omit the key.
    expect(
      nextProviderConfigWithFieldValue({ binaryPath: "claude" }, outputStyle, "Concise"),
    ).toEqual({ binaryPath: "claude", outputStyle: "Concise" });
    expect(
      nextProviderConfigWithFieldValue(
        { binaryPath: "claude", outputStyle: "Concise" },
        outputStyle,
        "",
      ),
    ).toEqual({ binaryPath: "claude" });

    const antigravity = providerClients.get(ProviderDriverKind.make("antigravity"));
    const authMethod = deriveProviderSettingsFields(antigravity!).find(
      (field) => field.key === "authMethod",
    )!;
    expect(authMethod.options?.[0]?.value).not.toBe("");
    // An all-empty config collapses to no config at all.
    expect(nextProviderConfigWithFieldValue({}, authMethod, "")).toBeUndefined();
    expect(nextProviderConfigWithFieldValue({}, authMethod, authMethod.options![1]!.value)).toEqual(
      { authMethod: authMethod.options![1]!.value },
    );
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = providerClients.get(ProviderDriverKind.make("opencode"));
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
});
