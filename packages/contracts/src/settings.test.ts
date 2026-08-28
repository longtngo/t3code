import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClaudeSettings,
  CLAUDE_OUTPUT_STYLES,
  DEFAULT_SERVER_SETTINGS,
  optionalOneOfPattern,
  defaultEnabledForDriver,
  resolveClaudeAutoCompactWindow,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

describe("ClaudeSettings auto-compaction", () => {
  it("uses Claude's default threshold when no override is configured", () => {
    expect(decodeClaudeSettings({}).autoCompactWindow).toBe("");
  });

  it.each(["100000", "300000", "1000000", "10%", "60%", "100%"])(
    "accepts a supported auto-compaction threshold: %s",
    (value) => {
      expect(decodeClaudeSettings({ autoCompactWindow: value }).autoCompactWindow).toBe(value);
    },
  );

  it.each(["99999", "1000001", "300k", "invalid", "60", "0%", "101%", "%60"])(
    "recovers to Claude's default rather than failing the document: %s",
    (value) => {
      // Deliberately NOT a throw. This schema decodes the whole settings file,
      // and `loadSettingsFromDisk` answers a failure by keeping the defaults
      // and writing them back on the next unrelated change — so one unreadable
      // value here would cost every provider path, every custom instance and
      // the local-model config, permanently.
      //
      // That containment is what lets the accepted set above change at all: a
      // value a newer build writes (a percentage) has to be survivable by an
      // older one, and a rollback is enough to make that happen.
      expect(decodeClaudeSettings({ autoCompactWindow: value }).autoCompactWindow).toBe("");
    },
  );

  it.each(["99999", "300k", "60", "0%", "101%"])(
    "still rejects an unsupported threshold at the patch boundary: %s",
    (value) => {
      // Strict where it can report: a bad value fails only the update that
      // introduced it, so it never reaches the file in the first place.
      expect(() =>
        decodeServerSettingsPatch({ providers: { claudeAgent: { autoCompactWindow: value } } }),
      ).toThrow();
    },
  );

  it("keeps the rest of the file when one provider value is unreadable", () => {
    const decoded = decodeServerSettings({
      providers: {
        claudeAgent: { autoCompactWindow: "60", binaryPath: "/custom/claude" },
      },
    });
    expect(decoded.providers.claudeAgent.autoCompactWindow).toBe("");
    expect(decoded.providers.claudeAgent.binaryPath).toBe("/custom/claude");
  });

  it("rejects an unsupported threshold at the settings patch boundary", () => {
    expect(() =>
      decodeServerSettingsPatch({ providers: { claudeAgent: { autoCompactWindow: "300k" } } }),
    ).toThrow();
    expect(
      decodeServerSettingsPatch({ providers: { claudeAgent: { autoCompactWindow: "300000" } } }),
    ).toBeDefined();
  });
});

