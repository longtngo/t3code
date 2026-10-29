import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { type CommandId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClaudeSettings,
  CLAUDE_OUTPUT_STYLES,
  DEFAULT_SERVER_SETTINGS,
  globalIdleCompaction,
  idleCompactionPatch,
  optionalOneOfPattern,
  requiredScopesForProjectMutation,
  resolveClaudeAutoCompactWindow,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
  subagentBackendThreadMode,
  withIdleCompaction,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
const decodeTypedServerSettings = Schema.decodeSync(ServerSettings);
const decodeTypedServerSettingsPatch = Schema.decodeSync(ServerSettingsPatch);

describe("storage cleanup settings", () => {
  it("keeps cleanup disabled for existing installations", () => {
    expect(decodeServerSettings({}).worktreeCleanup).toBeNull();
    expect(decodeServerSettings({}).storageCleanup).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    });
  });

  it("accepts partial custom patches but requires complete stored project rules", () => {
    expect(
      decodeServerSettingsPatch({
        worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } },
      }),
    ).toEqual({ worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } });
    expect(() =>
      decodeServerSettings({
        projectSettingsOverrides: {
          project: { worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } },
        },
      }),
    ).toThrow();
    expect(
      decodeServerSettings({
        projectSettingsOverrides: {
          project: {
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: null,
                worktreeOnMerge: false,
                worktreeOnDelete: false,
                worktreeUnchanged: false,
              },
            },
          },
        },
      }).projectSettingsOverrides[ProjectId.make("project")]?.worktreeCleanup,
    ).toMatchObject({
      mode: "custom",
      rules: { worktreeSettledAfterDays: null, worktreeKeepWhen: "uncommitted-changes" },
    });
  });

  it("decodes older custom rules with the default local-file policy", () => {
    const settings = decodeServerSettings({
      worktreeCleanup: {
        mode: "custom",
        rules: {
          worktreeAfterDays: 8,
          worktreeOnMerge: false,
          worktreeOnDelete: false,
          worktreeUnchanged: false,
        },
      },
    });
    expect(settings.worktreeCleanup).toMatchObject({
      rules: { worktreeKeepWhen: "uncommitted-changes" },
    });
    expect(
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } }),
    ).toEqual({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } });
    expect(() =>
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "unknown" } }),
    ).toThrow();
  });
});

describe("ServerSettings usage price overrides", () => {
  const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };

  it("rejects empty model IDs and incomplete input/output pricing", () => {
    for (const usagePriceOverrides of [
      { " ": prices },
      { "example-model": { inputCostPerMillionTokens: 2 } },
      { "example-model": { outputCostPerMillionTokens: 8 } },
    ]) {
      expect(() => decodeServerSettingsPatch({ usagePriceOverrides })).toThrow();
    }
  });
});

describe("custom model settings", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
      },
    ],
  };

  it("accepts legacy bare slugs alongside full entries", () => {
    const decoded = decodeClaudeSettings({
      customModels: ["bare-slug", { slug: "named", name: "Named", capabilities }],
    });
    expect(decoded.customModels).toEqual([
      "bare-slug",
      { slug: "named", name: "Named", capabilities },
    ]);
  });
});

describe("resolveIdleCompaction", () => {
  it("lets a Claude instance override the global default", () => {
    const settings = decodeServerSettings({
      idleCompaction: "off",
      providerInstances: {
        claude_work: { driver: "claudeAgent", config: { idleCompaction: "onReturn" } },
        claude_personal: { driver: "claudeAgent" },
      },
    });
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_work"))).toBe(
      "onReturn",
    );
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_personal"))).toBe("off");
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claudeAgent"))).toBe("off");
  });

  it("reads the mode from the legacy switch, in either form servers saved it", () => {
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: true }))).toBe(
      "beforeCacheExpires",
    );
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: "off" }))).toBe("off");
    expect(globalIdleCompaction(decodeServerSettings({}))).toBe("onReturn");
  });

  it("keeps the legacy switch a boolean, as shipped clients decode it", () => {
    const encode = Schema.encodeSync(Schema.toCodecJson(ServerSettings));
    for (const mode of ["onReturn", "beforeCacheExpires", "off"] as const) {
      const encoded = encode(withIdleCompaction(DEFAULT_SERVER_SETTINGS, mode)) as {
        readonly compactIdleThreads: unknown;
        readonly idleCompaction: unknown;
      };
      expect(encoded.compactIdleThreads).toBe(mode === "beforeCacheExpires");
      expect(encoded.idleCompaction).toBe(mode);
    }
  });

  it("patches the field the server reads", () => {
    expect(
      idleCompactionPatch({ compactIdleThreads: false, idleCompaction: "onReturn" }, "off"),
    ).toEqual({
      idleCompaction: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: "onReturn" }, "off")).toEqual({
      compactIdleThreads: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: false }, "beforeCacheExpires")).toEqual({
      compactIdleThreads: true,
    });
  });
});

