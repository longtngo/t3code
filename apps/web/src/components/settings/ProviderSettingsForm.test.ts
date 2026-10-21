import { describe, expect, it } from "vite-plus/test";
import {
  CLAUDE_OUTPUT_STYLES,
  makeProviderSettingsSchema,
  ProviderDriverKind,
  TrimmedString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { providerClients } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  selectedOptionValue,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("keeps every masked field as a stored secret", () => {
    const settingsSchema = makeProviderSettingsSchema({
      token: TrimmedString.pipe(
        Schema.annotateKey({ providerSettingsForm: { control: "password" } }),
      ),
    });

    expect(deriveProviderSettingsFields({ settingsSchema })).toMatchObject([
      { key: "token", secret: true },
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
});