describe("ClaudeSettings output style", () => {
  it("sends no style when none is configured", () => {
    expect(decodeClaudeSettings({}).outputStyle).toBe("");
  });

  it.each([...CLAUDE_OUTPUT_STYLES])("accepts a built-in output style: %s", (value) => {
    expect(decodeClaudeSettings({ outputStyle: value }).outputStyle).toBe(value);
  });

  it("trims a padded style rather than discarding it", () => {
    expect(decodeClaudeSettings({ outputStyle: "  Concise  " }).outputStyle).toBe("Concise");
  });

  it.each(["concise", "CONCISE", "NoSuchStyleXyz", "Creative", "custom"])(
    "recovers an unknown style to no style rather than failing the document: %s",
    (value) => {
      // Same containment as `autoCompactWindow`, and the two blobs this schema
      // decodes fail differently without it: the legacy `providers.claudeAgent`
      // blob takes the whole settings file down (which `loadSettingsFromDisk`
      // answers by reverting to defaults), while `providerInstances.*.config`
      // marks the Claude instance unavailable. Both are worse than "no style".
      expect(decodeClaudeSettings({ outputStyle: value }).outputStyle).toBe("");
    },
  );

  it("keeps the rest of the file when the style is unreadable", () => {
    const decoded = decodeServerSettings({
      providers: {
        claudeAgent: { outputStyle: "Creative", binaryPath: "/custom/claude" },
      },
    });
    expect(decoded.providers.claudeAgent.outputStyle).toBe("");
    expect(decoded.providers.claudeAgent.binaryPath).toBe("/custom/claude");
  });

  it.each(["concise", "NoSuchStyleXyz", "custom"])(
    "rejects an unknown style at the patch boundary: %s",
    (value) => {
      // Guards a hand-written patch and the legacy blob. It is NOT what guards
      // the settings form, which writes an instance `config` blob typed as
      // `Schema.Unknown` — the form's dropdown is what does that.
      expect(() =>
        decodeServerSettingsPatch({ providers: { claudeAgent: { outputStyle: value } } }),
      ).toThrow();
    },
  );

  it("anchors a choice containing pattern syntax to itself", () => {
    // Quoting is a no-op for today's four names, which is the whole hazard: no
    // test built from the real list can tell a quoted pattern from an unquoted
    // one, so the pattern builder is tested on a choice that can.
    const pattern = optionalOneOfPattern(["Concise.v2"]);
    expect(pattern.test("Concise.v2")).toBe(true);
    expect(pattern.test("ConciseXv2")).toBe(false);
    expect(pattern.test("")).toBe(true);
    expect(pattern.test("Concise")).toBe(false);
  });

  it.each(["", ...CLAUDE_OUTPUT_STYLES])(
    "accepts a selectable style at the patch boundary: %s",
    (value) => {
      // Every style the form can offer, so a narrowed pattern that admits only one of
      // them cannot pass.
      expect(
        decodeServerSettingsPatch({ providers: { claudeAgent: { outputStyle: value } } }),
      ).toBeDefined();
    },
  );
});

describe("ClientSettings word wrap", () => {
  it("defaults word wrap on", () => {
    expect(decodeClientSettings({}).wordWrap).toBe(true);
  });

  it("ignores obsolete wrapping preferences", () => {
    const decoded = decodeClientSettings({
      chatWordWrap: false,
      diffWordWrap: false,
    });

    expect(decoded.wordWrap).toBe(true);
    expect(decoded).not.toHaveProperty("chatWordWrap");
    expect(decoded).not.toHaveProperty("diffWordWrap");
  });
});

describe("ClientSettings glass opacity", () => {
  it("defaults to a readable translucent surface", () => {
    expect(decodeClientSettings({}).glassOpacity).toBe(80);
  });

  it.each([39, 101, 72.5])("rejects an invalid glass opacity: %s", (value) => {
    expect(() => decodeClientSettings({ glassOpacity: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ glassOpacity: value })).toThrow();
  });

  it.each([40, 75, 100])("accepts a glass opacity within the supported range: %s", (value) => {
    expect(decodeClientSettings({ glassOpacity: value }).glassOpacity).toBe(value);
    expect(decodeClientSettingsPatch({ glassOpacity: value }).glassOpacity).toBe(value);
  });
});

describe("ClientSettings appearance contrast", () => {
  it("defaults to the theme's original contrast", () => {
    expect(decodeClientSettings({}).appearanceContrast).toBe(100);
  });

  it.each([49, 201, 92.5])("rejects an invalid appearance contrast: %s", (value) => {
    expect(() => decodeClientSettings({ appearanceContrast: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ appearanceContrast: value })).toThrow();
  });

  it.each([50, 100, 150, 200])("accepts an appearance contrast in range: %s", (value) => {
    expect(decodeClientSettings({ appearanceContrast: value }).appearanceContrast).toBe(value);
    expect(decodeClientSettingsPatch({ appearanceContrast: value }).appearanceContrast).toBe(value);
  });
});

describe("ClientSettings environment identification", () => {
  it("defaults to artwork and accepts each presentation mode", () => {
    expect(decodeClientSettings({}).environmentIdentificationMode).toBe("artwork");

    for (const mode of ["artwork", "pill", "none"] as const) {
      expect(
        decodeClientSettingsPatch({ environmentIdentificationMode: mode })
          .environmentIdentificationMode,
      ).toBe(mode);
    }
  });

  it("rejects unsupported presentation modes", () => {
    expect(() => decodeClientSettings({ environmentIdentificationMode: "badge" })).toThrow();
    expect(() => decodeClientSettingsPatch({ environmentIdentificationMode: "badge" })).toThrow();
  });
});