describe("ClientSettings notifications", () => {
  it("requires opt-in when existing settings omit notification preferences", () => {
    expect(decodeClientSettings({}).notificationMode).toBe("off");
    expect(decodeClientSettings({}).inAppNotificationsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("inAppNotificationsEnabled");
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("notificationMode");
  });
});

describe("ClientSettings quit confirmation", () => {
  it.each([
    [true, "hold"],
    [false, "direct"],
  ] as const)("migrates the legacy %s value to %s", (legacyValue, mode) => {
    const settings = decodeClientSettings({ confirmQuit: legacyValue });

    expect(settings.confirmQuit).toBe(mode);
    expect(encodeClientSettings(settings).confirmQuit).toBe(mode);
  });
});

describe("provider enabled defaults", () => {
  it("resolves instance enabled state with explicit false winning", () => {
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make("ollama"), config: {} }),
    ).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults the thread env mode to inherit and keeps stored values", () => {
    expect(decodeServerSettings({}).defaultThreadEnvMode).toBeNull();
    expect(decodeServerSettings({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe(
      "worktree",
    );
    expect(
      decodeServerSettings({ defaultThreadEnvMode: "remote" }).defaultThreadEnvMode,
    ).toBeNull();
    expect(
      decodeServerSettingsPatch({ defaultThreadEnvMode: null }).defaultThreadEnvMode,
    ).toBeNull();
  });

  it("keeps an inherited thread env mode off the wire for older clients", () => {
    const encode = Schema.encodeSync(ServerSettings);
    expect("defaultThreadEnvMode" in encode(decodeServerSettings({}))).toBe(false);
    expect(
      encode(decodeServerSettings({ defaultThreadEnvMode: "worktree" })).defaultThreadEnvMode,
    ).toBe("worktree");
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it.each([
    { legacy: "", mode: "repo_conventions", customInstructions: "" },
    { legacy: " \t\n ", mode: "repo_conventions", customInstructions: "" },
    {
      legacy: "  Prefer concise wording.\nKeep issue references.  ",
      mode: "custom",
      customInstructions: "Prefer concise wording.\nKeep issue references.",
    },
  ])("normalizes legacy writing style $legacy in snapshots only", ({ legacy, ...expected }) => {
    const style = { ...expected, followChangeRequestTemplates: true };
    for (const [input, normalized] of [
      [{ sourceControlWritingStyle: legacy }, { sourceControlWritingStyle: style }],
      [
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: legacy } } },
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: style } } },
      ],
    ] as const) {
      const settings = decodeServerSettings(input);
      expect(settings).toMatchObject(normalized);
      expect(encodeServerSettings(settings)).toMatchObject(normalized);
      expect(() => decodeServerSettingsPatch(input)).toThrow();
    }
  });
});

describe("ServerSettings environment icon", () => {
  it("decodes a kind from a newer server as null instead of failing the snapshot", () => {
    expect(decodeServerSettings({ environmentIcon: "toaster" }).environmentIcon).toBeNull();
  });
});

const decodeDeviceHostSettings = Schema.decodeSync(ServerSettings);

// `deviceHosts` as it was decoded before EAS hosts existed: an SSH host needs a target.
const decodeOlderDeviceHostSettings = Schema.decodeUnknownSync(
  Schema.Struct({
    deviceHosts: Schema.Array(Schema.Struct({ id: Schema.String, target: Schema.String })),
  }),
);

it("keeps EAS hosts out of the SSH host list servers and clients before EAS hosts decode", () => {
  const settings = decodeDeviceHostSettings({
    deviceHosts: [{ id: "mini", label: "Mac mini", target: "user@mini" }],
    easDeviceHosts: [{ kind: "eas", id: "eas", label: "EAS Simulator" }],
  });
  const wire = encodeServerSettings(settings);
  expect(decodeOlderDeviceHostSettings(wire).deviceHosts).toEqual([
    { id: "mini", target: "user@mini" },
  ]);
  expect(settings.easDeviceHosts.map((host) => host.id)).toEqual(["eas"]);
});

it("validates remote device hosts and rejects ambiguous host ids", () => {
  const host = { id: "mini", label: "Mac mini", target: "user@mini", port: 2222 };
  // Hosts saved before EAS hosts existed have no `kind`; they are SSH hosts.
  expect(decodeDeviceHostSettings({ deviceHosts: [host] }).deviceHosts).toEqual([
    { kind: "ssh", ...host },
  ]);
  expect(() => decodeDeviceHostSettings({ deviceHosts: [host, host] })).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, id: "local" }] })).toThrow();
  expect(() =>
    decodeDeviceHostSettings({ deviceHosts: [{ ...host, target: "-oProxyCommand=bad" }] }),
  ).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, port: 0 }] })).toThrow();
});

describe("resolveProjectProviderInstanceEnabled", () => {
  const projectId = "project-a" as ProjectId;
  const instanceId = ProviderInstanceId.make("codex_work");

  it("lets a project disable an instance the machine enabled", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)).toBe(false);
  });
});

describe("requiredScopesForProjectMutation", () => {
  it("adds the settings scope only when a mutation carries scripts", () => {
    const projectId = "project-1" as ProjectId;
    const commandId = "command-1" as CommandId;
    expect(
      requiredScopesForProjectMutation({ type: "project.update", commandId, projectId }),
    ).toEqual(["orchestration:operate"]);
    expect(
      requiredScopesForProjectMutation({
        type: "project.update",
        commandId,
        projectId,
        scripts: [],
      }),
    ).toEqual(["orchestration:operate", "settings:write"]);
  });
});

describe("server model preferences", () => {
  it("distinguishes unmigrated lists from deliberately cleared lists", () => {
    expect(decodeServerSettings({})).toMatchObject({
      favorites: null,
      providerModelPreferences: null,
    });
    const input = { favorites: [], providerModelPreferences: {} };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
  });
});

// FORK-owned settings tests (upstream pruned the upstream tests around them).
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
      // Not a throw: a failed settings-file decode makes `loadSettingsFromDisk` keep
      // the defaults and write them back, losing every unrelated setting. This
      // containment also lets an older build survive a value a newer one wrote.
      expect(decodeClaudeSettings({ autoCompactWindow: value }).autoCompactWindow).toBe("");
    },
  );
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
      // Same containment as `autoCompactWindow`: without it a bad value in
      // `providerInstances.*.config` marks the Claude instance unavailable,
      // which is worse than "no style".
      expect(decodeClaudeSettings({ outputStyle: value }).outputStyle).toBe("");
    },
  );

  it("renders as a select control with the clear row first", () => {
    const annotations =
      Schema.resolveAnnotationsKey(ClaudeSettings.fields.outputStyle) ??
      Schema.resolveAnnotations(ClaudeSettings.fields.outputStyle);
    const annotation = annotations?.providerSettingsForm;
    expect(annotation?.control).toBe("select");
    expect(annotation?.options?.[0]).toEqual({
      value: "",
      label: "Use ~/.claude/settings.json",
    });
  });

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
});

describe("ClientSettings composer context strip", () => {
  it("defaults to draft-only and accepts a persistent strip preference", () => {
    expect(decodeClientSettings({}).persistComposerContextStrip).toBe(false);
    expect(
      decodeClientSettingsPatch({ persistComposerContextStrip: true }).persistComposerContextStrip,
    ).toBe(true);
  });
});