describe("ClientSettings composer context strip", () => {
  // Existing installs have no such key, and the strip has always been visible.
  // Anything but `false` here would collapse it for every user on upgrade.
  it("leaves the strip expanded for anyone who has never touched the toggle", () => {
    expect(decodeClientSettings({}).composerContextStripCollapsed).toBe(false);
  });

  it("preserves an explicit collapse through both the settings and patch schemas", () => {
    expect(
      decodeClientSettings({ composerContextStripCollapsed: true }).composerContextStripCollapsed,
    ).toBe(true);
    expect(
      decodeClientSettingsPatch({ composerContextStripCollapsed: true })
        .composerContextStripCollapsed,
    ).toBe(true);
  });
});

describe("ClientSettings sidebar", () => {
  it("defaults to the current sidebar with automatic merge and inactivity settling", () => {
    const settings = decodeClientSettings({});
    expect(settings.legacySidebarEnabled).toBe(false);
    expect(settings.sidebarAutoSettleAfterDays).toBe(3);
    expect(settings.sidebarAutoSettleOnMerge).toBe(true);
  });

  it("drops the retired sidebar v2 beta keys, resetting everyone to the default", () => {
    const decoded = decodeClientSettings({
      sidebarV2Enabled: false,
      sidebarV2ConfiguredByUser: true,
    });
    expect(decoded.legacySidebarEnabled).toBe(false);
    expect(decoded).not.toHaveProperty("sidebarV2Enabled");
    expect(decoded).not.toHaveProperty("sidebarV2ConfiguredByUser");
  });

  it("preserves an explicit legacy sidebar opt-in", () => {
    expect(decodeClientSettings({ legacySidebarEnabled: true }).legacySidebarEnabled).toBe(true);
    expect(decodeClientSettingsPatch({ legacySidebarEnabled: true }).legacySidebarEnabled).toBe(
      true,
    );
  });

  it("allows auto-settle by inactivity to be disabled", () => {
    expect(
      decodeClientSettings({ sidebarAutoSettleAfterDays: null }).sidebarAutoSettleAfterDays,
    ).toBeNull();
  });

  it("allows auto-settle on merge to be disabled", () => {
    expect(decodeClientSettings({ sidebarAutoSettleOnMerge: false }).sidebarAutoSettleOnMerge).toBe(
      false,
    );
    expect(
      decodeClientSettingsPatch({ sidebarAutoSettleOnMerge: false }).sidebarAutoSettleOnMerge,
    ).toBe(false);
  });

  it.each([-1, 0, 91])("rejects an auto-settle threshold outside 1..90: %s", (value) => {
    expect(() => decodeClientSettings({ sidebarAutoSettleAfterDays: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ sidebarAutoSettleAfterDays: value })).toThrow();
  });
});

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
  it("defaults text generation to Luna at low reasoning effort", () => {
    expect(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
  });

  it("defaults to an empty record so legacy configs without the key still decode", () => {
    expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
  });

  it("decodes a fully empty config (legacy on-disk shape) without complaint", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providerInstances).toEqual({});
    // Legacy `providers` struct is still hydrated with its per-driver defaults
    // so existing call sites keep working through the migration.
    expect(decoded.providers.codex.enabled).toBe(true);
  });

  it("decodes a multi-instance map mixing first-party and fork drivers", () => {
    const decoded = decodeServerSettings({
      providerInstances: {
        codex_personal: {
          driver: "codex",
          displayName: "Codex (personal)",
          config: { homePath: "~/.codex_personal" },
        },
        codex_work: {
          driver: "codex",
          config: { homePath: "~/.codex_work" },
        },
        ollama_local: {
          driver: "ollama",
          displayName: "Ollama (local)",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const personalId = ProviderInstanceId.make("codex_personal");
    const workId = ProviderInstanceId.make("codex_work");
    const ollamaId = ProviderInstanceId.make("ollama_local");

    expect(decoded.providerInstances[personalId]?.driver).toBe("codex");
    expect(decoded.providerInstances[workId]?.config).toEqual({ homePath: "~/.codex_work" });
    // Critical: a config naming a driver this build does not know about
    // (`ollama` is not in `ProviderDriverKind`) must round-trip without loss.
    // The runtime handles "driver not installed" — the schema must not.
    expect(decoded.providerInstances[ollamaId]?.driver).toBe("ollama");
    expect(decoded.providerInstances[ollamaId]?.config).toEqual({
      endpoint: "http://localhost:11434",
    });
  });

  it("rejects instance keys that violate the slug pattern", () => {
    expect(() =>
      decodeServerSettings({
        providerInstances: { "1bad": { driver: "codex" } },
      }),
    ).toThrow();
  });
});

describe("provider enabled defaults", () => {
  it("enables only the stable bindings by default", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providers.codex.enabled).toBe(true);
    expect(decoded.providers.claudeAgent.enabled).toBe(true);
    expect(decoded.providers.cursor.enabled).toBe(false);
    expect(decoded.providers.grok.enabled).toBe(false);
    expect(decoded.providers.opencode.enabled).toBe(false);
  });

  it("derives per-driver defaults from the settings schemas", () => {
    expect(defaultEnabledForDriver(ProviderDriverKind.make("codex"))).toBe(true);
    expect(defaultEnabledForDriver(ProviderDriverKind.make("cursor"))).toBe(false);
    expect(defaultEnabledForDriver(ProviderDriverKind.make("grok"))).toBe(false);
    // Unknown fork drivers stay enabled; their own build decides otherwise.
    expect(defaultEnabledForDriver(ProviderDriverKind.make("ollama"))).toBe(true);
  });

  it("keeps Cursor enabled when an existing user explicitly opted in", () => {
    const cursor = ProviderDriverKind.make("cursor");
    const cursorId = ProviderInstanceId.make("cursor");
    const decoded = decodeServerSettings({
      providers: { cursor: { enabled: true } },
      providerInstances: {
        [cursorId]: { driver: cursor, enabled: true, config: {} },
      },
    });

    expect(decoded.providers.cursor.enabled).toBe(true);
    expect(resolveProviderInstanceEnabled(decoded.providerInstances[cursorId]!)).toBe(true);
  });

  it("resolves instance enabled state with explicit false winning", () => {
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    // No flags anywhere: driver default applies.
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    // Envelope flag wins over the driver default.
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    // Legacy in-config flag fills in when the envelope is silent.
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    // Conflicting flags: the explicit false wins, whichever side it is on.
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults start-from-origin on for legacy configs", () => {
    expect(decodeServerSettings({}).newWorktreesStartFromOrigin).toBe(true);
  });

  it("accepts start-from-origin updates", () => {
    expect(
      decodeServerSettingsPatch({ newWorktreesStartFromOrigin: false }).newWorktreesStartFromOrigin,
    ).toBe(false);
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it("defaults all style settings for legacy configs", () => {
    const settings = decodeServerSettings({});

    expect(settings.sourceControlWritingStyle).toEqual({
      mode: "repo_conventions",
      customInstructions: "",
      followChangeRequestTemplates: true,
    });
    expect(settings.sourceControlWriterModelSelection).toBeNull();
  });

  it("trims partial style updates", () => {
    const patch = decodeServerSettingsPatch({
      sourceControlWritingStyle: {
        mode: "custom",
        customInstructions: "  Prefer concise wording.  ",
      },
    });

    expect(patch.sourceControlWritingStyle).toEqual({
      mode: "custom",
      customInstructions: "Prefer concise wording.",
    });
  });
});

describe("ServerSettingsPatch.providerInstances", () => {
  it("treats providerInstances as an optional whole-map replacement", () => {
    const patch = decodeServerSettingsPatch({});
    expect(patch.providerInstances).toBeUndefined();

    const replacement = decodeServerSettingsPatch({
      providerInstances: {
        codex_personal: { driver: "codex", config: { homePath: "~/.codex" } },
      },
    });
    expect(replacement.providerInstances).toBeDefined();
    expect(replacement.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
  });

  it("preserves a fork-defined driver entry through patch decoding", () => {
    const patch = decodeServerSettingsPatch({
      providerInstances: {
        ollama_local: {
          driver: "ollama",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const ollamaId = ProviderInstanceId.make("ollama_local");
    expect(patch.providerInstances?.[ollamaId]?.driver).toBe("ollama");
  });
});

describe("ServerSettingsPatch string normalization", () => {
  it("trims string settings while decoding patches", () => {
    const patch = decodeServerSettingsPatch({
      addProjectBaseDirectory: "  ~/Development  ",
      textGenerationModelSelection: { model: "  gpt-5.4-mini  " },
      observability: {
        otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
      },
      providers: {
        codex: {
          binaryPath: "  /opt/homebrew/bin/codex  ",
          homePath: "  ~/.codex  ",
          launchArgs: "  --strict-config --enable foo  ",
        },
      },
      providerInstances: {
        codex_personal: {
          driver: "  codex  ",
          displayName: "  Codex Personal  ",
          config: { homePath: "  ~/.codex-personal  " },
        },
      },
    });

    expect(patch.addProjectBaseDirectory).toBe("~/Development");
    expect(patch.textGenerationModelSelection?.model).toBe("gpt-5.4-mini");
    expect(patch.observability?.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
    expect(patch.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(patch.providers?.codex?.homePath).toBe("~/.codex");
    expect(patch.providers?.codex?.launchArgs).toBe("--strict-config --enable foo");
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.displayName).toBe(
      "Codex Personal",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.config).toEqual({
      homePath: "  ~/.codex-personal  ",
    });
  });

  it("trims encoded server settings values before validation", () => {
    const defaultSettings = decodeServerSettings({});
    const encoded = encodeServerSettings({
      ...defaultSettings,
      addProjectBaseDirectory: "  ~/Development  ",
      providers: {
        ...defaultSettings.providers,
        codex: {
          ...defaultSettings.providers.codex,
          binaryPath: "  /opt/homebrew/bin/codex  ",
          launchArgs: "  --strict-config  ",
        },
      },
    });

    expect(encoded.addProjectBaseDirectory).toBe("~/Development");
    expect(encoded.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(encoded.providers?.codex?.launchArgs).toBe("--strict-config");
  });
});

describe("ServerSettings notification categories", () => {
  it("defaults every category on, so behavior is unchanged until the user opts out", () => {
    expect(decodeServerSettings({}).notificationCategories).toEqual({
      finished: true,
      finishedBackground: true,
      needsInput: true,
      failed: true,
    });
  });

  it("fills absent categories when a settings file predates the field", () => {
    // The real settings.json on an existing install has no notificationCategories key.
    const decoded = decodeServerSettings({
      addProjectBaseDirectory: "~/src",
      enableProviderUpdateChecks: false,
    });

    expect(decoded.notificationCategories.finished).toBe(true);
    expect(decoded.notificationCategories.finishedBackground).toBe(true);
    expect(decoded.notificationCategories.needsInput).toBe(true);
    expect(decoded.notificationCategories.failed).toBe(true);
  });

  it("keeps sibling categories on when only one is turned off", () => {
    const decoded = decodeServerSettings({ notificationCategories: { finished: false } });

    expect(decoded.notificationCategories).toEqual({
      finished: false,
      finishedBackground: true,
      needsInput: true,
      failed: true,
    });
  });

  it("accepts a single-category patch without carrying siblings", () => {
    const patch = decodeServerSettingsPatch({ notificationCategories: { finished: false } });

    // A patch must NOT materialize defaults: deepMerge would then reset the
    // siblings the user never touched.
    expect(patch.notificationCategories).toEqual({ finished: false });
  });

  it("exposes the defaults through DEFAULT_SERVER_SETTINGS for the fail-open path", () => {
    expect(DEFAULT_SERVER_SETTINGS.notificationCategories).toEqual({
      finished: true,
      finishedBackground: true,
      needsInput: true,
      failed: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Schema / patch mirror parity
// ---------------------------------------------------------------------------

/**
 * Every settings struct has a hand-written `*Patch` mirror, and the RPC decodes
 * edits through the mirror. A field present in the schema but absent from the
 * mirror is therefore silently dropped on save — no error, no warning, nothing
 * persisted. That has already shipped twice.
 *
 * Walk `ast.propertySignatures` directly on each node: `.fields` is erased by
 * `withDecodingDefault`, and following `ast.encoding[0].to` lands on a Union
 * with no property signatures, so a walker that does either passes vacuously.
 */
function schemaPropertySignatures(
  ast: unknown,
): ReadonlyArray<{ name: PropertyKey; type: unknown }> {
  const candidate = (
    ast as { propertySignatures?: ReadonlyArray<{ name: PropertyKey; type: unknown }> }
  )?.propertySignatures;
  return candidate ?? [];
}

function fieldsMissingFromMirror(
  schemaAst: unknown,
  mirrorAst: unknown,
  path: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  const mirrorByName = new Map(
    schemaPropertySignatures(mirrorAst).map((property) => [String(property.name), property]),
  );
  return schemaPropertySignatures(schemaAst).flatMap((property) => {
    const name = String(property.name);
    const here = [...path, name];
    const counterpart = mirrorByName.get(name);
    return counterpart === undefined
      ? [here.join(".")]
      : fieldsMissingFromMirror(property.type, counterpart.type, here);
  });
}

describe("settings schema / patch parity", () => {
  it("walks nested structs rather than passing vacuously", () => {
    // Guards the guard: if the AST shape changes and the walker stops seeing
    // properties, every assertion below would pass while checking nothing.
    expect(
      schemaPropertySignatures((ServerSettings as unknown as { ast: unknown }).ast).length,
    ).toBeGreaterThan(10);
  });

  it("mirrors every ServerSettings field in ServerSettingsPatch", () => {
    const deliberatelyUnpatchable = [
      // Read once at startup as a privilege-escalation guard; deliberately not
      // editable over the settings RPC. See ServerSettingsPatch's own comment.
      "disableAuthentication",
    ];

    expect(
      [
        ...fieldsMissingFromMirror(
          (ServerSettings as unknown as { ast: unknown }).ast,
          (ServerSettingsPatch as unknown as { ast: unknown }).ast,
        ),
      ].sort(),
    ).toEqual([...deliberatelyUnpatchable].sort());
  });
});

describe("ClaudeSettingsPatch config directory", () => {
  it("keeps configDirPath through a patch instead of silently dropping it", () => {
    // The RPC decodes edits through the patch mirror, so a field missing from it
    // never reaches disk. This one was missing, which made "Reset to defaults"
    // unable to clear a custom Claude config directory.
    const patch = decodeServerSettingsPatch({
      providers: { claudeAgent: { configDirPath: "~/.claude-personal", homePath: "/x" } },
    });

    expect(patch.providers?.claudeAgent?.configDirPath).toBe("~/.claude-personal");
    expect(patch.providers?.claudeAgent?.homePath).toBe("/x");
  });
});

describe("resolveClaudeAutoCompactWindow", () => {
  it("passes a token count through, clamped to Claude Code's accepted range", () => {
    expect(resolveClaudeAutoCompactWindow("600000", 1_000_000)).toBe(600_000);
    expect(resolveClaudeAutoCompactWindow("100000", 200_000)).toBe(100_000);
  });

  it("resolves a percentage against the selected model's window", () => {
    expect(resolveClaudeAutoCompactWindow("60%", 1_000_000)).toBe(600_000);
    expect(resolveClaudeAutoCompactWindow("100%", 200_000)).toBe(200_000);
  });

  it("clamps a percentage up to Claude Code's minimum instead of being discarded", () => {
    // 30% of a 200k model is 60,000, under the CLI's own `.min(1e5)`. It
    // validates this key with `.catch(void 0)`, which is a SILENT discard, and
    // a discarded window leaves the source classified "auto" — the one state
    // where the CLI refuses to compact at all.
    expect(resolveClaudeAutoCompactWindow("30%", 200_000)).toBe(100_000);
  });

  it("clamps above Claude Code's maximum for the same reason", () => {
    expect(resolveClaudeAutoCompactWindow("100%", 2_000_000)).toBe(1_000_000);
  });

  it("says nothing when there is nothing to say", () => {
    expect(resolveClaudeAutoCompactWindow("", 1_000_000)).toBeUndefined();
    expect(resolveClaudeAutoCompactWindow(undefined, 1_000_000)).toBeUndefined();
    expect(resolveClaudeAutoCompactWindow("   ", 1_000_000)).toBeUndefined();
  });

  it("cannot resolve a percentage without a window, and does not guess one", () => {
    expect(resolveClaudeAutoCompactWindow("60%", undefined)).toBeUndefined();
    expect(resolveClaudeAutoCompactWindow("60%", 0)).toBeUndefined();
  });

  it("returns nothing for a value it cannot parse, so the caller's default runs", () => {
    // The caller distinguishes this from a configured value: `Number("60%")` is
    // NaN, and a truthiness check on the raw string would let an unresolvable
    // setting suppress the 1M fallback and send no window at all.
    expect(resolveClaudeAutoCompactWindow("nonsense", 1_000_000)).toBeUndefined();
    expect(resolveClaudeAutoCompactWindow("-5", 1_000_000)).toBeUndefined();
  });
});