describe("ClientSettings composer context strip collapse", () => {
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

describe("ClientSettings message timestamps", () => {
  it("keeps message timestamps on hover unless the user opts in", () => {
    expect(decodeClientSettings({}).alwaysShowMessageTimestamps).toBe(false);
    expect(
      decodeClientSettings({ alwaysShowMessageTimestamps: true }).alwaysShowMessageTimestamps,
    ).toBe(true);
    expect(
      decodeClientSettingsPatch({ alwaysShowMessageTimestamps: true }).alwaysShowMessageTimestamps,
    ).toBe(true);
  });
});

describe("ClientSettings context window meter", () => {
  // FORK: defaults ON. Upstream ships this off because it is retiring its own circular
  // indicator; here the switch governs the composer Vitals gauge's context ring.
  it("defaults on and preserves an explicit opt-out", () => {
    expect(decodeClientSettings({}).contextWindowMeterEnabled).toBe(true);
    expect(
      decodeClientSettings({ contextWindowMeterEnabled: false }).contextWindowMeterEnabled,
    ).toBe(false);
    expect(
      decodeClientSettingsPatch({ contextWindowMeterEnabled: true }).contextWindowMeterEnabled,
    ).toBe(true);
  });
});

describe("ServerSettings Jira link settings", () => {
  it("defaults the Jira link settings to empty and keeps what was typed", () => {
    expect(decodeServerSettings({}).jiraBaseUrl).toBe("");
    expect(decodeServerSettings({}).jiraProjectKeys).toBe("");
    const decoded = decodeServerSettings({
      jiraBaseUrl: " https://acme.atlassian.net ",
      jiraProjectKeys: "ops, DRST",
    });
    expect(decoded.jiraBaseUrl).toBe("https://acme.atlassian.net");
    expect(decoded.jiraProjectKeys).toBe("ops, DRST");
  });

  it("accepts Jira link settings in a patch", () => {
    expect(
      decodeTypedServerSettingsPatch({
        jiraBaseUrl: "https://x",
        jiraProjectKeys: "OPS",
      }),
    ).toEqual({ jiraBaseUrl: "https://x", jiraProjectKeys: "OPS" });
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

// Schema / patch mirror parity

// A schema field missing from its hand-written `*Patch` mirror is silently dropped
// on save. Walk `ast.propertySignatures` directly: `.fields` is erased by
// `withDecodingDefault` and `ast.encoding[0].to` is a Union with no signatures,
// so a walker using either passes vacuously.
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
      // The environment's default theme is owned by `t3 theme set`,
      // which rewrites settings.json directly (apps/server/src/cli/theme.ts) and
      // removes both keys when cleared. Clients only READ them, so routing them
      // through the patch RPC would give two writers for one pair of fields.
      "defaultTheme",
      "defaultThemeSetAt",
      // Upstream's one-time marker for the legacy per-project settings fold
      // (apps/server/src/serverSettings.ts). The server writes it once and reads
      // it on every load; a client patch would re-run or skip the migration.
      "projectSettingsFolded",
      // Upstream: maintained by the server when `worktreesDirectory` changes
      // (packages/shared/src/serverSettings.ts), never sent by a client.
      "previousWorktreesDirectories",
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

  it("mirrors every ClientSettings field in ClientSettingsPatch", () => {
    const deliberatelyUnpatchable: string[] = [];

    expect(
      [
        ...fieldsMissingFromMirror(
          (ClientSettingsSchema as unknown as { ast: unknown }).ast,
          (ClientSettingsPatch as unknown as { ast: unknown }).ast,
        ),
      ].sort(),
    ).toEqual([...deliberatelyUnpatchable].sort());
  });
});

describe("subagent offload settings", () => {
  it("defaults master on and thread modes empty", () => {
    expect(DEFAULT_SERVER_SETTINGS.subagentBackendEnabled).toBe(true);
    expect(DEFAULT_SERVER_SETTINGS.subagentBackendThreadModes).toEqual({});
  });

  it("decodes a settings file written before the fields existed", () => {
    const decoded = decodeTypedServerSettings({});
    expect(decoded.subagentBackendEnabled).toBe(true);
    expect(decoded.subagentBackendThreadModes).toEqual({});
  });

  it("degrades an undecodable value to the field default instead of failing the document", () => {
    // A mode a newer build wrote, or a hand-edited non-boolean master, must cost only its
    // own field: a failed `ServerSettings` decode makes `loadSettingsFromDisk` keep
    // DEFAULT_SERVER_SETTINGS and write them back, losing every unrelated setting.
    const decoded = decodeServerSettings({
      subagentBackendThreadModes: { t1: "on-with-model" },
      subagentBackendEnabled: "true",
      enableProviderUpdateChecks: false,
    });
    expect(decoded.subagentBackendThreadModes).toEqual({});
    expect(decoded.subagentBackendEnabled).toBe(true);
    expect(decoded.enableProviderUpdateChecks).toBe(false);
  });

  it("still rejects an unknown thread mode at the RPC boundary", () => {
    // Strict validation lives in the patch schema, where a bad value fails only the
    // update that introduced it and is reported to the user.
    expect(() =>
      decodeServerSettingsPatch({
        subagentBackendThreadModes: { t1: "cursor" },
      }),
    ).toThrow();
    expect(() => decodeServerSettingsPatch({ subagentBackendEnabled: "true" })).toThrow();
  });

  it("accepts a single-key thread-mode patch", () => {
    const patch = decodeTypedServerSettingsPatch({
      subagentBackendThreadModes: { t1: "inherit" },
    });
    expect(patch.subagentBackendThreadModes).toEqual({ t1: "inherit" });
  });
});

describe("subagentBackendThreadMode", () => {
  const t1 = ThreadId.make("t1");
  const t2 = ThreadId.make("t2");

  it("reads an explicit entry", () => {
    expect(subagentBackendThreadMode({ [t1]: "on" }, t1)).toBe("on");
    expect(subagentBackendThreadMode({ [t1]: "off" }, t1)).toBe("off");
  });

  it("treats an absent entry as inherit", () => {
    expect(subagentBackendThreadMode({ [t2]: "on" }, t1)).toBe("inherit");
  });

  it("does not read an inherited Object.prototype member as a mode", () => {
    // Thread ids are client-generated and unconstrained; `{}["constructor"]` is a function,
    // which would match no toggle value and light nothing — the segment must read Inherit.
    for (const id of ["constructor", "__proto__", "toString", "valueOf"]) {
      expect(subagentBackendThreadMode({}, ThreadId.make(id))).toBe("inherit");
    }
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

describe("allow spending credits setting", () => {
  it("defaults to allowing spend", () => {
    expect(DEFAULT_SERVER_SETTINGS.allowSpendingCredits).toBe(true);
  });

  it("decodes a settings file written before the field existed", () => {
    const decoded = decodeTypedServerSettings({});
    expect(decoded.allowSpendingCredits).toBe(true);
  });

  it("degrades an undecodable value to the default instead of failing the document", () => {
    // Same containment as `subagentBackendEnabled` above: a failed `ServerSettings`
    // decode makes `loadSettingsFromDisk` keep DEFAULT_SERVER_SETTINGS and write them
    // back, losing every unrelated setting.
    const decoded = decodeServerSettings({
      allowSpendingCredits: "false",
      enableProviderUpdateChecks: false,
    });
    expect(decoded.allowSpendingCredits).toBe(true);
    expect(decoded.enableProviderUpdateChecks).toBe(false);
  });

  it("still rejects a non-boolean at the RPC boundary", () => {
    expect(() => decodeServerSettingsPatch({ allowSpendingCredits: "false" })).toThrow();
  });

  it("accepts a boolean patch", () => {
    const patch = decodeTypedServerSettingsPatch({ allowSpendingCredits: false });
    expect(patch.allowSpendingCredits).toBe(false);
  });
});

describe("queueSlots", () => {
  const decodeQueue = (queueSlots: unknown) =>
    decodeServerSettings({ cursorKeychainUsageEnabled: true, queueSlots });

  it("is absent when never set", () => {
    expect("queueSlots" in decodeServerSettings({})).toBe(false);
  });

  it.each([
    [{ slots: 150 }, { slots: 99, perProvider: false, providerSlots: {} }],
    [{ slots: 1.5 }, { slots: 1, perProvider: false, providerSlots: {} }],
    [{ slots: -3 }, { slots: 0, perProvider: false, providerSlots: {} }],
    [{ slots: "x" }, { slots: 1, perProvider: false, providerSlots: {} }],
    [{ slots: Number.NaN }, { slots: 1, perProvider: false, providerSlots: {} }],
    [{}, { slots: 1, perProvider: false, providerSlots: {} }],
    [{ perProvider: "yes" }, { slots: 1, perProvider: false, providerSlots: {} }],
    [
      { providerSlots: { a: 500, b: "z", c: 2 } },
      { slots: 1, perProvider: false, providerSlots: { a: 99, b: 1, c: 2 } },
    ],
    [{ providerSlots: [5] }, { slots: 1, perProvider: false, providerSlots: {} }],
    [{ providerSlots: null }, { slots: 1, perProvider: false, providerSlots: {} }],
  ])("clamps %j per field and keeps sibling settings", (input, expected) => {
    const settings = decodeQueue(input);
    expect(settings.queueSlots).toEqual(expected);
    expect(settings.cursorKeychainUsageEnabled).toBe(true);
  });

  it.each([null, "garbage", [], 3])("reads %j as absent and keeps sibling settings", (input) => {
    const settings = decodeQueue(input);
    expect(settings.queueSlots).toBeUndefined();
    expect(settings.cursorKeychainUsageEnabled).toBe(true);
  });

  it("round-trips through encode", () => {
    const value = { slots: 3, perProvider: true, providerSlots: { a: 2 } };
    expect(decodeServerSettings(encodeServerSettings(decodeQueue(value))).queueSlots).toEqual(
      value,
    );
  });

  it("decodes a partial queue patch without filling defaults", () => {
    expect(decodeServerSettingsPatch({ queueSlots: { perProvider: true } })).toEqual({
      queueSlots: { perProvider: true },
    });
  });
});

describe("sidebarSections", () => {
  const at = "2026-10-07T00:00:00.000Z";
  const decodeSections = (sidebarSections: unknown) =>
    decodeServerSettings({ cursorKeychainUsageEnabled: true, sidebarSections });

  it("is empty when never set", () => {
    expect(decodeServerSettings({}).sidebarSections).toEqual({});
  });

  it.each([null, "garbage", [], 3])("reads %j as empty and keeps sibling settings", (input) => {
    const settings = decodeSections(input);
    expect(settings.sidebarSections).toEqual({});
    expect(settings.cursorKeychainUsageEnabled).toBe(true);
  });

  it("drops bad entries, trims names and caps them at 60 characters", () => {
    const settings = decodeSections({
      ok: { name: "  Focus  ", createdAt: at },
      long: { name: "y".repeat(200), createdAt: at },
      "bad:id": { name: "Colon", createdAt: at },
      blank: { name: "   ", createdAt: at },
      undated: { name: "No date" },
      badDate: { name: "Bad date", createdAt: "not a date" },
      notObject: "Focus",
    });
    expect(settings.sidebarSections).toEqual({
      ok: { name: "Focus", createdAt: at },
      long: { name: "y".repeat(60), createdAt: at },
    });
    expect(settings.cursorKeychainUsageEnabled).toBe(true);
  });

  it("drops a `__proto__` id and keeps `constructor` and `prototype` as plain entries", () => {
    const settings = decodeSections(
      JSON.parse(
        `{"__proto__":{"name":"P","createdAt":"${at}"},"constructor":{"name":"C","createdAt":"${at}"},"prototype":{"name":"Q","createdAt":"${at}"}}`,
      ),
    );
    expect(Object.getPrototypeOf(settings.sidebarSections)).toBe(Object.prototype);
    expect(Object.keys(settings.sidebarSections).toSorted()).toEqual(["constructor", "prototype"]);
    expect(Object.getOwnPropertyDescriptor(settings.sidebarSections, "constructor")?.value).toEqual(
      {
        name: "C",
        createdAt: at,
      },
    );
  });

  it("round-trips through encode", () => {
    const value = { focus: { name: "Focus", createdAt: at } };
    expect(
      decodeServerSettings(encodeServerSettings(decodeSections(value))).sidebarSections,
    ).toEqual(value);
  });

  it("decodes a per-entry patch with null removals", () => {
    expect(
      decodeServerSettingsPatch({
        sidebarSections: { focus: { name: "Focus", createdAt: at }, old: null },
      }),
    ).toEqual({ sidebarSections: { focus: { name: "Focus", createdAt: at }, old: null } });
  });
});

describe("threadDetailsSectionRowLimit", () => {
  const decode = Schema.decodeUnknownSync(ClientSettingsSchema);
  it("reads 6 when absent", () => {
    expect(decode({}).threadDetailsSectionRowLimit).toBe(6);
  });
  it("keeps values in 1-50", () => {
    expect(decode({ threadDetailsSectionRowLimit: 1 }).threadDetailsSectionRowLimit).toBe(1);
    expect(decode({ threadDetailsSectionRowLimit: 50 }).threadDetailsSectionRowLimit).toBe(50);
  });
  it("rejects out-of-range and non-integer values like every client setting", () => {
    for (const value of [0, 51, "6", 6.5]) {
      expect(() => decode({ threadDetailsSectionRowLimit: value })).toThrow();
    }
  });
});
