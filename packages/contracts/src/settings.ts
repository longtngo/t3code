import { EasDeviceHostConfigs, SimlockDeviceHostConfigs, SshDeviceHostConfigs } from "./device.ts";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  ForwardCompatibleNullable,
  ThreadId,
  ForwardCompatibleOptional,
  OmittedWhenNull,
  ProjectId,
  SIDEBAR_SECTION_ID_PATTERN,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";
import { EnvironmentMachineKind, ThreadEnvMode, WorktreeSubmodules } from "./environment.ts";
import { KeybindingShortcut } from "./keybindings.ts";
import {
  CustomModelSetting,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  ProviderOptionSelections,
} from "./model.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectScript, type ProjectMutation } from "./project.ts";
import { DEFAULT_RUNTIME_MODE, RuntimeMode } from "./providerPolicy.ts";
import { BrowserProfile, BrowserProfileId, DEFAULT_BROWSER_PROFILE_ID } from "./browserProfile.ts";
import {
  BrowserRecordingFrameRate,
  DEFAULT_BROWSER_RECORDING_FRAME_RATE,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  FILL_PREVIEW_VIEWPORT,
  PreviewAppearancePreference,
  PreviewViewportSetting,
  PreviewZoomFactor,
} from "./preview.ts";
import {
  ProviderInstanceConfig,
  ProviderInstanceId,
  ProviderDriverKind,
} from "./providerInstance.ts";
import { PullRequestMergeMethod } from "./pullRequest.ts";

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const DiffLayout = Schema.Literals(["stacked", "split"]);
export type DiffLayout = typeof DiffLayout.Type;
const DEFAULT_DIFF_LAYOUT: DiffLayout = "stacked";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const SidebarProjectGroupingMode = Schema.Literals([
  "repository",
  "repository_path",
  "separate",
]);
export type SidebarProjectGroupingMode = typeof SidebarProjectGroupingMode.Type;
const DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE: SidebarProjectGroupingMode = "repository";
export const MIN_USAGE_PACE_TOLERANCE = 0;
export const MAX_USAGE_PACE_TOLERANCE = 100;
/** Points over pace a usage window may run before its colour turns from yellow to red. */
export const UsagePaceTolerance = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_USAGE_PACE_TOLERANCE, maximum: MAX_USAGE_PACE_TOLERANCE }),
);
export type UsagePaceTolerance = typeof UsagePaceTolerance.Type;
export const DEFAULT_USAGE_PACE_TOLERANCE: UsagePaceTolerance = 15;

export const MIN_THREAD_DETAILS_SECTION_ROW_LIMIT = 1;
export const MAX_THREAD_DETAILS_SECTION_ROW_LIMIT = 50;
/** Rows each thread details section (Tasks, Background, Lineage) shows before "Show more". */
export const ThreadDetailsSectionRowLimit = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_THREAD_DETAILS_SECTION_ROW_LIMIT,
    maximum: MAX_THREAD_DETAILS_SECTION_ROW_LIMIT,
  }),
);
export type ThreadDetailsSectionRowLimit = typeof ThreadDetailsSectionRowLimit.Type;
export const DEFAULT_THREAD_DETAILS_SECTION_ROW_LIMIT: ThreadDetailsSectionRowLimit = 6;
export const MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 1;
export const MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS = 90;
export const SidebarAutoSettleAfterDays = Schema.Number.check(
  Schema.isBetween({
    minimum: MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
    maximum: MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  }),
);
export type SidebarAutoSettleAfterDays = typeof SidebarAutoSettleAfterDays.Type;
const DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS: SidebarAutoSettleAfterDays = 3;

export const MAX_SNOOZE_PRESET_MINUTES = 30 * 24 * 60;
export const MAX_SNOOZE_PRESETS = 8;
export const SnoozePresetDay = Schema.Literals([
  "today",
  "tomorrow",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
export type SnoozePresetDay = typeof SnoozePresetDay.Type;
/** `after` wakes a fixed time from now. `at` wakes at a local time; a weekday is its next occurrence after today. */
export const SnoozePresetSetting = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("after"),
    minutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_SNOOZE_PRESET_MINUTES })),
  }),
  Schema.Struct({
    kind: Schema.Literal("at"),
    day: SnoozePresetDay,
    time: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
  }),
]);
export type SnoozePresetSetting = typeof SnoozePresetSetting.Type;
export const SnoozePresetSettings = Schema.Array(SnoozePresetSetting).check(
  Schema.isMaxLength(MAX_SNOOZE_PRESETS),
);
export const DEFAULT_SNOOZE_PRESETS: ReadonlyArray<SnoozePresetSetting> = [
  { kind: "after", minutes: 60 },
  { kind: "after", minutes: 180 },
  { kind: "at", day: "today", time: "18:00" },
  { kind: "at", day: "tomorrow", time: "09:00" },
  { kind: "at", day: "monday", time: "09:00" },
];

export const MIN_GLASS_OPACITY = 40;
export const MAX_GLASS_OPACITY = 100;
export const GlassOpacity = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_GLASS_OPACITY,
    maximum: MAX_GLASS_OPACITY,
  }),
);
export type GlassOpacity = typeof GlassOpacity.Type;
const DEFAULT_GLASS_OPACITY: GlassOpacity = 80;

export const MIN_APPEARANCE_CONTRAST = 50;
export const MAX_APPEARANCE_CONTRAST = 200;
export const AppearanceContrast = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_APPEARANCE_CONTRAST, maximum: MAX_APPEARANCE_CONTRAST }),
);
export type AppearanceContrast = typeof AppearanceContrast.Type;
const DEFAULT_APPEARANCE_CONTRAST: AppearanceContrast = 100;
export const MIN_PANEL_ANIMATION_DURATION_MS = 0;
export const MAX_PANEL_ANIMATION_DURATION_MS = 400;
export const PanelAnimationDurationMs = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_PANEL_ANIMATION_DURATION_MS,
    maximum: MAX_PANEL_ANIMATION_DURATION_MS,
  }),
);
export type PanelAnimationDurationMs = typeof PanelAnimationDurationMs.Type;
const DEFAULT_PANEL_ANIMATION_DURATION_MS: PanelAnimationDurationMs = 0;

export const MIN_INTERFACE_FONT_SIZE = 12;
export const MAX_INTERFACE_FONT_SIZE = 20;
export const InterfaceFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_INTERFACE_FONT_SIZE, maximum: MAX_INTERFACE_FONT_SIZE }),
);
export type InterfaceFontSize = typeof InterfaceFontSize.Type;
export const DEFAULT_INTERFACE_FONT_SIZE: InterfaceFontSize = 16;

export const MIN_PROMPT_FONT_SIZE = 12;
export const MAX_PROMPT_FONT_SIZE = 20;
export const PromptFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_PROMPT_FONT_SIZE, maximum: MAX_PROMPT_FONT_SIZE }),
);
export type PromptFontSize = typeof PromptFontSize.Type;
export const DEFAULT_PROMPT_FONT_SIZE: PromptFontSize = 14;

export const MIN_CODE_FONT_SIZE = 10;
export const MAX_CODE_FONT_SIZE = 18;
export const CodeFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_CODE_FONT_SIZE, maximum: MAX_CODE_FONT_SIZE }),
);
export type CodeFontSize = typeof CodeFontSize.Type;
export const DEFAULT_CODE_FONT_SIZE: CodeFontSize = 13;

export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 20;
export const TerminalFontSize = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_TERMINAL_FONT_SIZE, maximum: MAX_TERMINAL_FONT_SIZE }),
);
export type TerminalFontSize = typeof TerminalFontSize.Type;
const DEFAULT_TERMINAL_FONT_SIZE: TerminalFontSize = 12;

// "artwork" follows the running channel and shows nothing on Latest. The fixed artwork
// modes let any channel opt into a specific channel's art.
export const EnvironmentIdentificationMode = Schema.Literals([
  "artwork",
  "nightly-artwork",
  "dev-artwork",
  "pill",
  "none",
]);
export type EnvironmentIdentificationMode = typeof EnvironmentIdentificationMode.Type;
export const DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE: EnvironmentIdentificationMode = "artwork";

/** A user-defined composer prompt shortcut: a button label plus the prompt text it inserts. */
export const ComposerShortcut = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  text: Schema.String,
});
export type ComposerShortcut = typeof ComposerShortcut.Type;
export const SnapShotKeyChord = KeybindingShortcut.check(
  Schema.makeFilter(
    (shortcut) =>
      shortcut.metaKey ||
      shortcut.ctrlKey ||
      shortcut.shiftKey ||
      shortcut.altKey ||
      shortcut.modKey ||
      "Snapshot shortcut requires a modifier.",
  ),
);
export type SnapShotKeyChord = typeof SnapShotKeyChord.Type;
export const SNAP_SHOT_MODIFIERS = ["shift", "meta", "control", "alt"] as const;
export const SnapShotModifier = Schema.Literals(SNAP_SHOT_MODIFIERS);
export type SnapShotModifier = typeof SnapShotModifier.Type;
export const SnapShotShortcut = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("both-shift-keys") }),
  Schema.Struct({ kind: Schema.Literal("modifier-pair"), modifier: SnapShotModifier }),
  SnapShotKeyChord,
]);
export type SnapShotShortcut = typeof SnapShotShortcut.Type;
export const SnapShotSound = Schema.Literals(["soft-pop", "camera-shutter"]);
export type SnapShotSound = typeof SnapShotSound.Type;
const DEFAULT_SNAP_SHOT_SOUND: SnapShotSound = "soft-pop";

export type SnapShotModifierPairShortcut = Extract<SnapShotShortcut, { readonly kind: string }>;

export function isModifierPairShortcut(
  shortcut: SnapShotShortcut,
): shortcut is SnapShotModifierPairShortcut {
  return "kind" in shortcut;
}

export function snapShotShortcutModifierPair(
  shortcut: SnapShotModifierPairShortcut,
): SnapShotModifier {
  return shortcut.kind === "both-shift-keys" ? "shift" : shortcut.modifier;
}

const APPLE_MODIFIER_LABELS: Record<SnapShotModifier, string> = {
  shift: "Shift",
  meta: "Command",
  control: "Control",
  alt: "Option",
};
const OTHER_MODIFIER_LABELS: Record<SnapShotModifier, string> = {
  shift: "Shift",
  meta: "Super",
  control: "Ctrl",
  alt: "Alt",
};

export function snapShotModifierPairLabel(modifier: SnapShotModifier, apple: boolean): string {
  const label = (apple ? APPLE_MODIFIER_LABELS : OTHER_MODIFIER_LABELS)[modifier];
  return `${label} + ${label}`;
}
const DEFAULT_SNAP_SHOT_SHORTCUT: SnapShotShortcut = {
  kind: "both-shift-keys",
};

export const NotificationMode = Schema.Literals([
  "off",
  "notifications",
  "sound",
  "notifications-and-sound",
]);
export type NotificationMode = typeof NotificationMode.Type;

export const QuitConfirmationMode = Schema.Literals(["direct", "hold", "double-click"]);
export type QuitConfirmationMode = typeof QuitConfirmationMode.Type;
const DEFAULT_QUIT_CONFIRMATION_MODE: QuitConfirmationMode = "hold";

const LegacyConfirmQuit = Schema.Boolean.pipe(
  Schema.decodeTo(
    QuitConfirmationMode,
    SchemaTransformation.transform({
      decode: (confirmQuit): QuitConfirmationMode => (confirmQuit ? "hold" : "direct"),
      encode: (mode) => mode === "hold",
    }),
  ),
);

const QuitConfirmationModeSetting = Schema.Union([QuitConfirmationMode, LegacyConfirmQuit]);

export const FontFamilyPreference = Schema.String.check(Schema.isMaxLength(200));
export type FontFamilyPreference = typeof FontFamilyPreference.Type;

/** Clients apply each environment theme set once; later local choices persist until the next set. Empty clears it. */
export const DefaultThemePreference = Schema.String.check(Schema.isMaxLength(64));
// Excluded from RPC patches so t3 theme set can validate syntax and resolvability.
export type DefaultThemePreference = typeof DefaultThemePreference.Type;

export const DEFAULT_BROWSER_VIEWPORT: PreviewViewportSetting = FILL_PREVIEW_VIEWPORT;
export const DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW = true;
export {
  BROWSER_RECORDING_FRAME_RATES,
  BrowserRecordingFrameRate,
  DEFAULT_BROWSER_RECORDING_FRAME_RATE,
} from "./preview.ts";
export const BrowserLinkTarget = Schema.Literals(["system", "app"]);
export type BrowserLinkTarget = typeof BrowserLinkTarget.Type;
export const DEFAULT_BROWSER_LINK_TARGET: BrowserLinkTarget = "system";
/**
 * What the address bar searches with when the input is not an address.
 * "custom" uses `browserCustomSearchUrl`, a template with `%s` for the query.
 */
export const BrowserSearchEngine = Schema.Literals([
  "duckduckgo",
  "google",
  "bing",
  "brave",
  "kagi",
  "ecosia",
  "custom",
]);
export type BrowserSearchEngine = typeof BrowserSearchEngine.Type;
export const DEFAULT_BROWSER_SEARCH_ENGINE: BrowserSearchEngine = "duckduckgo";
export const BROWSER_CUSTOM_SEARCH_URL_MAX_LENGTH = 2048;
export const BrowserCustomSearchUrl = Schema.String.check(
  Schema.isMaxLength(BROWSER_CUSTOM_SEARCH_URL_MAX_LENGTH),
);

export const LoadBalancingWeights = Schema.Record(
  TrimmedNonEmptyString,
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
);

export const MAX_QUEUE_SLOTS = 99;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One slot count: a finite number truncated into 0..99; anything else is the default 1. */
const normalizeSlotCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(MAX_QUEUE_SLOTS, Math.trunc(value)))
    : 1;

/** The sidebar Queue's slot settings from any stored shape; also used by the client's local copy. */
export function normalizeQueueSlots(value: unknown): QueueSlotSettings {
  const source = isPlainObject(value) ? value : {};
  const providerSlots = isPlainObject(source.providerSlots) ? source.providerSlots : {};
  return {
    slots: normalizeSlotCount(source.slots),
    perProvider: source.perProvider === true,
    providerSlots: Object.fromEntries(
      Object.entries(providerSlots).map(([id, n]) => [id, normalizeSlotCount(n)]),
    ),
  };
}

export const QueueSlotSettings = Schema.Struct({
  /** How many threads may be busy before the queue sends; 0 holds it. */
  slots: Schema.Number,
  perProvider: Schema.Boolean,
  /** Per provider instance, used while `perProvider` is on; kept when it is off. */
  providerSlots: Schema.Record(Schema.String, Schema.Number),
});
export type QueueSlotSettings = typeof QueueSlotSettings.Type;

export const SIDEBAR_SECTION_NAME_MAX_LENGTH = 60;

export const SidebarSectionDefinition = Schema.Struct({
  name: Schema.String,
  /** ISO time; sections list in creation order. */
  createdAt: Schema.String,
});
export type SidebarSectionDefinition = typeof SidebarSectionDefinition.Type;

/** Every stored shape decodes: bad entries are dropped so one bad section never fails the file. */
export function normalizeSidebarSections(value: unknown): Record<string, SidebarSectionDefinition> {
  if (!isPlainObject(value)) return {};
  // An id of `__proto__` (the pattern allows it) is dropped: the server's generic settings
  // writer assigns by key and would lose it on disk, so memory and disk would disagree.
  // Entries are still collected rather than assigned to `{}` as a second line of defence.
  const sections: Array<[string, SidebarSectionDefinition]> = [];
  for (const [id, entry] of Object.entries(value)) {
    if (id === "__proto__" || !SIDEBAR_SECTION_ID_PATTERN.test(id) || !isPlainObject(entry))
      continue;
    const name =
      typeof entry.name === "string"
        ? entry.name.trim().slice(0, SIDEBAR_SECTION_NAME_MAX_LENGTH)
        : "";
    const createdAt =
      typeof entry.createdAt === "string" && !Number.isNaN(Date.parse(entry.createdAt))
        ? entry.createdAt
        : "";
    if (name === "" || createdAt === "") continue;
    sections.push([id, { name, createdAt }]);
  }
  return Object.fromEntries(sections);
}

export const DiffColorScheme = Schema.Literals(["red-green", "blue-orange"]);

export const ChatWidth = Schema.Literals(["comfortable", "wide", "full"]);
export type ChatWidth = typeof ChatWidth.Type;

/** How the composer shows reasoning effort: the level's name, or rising bars. */
export const EffortDisplay = Schema.Literals(["label", "bars"]);
export type EffortDisplay = typeof EffortDisplay.Type;

export const ModelFavorite = Schema.Struct({
  provider: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});
export const ModelFavorites = Schema.Array(ModelFavorite);
export const ProviderModelPreferences = Schema.Record(
  ProviderInstanceId,
  Schema.Struct({
    hiddenModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
    modelOrder: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
);
export type ModelPreferences = {
  readonly favorites: typeof ModelFavorites.Type;
  readonly providerModelPreferences: typeof ProviderModelPreferences.Type;
};

export const ClientSettingsSchema = Schema.Struct({
  notificationMode: NotificationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("off" as const)),
  ),
  inAppNotificationsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  diffColorScheme: DiffColorScheme.pipe(
    Schema.withDecodingDefault(Effect.succeed("red-green" as const)),
  ),
  chatWidth: ChatWidth.pipe(Schema.withDecodingDefault(Effect.succeed("comfortable" as const))),
  effortDisplay: EffortDisplay.pipe(Schema.withDecodingDefault(Effect.succeed("label" as const))),
  loadBalancingEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  loadBalancingWeights: LoadBalancingWeights.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  appearanceContrast: AppearanceContrast.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_APPEARANCE_CONTRAST)),
  ),
  // Zero avoids per-frame layout work from width/height transitions.
  panelAnimationDurationMs: PanelAnimationDurationMs.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PANEL_ANIMATION_DURATION_MS)),
  ),
  browserDefaultViewport: PreviewViewportSetting.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_VIEWPORT)),
  ),
  browserDefaultZoomFactor: PreviewZoomFactor.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PREVIEW_ZOOM_FACTOR)),
  ),
  browserDefaultAppearance: PreviewAppearancePreference.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PREVIEW_APPEARANCE)),
  ),
  browserRecordingFrameRate: BrowserRecordingFrameRate.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_RECORDING_FRAME_RATE)),
  ),
  browserRecordingShowKeyPresses: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  browserRecordingShowMousePresses: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),

  browserLinkTarget: BrowserLinkTarget.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_LINK_TARGET)),
  ),

  browserSearchEngine: BrowserSearchEngine.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_SEARCH_ENGINE)),
  ),

  // Kept when the engine is switched away from "custom" so switching back restores it.
  browserCustomSearchUrl: BrowserCustomSearchUrl.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),

  browserAutoShowFloatingPreview: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW)),
  ),

  // User-managed prompt shortcuts shown above the composer input; clicking one inserts its
  // text. Ordered by the user in the manager. Client-only (no server round-trip needed).
  composerShortcuts: Schema.Array(ComposerShortcut).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  browserProfiles: Schema.Array(BrowserProfile).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),

  browserDefaultProfileId: BrowserProfileId.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BROWSER_PROFILE_ID)),
  ),

  confirmQuit: QuitConfirmationModeSetting.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_QUIT_CONFIRMATION_MODE)),
  ),
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  confirmThreadUnpin: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  diffFilesCollapsed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  diffIgnoreWhitespace: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  diffLayout: DiffLayout.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_DIFF_LAYOUT))),
  environmentIdentificationMode: EnvironmentIdentificationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE)),
  ),
  glassOpacity: GlassOpacity.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_GLASS_OPACITY)),
  ),
  // Raise an OS notification + in-app toast when a background thread's turn
  // finishes while the user is not viewing it. Client-only preference; gated
  // behind the OS notification permission prompt in the settings toggle.
  notifyOnThreadCompletion: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  fontSizeInterface: InterfaceFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_INTERFACE_FONT_SIZE)),
  ),
  fontSizePrompt: PromptFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROMPT_FONT_SIZE)),
  ),
  fontSizeCode: CodeFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_CODE_FONT_SIZE)),
  ),
  fontSizeTerminal: TerminalFontSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TERMINAL_FONT_SIZE)),
  ),
  fontFamilyCode: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  fontFamilyComposer: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  fontFamilySans: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  fontFamilyTerminal: FontFamilyPreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),

  fontSmoothing: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Older installs also decode to null; onboarding must additionally require an empty workspace.
  onboardingCompletedAt: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  persistComposerContextStrip: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),

  favorites: ModelFavorites.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  providerModelPreferences: ProviderModelPreferences.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  // Client-only on purpose: these settings live in localStorage, so a phone can stay collapsed
  // while a desktop stays expanded without a viewport-dependent default or a second key.
  composerContextStripCollapsed: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  pullRequestMergeMethodOverrides: Schema.Record(
    TrimmedNonEmptyString,
    PullRequestMergeMethod,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),

  pullRequestLinksOpenInApp: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),

  planModeEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // FORK: defaults to true, not upstream's false. Upstream is retiring its circular
  // context indicator; here the same switch governs the composer Vitals gauge's context
  // ring, which is current and has always been on. Defaulting it off would silently
  // remove a shipped feature from every existing user.
  contextWindowMeterEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  composerRichTextEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sendShortcut: Schema.Literals(["enter", "mod-enter-multiline", "mod-enter"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("enter")),
  ),
  // FORK-ONLY: upstream defaults to "steer"; this fork has queued mid-turn sends by default since
  // before orchestrator v2, so an unset setting keeps queueing (fork registry invariant 5).
  followUpBehavior: Schema.Literals(["queue", "steer"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("queue")),
  ),
  proactivePanelsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  showSkillsInSlashMenu: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  boringSidebarEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  boringSidebarMultilineRows: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  // Retired Labs toggle. Still read as the default for the Usage item in threadDetailsItems.
  threadDetailsUsageEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Sparse show/hide overrides for thread details card items. Missing ids use the client's
  // default, so new items appear for everyone and unknown ids survive a downgrade.
  threadDetailsItems: Schema.Record(Schema.String, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  // Opt-in for the removed legacy sidebar. Still read so those users land in
  // the boring sidebar; the boring sidebar toggle clears it.
  legacySidebarEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Keeps each message's timestamp row visible instead of revealing it on hover.
  alwaysShowMessageTimestamps: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  sidebarWorkingShelfEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sidebarProjectGroupingMode: SidebarProjectGroupingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE)),
  ),
  sidebarProjectGroupingOverrides: Schema.Record(
    TrimmedNonEmptyString,
    SidebarProjectGroupingMode,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  ),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  usagePaceTolerance: UsagePaceTolerance.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_USAGE_PACE_TOLERANCE)),
  ),
  threadDetailsSectionRowLimit: ThreadDetailsSectionRowLimit.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_THREAD_DETAILS_SECTION_ROW_LIMIT)),
  ),
  snapShotEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  snapShotIncludeAccessibility: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  snapShotShortcut: SnapShotShortcut.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SNAP_SHOT_SHORTCUT)),
  ),
  snapShotPlaySound: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  snapShotSound: SnapShotSound.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SNAP_SHOT_SOUND)),
  ),
  snapShotFlash: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  snapShotAnimations: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  wordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Opt-in TeX typesetting in rendered Markdown. Off keeps math parsing and
  // KaTeX out of the render path entirely.
  mathRenderingEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

const UsageModelTokenPrice = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
);

/** Omitted cache rates use the input rate. */
export const UsageModelPriceOverride = Schema.Struct({
  inputCostPerMillionTokens: UsageModelTokenPrice,
  outputCostPerMillionTokens: UsageModelTokenPrice,
  cacheReadCostPerMillionTokens: Schema.optionalKey(UsageModelTokenPrice),
  cacheWriteCostPerMillionTokens: Schema.optionalKey(UsageModelTokenPrice),
});
export type UsageModelPriceOverride = typeof UsageModelPriceOverride.Type;

export const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export type ProviderSettingsFormControl = "text" | "password" | "textarea" | "switch" | "select";

export interface ProviderSettingsFormOption {
  readonly value: string;
  readonly label: string;
}

export interface ProviderSettingsFormAnnotation {
  readonly control?: ProviderSettingsFormControl | undefined;
  readonly placeholder?: string | undefined;
  readonly hidden?: boolean | undefined;
  readonly clearWhenEmpty?: "omit" | "persist" | undefined;
  /**
   * Renders the field as a dropdown over exactly these choices (`control: "select"`). The
   * first entry is the default and is stored as an omitted key; an optional field puts its
   * clear row (`value: ""`) first.
   */
  readonly options?: readonly ProviderSettingsFormOption[] | undefined;
}

export function secretSettingsFields(schema: {
  readonly fields: Readonly<Record<string, Schema.Top>>;
}): ReadonlyArray<string> {
  return Object.entries(schema.fields).flatMap(([field, fieldSchema]) => {
    return isSecretSetting(fieldSchema) ? [field] : [];
  });
}

export interface ProviderSettingsFormSchemaAnnotation {
  readonly order?: readonly string[] | undefined;
}

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      /** Store this credential separately and expose only whether it is configured to clients. */
      readonly settingsSecret?: boolean | undefined;
      readonly providerSettingsForm?: ProviderSettingsFormAnnotation | undefined;
      readonly providerSettingsFormSchema?: ProviderSettingsFormSchemaAnnotation | undefined;
    }
  }
}

export function secretSetting<S extends Schema.Top>(schema: S): S["Rebuild"] {
  return schema.annotateKey({ settingsSecret: true });
}

/** A masked form field is a credential too, so none is saved or sent to clients as plain text. */
export function isSecretSetting(schema: Schema.Top): boolean {
  const annotations = Schema.resolveAnnotationsKey(schema) ?? Schema.resolveAnnotations(schema);
  return (
    annotations?.settingsSecret === true ||
    annotations?.providerSettingsForm?.control === "password"
  );
}

export type ProviderSettingsOrder<Fields extends Schema.Struct.Fields> = readonly Extract<
  keyof Fields,
  string
>[];

export function makeProviderSettingsSchema<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
  options?: {
    readonly order?: ProviderSettingsOrder<Fields> | undefined;
  },
): Schema.Struct<Fields> {
  return Schema.Struct(fields).pipe(
    Schema.annotate({
      providerSettingsFormSchema:
        options?.order === undefined ? undefined : { order: options.order },
    }),
  );
}

export const CodexSettings = makeProviderSettingsSchema(
  {
    setupMode: Schema.optionalKey(Schema.Literals(["managed", "existing"])).pipe(
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("codex").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Codex binary used by this instance.",
        providerSettingsForm: { placeholder: "codex", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "CODEX_HOME path",
        description: "Custom Codex home and config directory.",
        providerSettingsForm: {
          placeholder: "~/.codex",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    shadowHomePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Shadow home path",
        description:
          "Account-specific Codex home. Keeps auth.json separate while sharing state from CODEX_HOME.",
        providerSettingsForm: {
          placeholder: "~/.codex-t3/personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed to codex app-server on session start.",
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "homePath", "shadowHomePath", "launchArgs"],
  },
);
export type CodexSettings = typeof CodexSettings.Type;

// Empty, an integer 100,000-1,000,000, or `10%`-`100%` of the window. Mirrors Claude Code's own
// `.int().min(1e5).max(1e6).catch(undefined)`, which SILENTLY drops out-of-range values: keep in
// step. `%` is required since `/autocompact` reads bare `600` as 600,000; percentages are clamped
// by `resolveClaudeAutoCompactWindow` (30% of 200k is under the CLI minimum).
const CLAUDE_AUTO_COMPACT_WINDOW_PATTERN = /^(?:|[1-9]\d{5}|1000000|(?:[1-9]\d|100)%)$/;

/** Claude Code's own accepted range for the key; outside it the value is dropped. */
export const CLAUDE_AUTO_COMPACT_WINDOW_MIN = 100_000;
export const CLAUDE_AUTO_COMPACT_WINDOW_MAX = 1_000_000;

/**
 * Claude Code's built-in output styles (CLI 2.1.250); feeds both the dropdown and the validating
 * pattern. The CLI silently ignores an unknown name (measured: rc=0, no warning), so anything off
 * this list reaches the model as no style.
 */
export const CLAUDE_OUTPUT_STYLES = ["Concise", "Explanatory", "Learning", "Proactive"] as const;
/**
 * Matches exactly one of `choices`, or "". A function so the quoting is testable: with plain-letter
 * choices quoted and unquoted patterns are identical, but `Concise.v2` unquoted would admit
 * `ConciseXv2`.
 */
export const optionalOneOfPattern = (choices: readonly string[]): RegExp =>
  new RegExp(
    `^(?:|${choices.map((choice) => choice.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)).join("|")})$`,
  );

const CLAUDE_OUTPUT_STYLE_PATTERN = optionalOneOfPattern(CLAUDE_OUTPUT_STYLES);

/**
 * Tokens to hand Claude Code, or `undefined` ("say nothing", also for an unresolvable percentage).
 * Clamped into [1e5, 1e6] because the CLI's `.catch(undefined)` silently discards out-of-range
 * values, leaving the window `"auto"`, where it refuses to compact at all.
 */
export function resolveClaudeAutoCompactWindow(
  setting: string | undefined,
  modelContextWindow: number | undefined,
): number | undefined {
  const trimmed = setting?.trim();
  if (!trimmed) return undefined;

  const clamp = (value: number) =>
    Math.min(
      CLAUDE_AUTO_COMPACT_WINDOW_MAX,
      Math.max(CLAUDE_AUTO_COMPACT_WINDOW_MIN, Math.round(value)),
    );

  if (trimmed.endsWith("%")) {
    const percent = Number(trimmed.slice(0, -1));
    if (!Number.isFinite(percent) || percent <= 0) return undefined;
    if (modelContextWindow === undefined || modelContextWindow <= 0) return undefined;
    return clamp((percent / 100) * modelContextWindow);
  }

  const tokens = Number(trimmed);
  // Not `?? fallback` at the call site: an unparseable value must not read as
  // "the user configured nothing", because the caller's own default for that
  // case is what keeps compaction armed on a 1M window.
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined;
  return clamp(tokens);
}

export const IDLE_COMPACTION_MODES = [
  { value: "onReturn", label: "When you return" },
  { value: "beforeCacheExpires", label: "Before the cache expires (beta)" },
  { value: "off", label: "Never" },
] as const;
export const IdleCompactionMode = Schema.Literals(IDLE_COMPACTION_MODES.map((mode) => mode.value));
export type IdleCompactionMode = typeof IdleCompactionMode.Type;

// Shipped clients reject the whole server config unless `compactIdleThreads` is boolean.
// Keep the mode in `idleCompaction`, but accept strings from older servers.
const LegacyCompactIdleThreads = Schema.Union([Schema.Boolean, IdleCompactionMode]);

const INSTANCE_IDLE_COMPACTION_MODES = [
  { value: "default", label: "Use default" },
  ...IDLE_COMPACTION_MODES,
] as const;
const InstanceIdleCompaction = Schema.Literals(
  INSTANCE_IDLE_COMPACTION_MODES.map((mode) => mode.value),
);

export const ClaudeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("claude").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Claude binary used by this instance.",
        providerSettingsForm: { placeholder: "claude", clearWhenEmpty: "omit" },
      }),
    ),
    homePath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Claude HOME path",
        description:
          "Custom HOME used when running this Claude instance. Keeps .claude.json and .claude separate.",
        providerSettingsForm: { placeholder: "~", clearWhenEmpty: "omit" },
      }),
    ),
    configDirPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Claude config directory",
        description:
          "Sets CLAUDE_CONFIG_DIR for this instance. Gives it a separate login (on macOS the Keychain credential is keyed by this path), so two instances can use different Claude accounts. Leave blank to use the default ~/.claude.",
        providerSettingsForm: {
          placeholder: "~/.claude-personal",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    launchArgs: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed on session start.",
        providerSettingsForm: {
          placeholder: "e.g. --chrome",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    autoCompactWindow: TrimmedString.check(
      Schema.isPattern(CLAUDE_AUTO_COMPACT_WINDOW_PATTERN),
    ).pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      // Recover to "" instead of failing the whole document: a failed `ServerSettings` decode makes
      // `loadSettingsFromDisk` write DEFAULT_SERVER_SETTINGS back, losing every provider setting
      // (measured). This lets an older build survive a newer value (rollback). Strict validation stays
      // in `ClaudeSettingsPatch`, which fails only the offending update.
      Schema.catchDecoding(() => Effect.succeedSome("")),
      Schema.annotateKey({
        title: "Auto-compact after",
        description:
          "Compact after 100,000 to 1,000,000 tokens, or a percentage of the model's context " +
          "window such as 60%. A token count is capped at the model's own window. Leave empty " +
          "to use Claude's default.",
        providerSettingsForm: {
          placeholder: "e.g. 60% or 300000",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    outputStyle: TrimmedString.check(Schema.isPattern(CLAUDE_OUTPUT_STYLE_PATTERN)).pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      // Same recovery as `autoCompactWindow`: on `providers.claudeAgent` a bad value resets the whole
      // settings file (measured: a custom `binaryPath` reverted), and on `providerInstances.*.config` it
      // marks the Claude instance unavailable. It also lets an older build survive a newer style.
      Schema.catchDecoding(() => Effect.succeedSome("")),
      Schema.annotateKey({
        title: "Output style",
        description:
          "Part of Claude's system prompt, so it outweighs CLAUDE.md. Leave unset to defer " +
          "to your own ~/.claude/settings.json.",
        providerSettingsForm: {
          clearWhenEmpty: "omit",
          control: "select",
          // Not "Claude's default": `--setting-sources` still passes user, project and local, so unset
          // defers to the user's own settings file, not Claude's built-in default.
          options: [
            { value: "", label: "Use ~/.claude/settings.json" },
            ...CLAUDE_OUTPUT_STYLES.map((style) => ({ value: style, label: style })),
          ],
        },
      }),
    ),
    idleCompaction: InstanceIdleCompaction.pipe(
      Schema.withDecodingDefault(Effect.succeed("default" as const)),
      Schema.annotateKey({
        title: "Compact idle threads",
        description:
          "When to compact an idle thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Overrides the default in Providers > Advanced.",
        providerSettingsForm: {
          control: "select",
          options: INSTANCE_IDLE_COMPACTION_MODES,
          clearWhenEmpty: "omit",
        },
      }),
    ),
  },
  {
    order: [
      "binaryPath",
      "homePath",
      "configDirPath",
      "autoCompactWindow",
      "idleCompaction",
      "outputStyle",
      "launchArgs",
    ],
  },
);
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const ANTIGRAVITY_AUTH_METHODS = [
  { value: "oauth-personal", label: "Google account" },
  { value: "oauth-business", label: "Gemini Enterprise" },
  { value: "gemini-api-key", label: "Gemini API key" },
  { value: "agent-platform", label: "Agent Platform (Vertex AI)" },
] as const satisfies ReadonlyArray<ProviderSettingsFormOption>;
export const AntigravityAuthMethod = Schema.Literals(
  ANTIGRAVITY_AUTH_METHODS.map((method) => method.value),
);
export type AntigravityAuthMethod = typeof AntigravityAuthMethod.Type;

export const AntigravitySettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    authMethod: AntigravityAuthMethod.pipe(
      Schema.withDecodingDefault(Effect.succeed("oauth-personal" as const)),
      Schema.annotateKey({
        title: "Sign-in method",
        description:
          "Google accounts use your subscription; API keys and Agent Platform bill usage.",
        providerSettingsForm: {
          control: "select",
          options: ANTIGRAVITY_AUTH_METHODS,
          clearWhenEmpty: "omit",
        },
      }),
    ),
    apiKey: TrimmedString.pipe(
      secretSetting,
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "API key",
        description: "Gemini or Vertex AI express key. Stored separately on the host.",
        providerSettingsForm: {
          control: "password",
          placeholder: "Optional",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    gcpProject: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "GCP project",
        description:
          "Required for Gemini Enterprise. Agent Platform uses it when no API key is set.",
        providerSettingsForm: { placeholder: "my-project-id", clearWhenEmpty: "omit" },
      }),
    ),
    gcpLocation: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "GCP location",
        description: "Region for Gemini Enterprise or Agent Platform.",
        providerSettingsForm: { placeholder: "us-central1", clearWhenEmpty: "omit" },
      }),
    ),
    binaryPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Binary path",
        description: "Custom ACP executable. Leave empty to select automatically.",
        providerSettingsForm: { placeholder: "Automatic", clearWhenEmpty: "persist" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  { order: ["authMethod", "apiKey", "gcpProject", "gcpLocation", "binaryPath"] },
);
export type AntigravitySettings = typeof AntigravitySettings.Type;

export const UsageLimitSourceConfig = Schema.Struct({
  kind: Schema.Literal("cliproxy"),
  label: Schema.optional(TrimmedNonEmptyString),
  url: TrimmedNonEmptyString,
  managementKey: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("")), secretSetting),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type UsageLimitSourceConfig = typeof UsageLimitSourceConfig.Type;

export const SourceControlHostSettings = Schema.Record(Schema.String, Schema.Unknown);
export type SourceControlHostSettings = typeof SourceControlHostSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpLogsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

/**
 * Local-model manager (mlx-serve): scans `modelsDir`, spawns with `defaultArgs` plus per-model
 * `args`, refuses a load past `ramBudgetBytes`. Host is always loopback; ports are internal.
 */
/**
 * HISTORICAL ds4 engine config: retired and absent from the catalog, kept so older settings files
 * still decode; `migrateLocalModels` reads and drops it. Disabled by default so CI never globs a
 * missing dir or spawns anything.
 */
export const Ds4Settings = Schema.Struct({
  /** When false (default) the engine is skipped entirely — no discovery, probe, or spawn. */
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** ds4-server binary; resolved on PATH by default. `~` is expanded server-side. */
  binaryPath: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("ds4-server"))),
  /** Directory globbed for `*.gguf` model files. `~` is expanded server-side. */
  modelsDir: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("~/ds4/gguf"))),
  /** Default ds4-server launch args (host/port/model are added by the manager). */
  defaultArgs: Schema.Array(TrimmedString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Optional per-model launch-arg overrides, keyed by GGUF filename. */
  perModel: Schema.Record(
    TrimmedNonEmptyString,
    Schema.Struct({ args: Schema.optional(Schema.Array(TrimmedString)) }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type Ds4Settings = typeof Ds4Settings.Type;

export const LocalModelsSettings = Schema.Struct({
  /** Directory scanned for loadable model subdirectories. `~` is expanded server-side. */
  modelsDir: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("~/llm/models"))),
  /** RAM budget in bytes; 0 ⇒ the server uses ~80% of total system memory. */
  ramBudgetBytes: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /**
   * Default mlx-serve launch args (host/port/model are added by the manager).
   * `--no-pld` was dropped 2026-06-18: mlx-serve 26.6.8+ adaptive Prompt-Lookup Decoding
   * ties or beats it everywhere, so PLD is left at its (on) default.
   */
  defaultArgs: Schema.Array(TrimmedString).pipe(
    Schema.withDecodingDefault(Effect.succeed(["--reasoning-budget", "0"])),
  ),
  /** Optional per-model launch-arg overrides, keyed by model-directory basename. */
  perModel: Schema.Record(
    TrimmedNonEmptyString,
    Schema.Struct({
      args: Schema.optional(Schema.Array(TrimmedString)),
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /**
   * HISTORICAL: a second local-model engine, ds4 / DeepSeek V4 Flash. Retired — it is gone
   * from the model catalog, so `migrateLocalModels` reads this block and drops it. Kept in
   * the schema only so a settings file written before the retirement still decodes.
   */
  ds4: Ds4Settings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type LocalModelsSettings = typeof LocalModelsSettings.Type;

/**
 * Sparse per-catalog-provider overrides (only changed fields; the rest come from
 * `@t3tools/shared/localLlm`), keyed by provider id. `visible` only hides a provider from model
 * pickers; it stays configurable and usable.
 */
export const LocalLlmProviderConfig = Schema.Struct({
  visible: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  host: Schema.optional(TrimmedString),
  port: Schema.optional(Schema.Number),
  /** managed engines: executable override. `~` expanded server-side. */
  binaryPath: Schema.optional(TrimmedString),
  /** managed engines: directory holding model resources. `~` expanded server-side. */
  modelsDir: Schema.optional(TrimmedString),
  /** external providers: probe URL override (otherwise host:port from catalog). */
  baseUrl: Schema.optional(TrimmedString),
  /** Overrides the catalog `defaultArgs` when present (grouped tokens). */
  defaultArgs: Schema.optional(Schema.Array(TrimmedString)),
});
export type LocalLlmProviderConfig = typeof LocalLlmProviderConfig.Type;

/**
 * A catalog model paired with a catalog provider, driving the load list and env-var presets.
 * `port` is stable per config so status survives restarts; `argsOverride` replaces BOTH provider
 * and model catalog defaults; `contextWindow` owns `--ctx-size`.
 */
export const LocalLlmModelConfig = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  providerId: TrimmedNonEmptyString,
  modelId: TrimmedNonEmptyString,
  contextWindow: Schema.optional(Schema.Number),
  visible: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  port: Schema.optional(Schema.Number),
  argsOverride: Schema.optional(Schema.Array(TrimmedString)),
  modelPathOverride: Schema.optional(TrimmedString),
});
export type LocalLlmModelConfig = typeof LocalLlmModelConfig.Type;

/**
 * Replacement for `LocalModelsSettings`: provider overrides keyed by catalog id +
 * an ordered list of model configs. `localModels` is migrated into this on first
 * decode (see localLlmMigration.ts) and then retired.
 */
export const LocalLlmSettings = Schema.Struct({
  /** RAM budget in bytes; 0 ⇒ the server uses ~80% of total system memory. */
  ramBudgetBytes: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  providers: Schema.Record(TrimmedNonEmptyString, LocalLlmProviderConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  models: Schema.Array(LocalLlmModelConfig).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type LocalLlmSettings = typeof LocalLlmSettings.Type;
export const SourceControlWritingStyleMode = Schema.Literals([
  "repo_conventions",
  "conventional_commits",
  "custom",
]);
export type SourceControlWritingStyleMode = typeof SourceControlWritingStyleMode.Type;

export const SourceControlWritingStyleSettings = Schema.Struct({
  mode: SourceControlWritingStyleMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("repo_conventions" as const)),
  ),
  customInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  followChangeRequestTemplates: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
});
export type SourceControlWritingStyleSettings = typeof SourceControlWritingStyleSettings.Type;

const LegacySourceControlWritingStyle = TrimmedString.pipe(
  Schema.decodeTo(
    Schema.toType(SourceControlWritingStyleSettings),
    SchemaTransformation.transform({
      decode: (value): SourceControlWritingStyleSettings => ({
        mode: value.length > 0 ? "custom" : "repo_conventions",
        customInstructions: value,
        followChangeRequestTemplates: true,
      }),
      encode: (value) => value.customInstructions,
    }),
  ),
);

// The struct member comes first so encoding uses its defaulted fields: the server strips
// default sub-fields before writing settings.json, and a toType target would reject them.
const SourceControlWritingStyleSetting = Schema.Union([
  SourceControlWritingStyleSettings,
  LegacySourceControlWritingStyle,
]);

export const BranchNamingMode = Schema.Literals(["static", "semantic", "custom"]);
export type BranchNamingMode = typeof BranchNamingMode.Type;

export interface BranchNamingOptions {
  mode: BranchNamingMode;
  prefix: string;
  instructions: string;
}

export const DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL = Duration.seconds(30);
export const DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL = Duration.minutes(5);

export const BackgroundActivityProfile = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
]);
export type BackgroundActivityProfile = typeof BackgroundActivityProfile.Type;
export const DEFAULT_BACKGROUND_ACTIVITY_PROFILE: BackgroundActivityProfile = "balanced";

export const BackgroundActivityProfileSelection = Schema.Literals([
  "balanced",
  "performance",
  "battery-saver",
  "custom",
]);
export type BackgroundActivityProfileSelection = typeof BackgroundActivityProfileSelection.Type;

export const BackgroundActivityOverrides = Schema.Struct({
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorActiveInterval: Schema.optionalKey(Schema.DurationFromMillis),
  hostPowerMonitorIdleInterval: Schema.optionalKey(Schema.DurationFromMillis),
  pauseWhenHostLocked: Schema.optionalKey(Schema.Boolean),
  pauseWhenHostLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenClientLowPower: Schema.optionalKey(Schema.Boolean),
  pauseWhenOnBattery: Schema.optionalKey(Schema.Boolean),
});
export type BackgroundActivityOverrides = typeof BackgroundActivityOverrides.Type;

export const BackgroundActivitySettings = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  profile: BackgroundActivityProfileSelection.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  baseProfile: Schema.optionalKey(BackgroundActivityProfile),
  overrides: BackgroundActivityOverrides.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type BackgroundActivitySettings = typeof BackgroundActivitySettings.Type;

/**
 * Silenceable categories in render order. The schema below is hand-written (deriving it erases key
 * types and makes a one-category patch reset siblings); `_categoryParity` keeps them in step.
 * `finishedBackground` splits finishes with live background work (43% of turns are wake-ups), so
 * the true final alert, with nothing running, stays in `finished` when interim ones are silenced.
 */
export const NOTIFICATION_CATEGORIES = [
  {
    key: "finished",
    label: "Task finished",
    description:
      "A task stopped running and nothing was left working in the background. This is the alert that fires when a whole piece of work is genuinely done. Background notifications wait a few seconds before raising it, so a finish the agent carries on from within those seconds raises no background alert. One whose next step was already queued is an Interim finish instead.",
  },
  {
    key: "finishedBackground",
    label: "Interim finish",
    description:
      "A task stopped running while subagents or other background work were still going, or after the agent had already moved on to its next step. On agent runs that fan out to subagents these are most of the notifications you get.",
  },
  {
    key: "needsInput",
    label: "Agent asked a question",
    description: "An agent is waiting on an answer before it can continue.",
  },
  {
    key: "failed",
    label: "Task failed",
    description: "A task stopped because of an error.",
  },
] as const;

export type NotificationCategoryKey = (typeof NOTIFICATION_CATEGORIES)[number]["key"];

export const NotificationCategorySettings = Schema.Struct({
  finished: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  finishedBackground: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  needsInput: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  failed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type NotificationCategorySettings = typeof NotificationCategorySettings.Type;

/**
 * A finish is interim when any background work was live; shared by the web notifier and push relay
 * so they agree. `"monitoring"` counts: offloaded subagents run as background shells, and only 8 of
 * 9,557 such shells never woke the agent. Absent liveness (older server, restart) reads as idle.
 */
export function isInterimBackgroundLiveness(
  liveness: "working" | "monitoring" | null | undefined,
): boolean {
  return liveness != null;
}

/** Fails to compile if the table and the schema stop describing the same categories. */
type ExactlySameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const _categoryParity: ExactlySameKeys<
  NotificationCategoryKey,
  keyof NotificationCategorySettings
> = true;

export const SubagentBackendThreadMode = Schema.Literals(["inherit", "on", "off"]);
export type SubagentBackendThreadMode = typeof SubagentBackendThreadMode.Type;

/** `"inherit"` is the wire value to revert a thread but is never stored: `applyServerSettingsPatch`
 * strips it after the merge (`deepMerge` cannot delete keys), so Revert is a delete. Absent and
 * `"inherit"` both resolve to the machine-wide choice. */
export const SubagentBackendThreadModes = Schema.Record(ThreadId, SubagentBackendThreadMode);

/**
 * Absent reads as Inherit. `Object.hasOwn`, not `?? "inherit"`: thread ids are client-generated, so
 * `__proto__` or `constructor` would read a prototype member and fall through a server-side
 * `mode !== "inherit"` check into the enabling branch.
 */
export function subagentBackendThreadMode(
  modes: typeof SubagentBackendThreadModes.Type,
  threadId: ThreadId,
): SubagentBackendThreadMode {
  return Object.hasOwn(modes, threadId) ? (modes[threadId] ?? "inherit") : "inherit";
}

export const ResponseStreamingMode = Schema.Literals(["turn", "paragraph"]);
export type ResponseStreamingMode = typeof ResponseStreamingMode.Type;

const StorageRetentionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 })),
);
const SettledWorktreeRetentionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3650 })),
);

export const WorktreeKeepWhen = Schema.Literals([
  "any-local-files",
  "uncommitted-changes",
  "tracked-changes",
]);
export type WorktreeKeepWhen = typeof WorktreeKeepWhen.Type;

export const WorktreeCleanupRules = Schema.Struct({
  worktreeKeepWhen: WorktreeKeepWhen.pipe(
    Schema.withDecodingDefault(Effect.succeed("uncommitted-changes")),
  ),
  worktreeAfterDays: StorageRetentionDays,
  worktreeSettledAfterDays: SettledWorktreeRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  worktreeOnMerge: Schema.Boolean,
  worktreeOnDelete: Schema.Boolean,
  worktreeUnchanged: Schema.Boolean,
});
export type WorktreeCleanupRules = typeof WorktreeCleanupRules.Type;

export const WorktreeCleanup = Schema.NullOr(
  Schema.Union([
    Schema.Struct({ mode: Schema.Literal("off") }),
    Schema.Struct({ mode: Schema.Literal("custom"), rules: WorktreeCleanupRules }),
  ]),
);
export type WorktreeCleanup = typeof WorktreeCleanup.Type;

export const PROJECT_SCOPED_SERVER_SETTING_KEYS = [
  "worktreeCleanup",
  "defaultModelSelection",
  "defaultRuntimeMode",
  "defaultThreadEnvMode",
  "newWorktreesStartFromOrigin",
  "worktreeSubmodules",
  "defaultAutoPull",
  "defaultProjectScripts",
  "enableAgentBrowserAccess",
  "enableAgentDeviceAccess",
  "textGenerationModelSelection",
  "threadTitleInstructions",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "reviewGuideInstructions",
  "sourceControlWritingStyle",
  "removeAgentCreditsOnMerge",
  "branchNamingMode",
  "branchNamePrefix",
  "branchNameInstructions",
  "pullRequestMergeMethod",
  "sidebarAutoSettleOnMerge",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleKeepPullRequests",
  "continueThreadsAfterServerUpdate",
  "responseStreamingMode",
] as const;
export type ProjectScopedServerSettingKey = (typeof PROJECT_SCOPED_SERVER_SETTING_KEYS)[number];

export const ProjectProviderInstanceOverride = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type ProjectProviderInstanceOverride = typeof ProjectProviderInstanceOverride.Type;

/** Absent keys inherit; null is a value for nullable settings.
 * providerInstances overrides fields per instance; other keys replace the whole setting. */
export const ProjectSettingsOverrides = Schema.Struct({
  worktreeCleanup: Schema.optionalKey(WorktreeCleanup),
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  defaultRuntimeMode: Schema.optionalKey(RuntimeMode),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  worktreeSubmodules: ForwardCompatibleOptional(WorktreeSubmodules),
  defaultAutoPull: Schema.optionalKey(Schema.Boolean),
  defaultProjectScripts: Schema.optionalKey(Schema.Array(ProjectScript)),
  enableAgentBrowserAccess: Schema.optionalKey(Schema.Boolean),
  enableAgentDeviceAccess: Schema.optionalKey(Schema.Boolean),
  textGenerationModelSelection: Schema.optionalKey(ModelSelection),
  threadTitleInstructions: Schema.optionalKey(TrimmedString),
  sourceControlWriterModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  reviewGuideModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  reviewGuideInstructions: Schema.optionalKey(TrimmedString),
  sourceControlWritingStyle: Schema.optionalKey(SourceControlWritingStyleSetting),
  removeAgentCreditsOnMerge: Schema.optionalKey(Schema.Boolean),
  branchNamingMode: Schema.optionalKey(BranchNamingMode),
  branchNamePrefix: Schema.optionalKey(TrimmedString),
  branchNameInstructions: Schema.optionalKey(TrimmedString),
  pullRequestMergeMethod: Schema.optionalKey(Schema.NullOr(PullRequestMergeMethod)),
  sidebarAutoSettleOnMerge: Schema.optionalKey(Schema.Boolean),
  sidebarAutoSettleAfterDays: Schema.optionalKey(Schema.NullOr(SidebarAutoSettleAfterDays)),
  sidebarAutoSettleKeepPullRequests: Schema.optionalKey(Schema.Boolean),
  continueThreadsAfterServerUpdate: Schema.optionalKey(Schema.Boolean),
  responseStreamingMode: Schema.optionalKey(ResponseStreamingMode),
  providerInstances: Schema.optionalKey(
    Schema.Record(ProviderInstanceId, ProjectProviderInstanceOverride),
  ),
} satisfies Record<ProjectScopedServerSettingKey | "providerInstances", unknown>);
export type ProjectSettingsOverrides = typeof ProjectSettingsOverrides.Type;

/** True if null stores an override; otherwise null removes it. */
export function isNullableProjectSettingsOverride(key: ProjectScopedServerSettingKey): boolean {
  return NULLABLE_PROJECT_SETTINGS_OVERRIDES.has(key);
}
const NULLABLE_PROJECT_SETTINGS_OVERRIDES: ReadonlySet<ProjectScopedServerSettingKey> = new Set<
  {
    [K in ProjectScopedServerSettingKey]: null extends ProjectSettingsOverrides[K] ? K : never;
  }[ProjectScopedServerSettingKey]
>([
  "defaultModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "pullRequestMergeMethod",
  "sidebarAutoSettleAfterDays",
]);

/** Reclaimable bytes from which the offline `t3 doctor` repair is worth suggesting. */
export const DATABASE_COMPACTION_RECOMMENDED_BYTES = 1024 ** 3;

export const DatabaseStorageStatus = Schema.Struct({
  databaseBytes: Schema.Number,
  /** Free pages inside the file that an offline VACUUM (or incremental auto_vacuum) returns to disk. */
  reclaimableBytes: Schema.Number,
  /** False on databases created before incremental auto_vacuum; `t3 doctor` converts them. */
  incrementalVacuumEnabled: Schema.Boolean,
  /** Run on the host while offline. */
  compactCommand: Schema.String,
});
export type DatabaseStorageStatus = typeof DatabaseStorageStatus.Type;

export function shouldRecommendDatabaseCompaction(status: DatabaseStorageStatus): boolean {
  return (
    !status.incrementalVacuumEnabled &&
    status.reclaimableBytes >= DATABASE_COMPACTION_RECOMMENDED_BYTES
  );
}

export const StorageCleanupReportEntry = Schema.Struct({
  kind: Schema.Literals(["worktree", "browser-artifacts", "logs"]),
  outcome: Schema.Literals(["removed", "kept", "failed"]),
  reason: Schema.String,
  path: Schema.NullOr(Schema.String),
  projectPath: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  threadId: Schema.NullOr(ThreadId),
  threadTitle: Schema.NullOr(Schema.String),
  bytes: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  files: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type StorageCleanupReportEntry = typeof StorageCleanupReportEntry.Type;
export const StorageCleanupReport = Schema.Struct({
  trigger: Schema.Literals(["automatic", "manual"]),
  startedAt: Schema.String,
  finishedAt: Schema.String,
  entries: Schema.Array(StorageCleanupReportEntry),
  counts: Schema.Struct({ removed: Schema.Number, kept: Schema.Number, failed: Schema.Number }),
  omittedCount: Schema.Number,
  bytesFreed: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type StorageCleanupReport = typeof StorageCleanupReport.Type;

export const StorageCleanupSettings = Schema.Struct({
  worktreeKeepWhen: WorktreeKeepWhen.pipe(
    Schema.withDecodingDefault(Effect.succeed("uncommitted-changes")),
  ),
  worktreeAfterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  worktreeSettledAfterDays: SettledWorktreeRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  worktreeOnMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeOnDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeUnchanged: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  browserArtifactsAfterDays: StorageRetentionDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  logsAfterDays: StorageRetentionDays.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type StorageCleanupSettings = typeof StorageCleanupSettings.Type;

export const ServerSettings = Schema.Struct({
  // Null means unmigrated; empty is authoritative and must not resurrect cleared preferences.
  favorites: Schema.NullOr(ModelFavorites).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  providerModelPreferences: Schema.NullOr(ProviderModelPreferences).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  worktreeCleanup: WorktreeCleanup.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  storageCleanup: StorageCleanupSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(Schema.decodeSync(StorageCleanupSettings)({}))),
  ),

  worktreesDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Server-maintained history keeps old worktrees eligible for cleanup and review diffs. */
  previousWorktreesDirectories: Schema.Array(TrimmedString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  responseStreamingMode: ResponseStreamingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("paragraph" as const)),
  ),
  enableProviderUpdateChecks: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  continueThreadsAfterServerUpdate: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),

  enableAgentBrowserAccess: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Which notification categories may raise an alert. Server-authoritative because
   * the Web Push relay sends from the server and cannot read a client's
   * localStorage; the foreground notifier reads the same field so both paths agree.
   * Every category defaults on, so an existing install behaves exactly as before.
   */
  notificationCategories: NotificationCategorySettings,
  projectAgentBrowserAccessOverrides: Schema.Record(ProjectId, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  defaultAutoPull: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  defaultProjectScripts: Schema.Array(ProjectScript).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  projectScriptOverrides: Schema.Record(ProjectId, Schema.NullOr(Schema.Array(ProjectScript))).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  projectAutoPullOverrides: Schema.Record(ProjectId, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  defaultModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  fallbackModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  defaultRuntimeMode: RuntimeMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE)),
  ),

  projectSettingsOverrides: Schema.Record(ProjectId, ProjectSettingsOverrides).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  /** Fold once so restarts cannot undo later UI resets. */
  projectSettingsFolded: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),

  enableAgentDeviceAccess: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Enabling the Device panel must not grant providers device control. */
  enableDeviceSupport: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  deviceOnboardingCompleted: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  deviceHosts: SshDeviceHostConfigs.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  easDeviceHosts: EasDeviceHostConfigs.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  simlockDeviceHosts: SimlockDeviceHostConfigs.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Alpha: Simlock device hosts. Off, the server ignores `simlockDeviceHosts`. */
  simlockDeviceHostsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  sidebarAutoSettleAfterDays: Schema.NullOr(SidebarAutoSettleAfterDays).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS)),
  ),
  compactIdleThreads: LegacyCompactIdleThreads.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  idleCompaction: Schema.optionalKey(IdleCompactionMode),
  snoozeLimitedThreads: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  autoResumeLimitedThreads: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  snoozePresets: SnoozePresetSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SNOOZE_PRESETS)),
  ),
  /** Beta: guest links for this machine's threads. Off refuses new links and pauses existing ones. */
  guestSharingEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * Beta: links to the user's other machines, both ways. Off refuses new links, calls over links
   * and tasks on another machine; tasks already running there finish.
   */
  linkedEnvironmentsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  sidebarAutoSettleKeepPullRequests: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  sidebarAutoSettleOnMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  backgroundActivity: BackgroundActivitySettings,

  automaticGitFetchInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
    ),
  ),
  providerHealthRefreshInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL)),
    ),
  ),
  backgroundActivityProfile: BackgroundActivityProfile.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_BACKGROUND_ACTIVITY_PROFILE)),
  ),
  defaultTheme: DefaultThemePreference.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Distinguishes repeated sets of the same theme so clients apply each one. */
  defaultThemeSetAt: Schema.String.check(Schema.isMaxLength(64)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
  environmentIcon: ForwardCompatibleNullable(EnvironmentMachineKind).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Null inherits t3.json, then local; omit it on the wire for older clients requiring a literal. */
  defaultThreadEnvMode: OmittedWhenNull(ThreadEnvMode),
  newWorktreesStartFromOrigin: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  /** Null inherits t3.json, then recursive; unknown values decode to null for older clients. */
  worktreeSubmodules: ForwardCompatibleNullable(WorktreeSubmodules).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  addProjectBaseDirectory: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Jira site that ticket keys link to, as typed. Empty turns linking off. */
  jiraBaseUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Comma- or space-separated Jira project keys, as typed; parsed by `resolveJiraTicketLinks`. */
  jiraProjectKeys: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_TEXT_GENERATION_MODEL,
        options: [
          {
            id: "reasoningEffort",
            value: DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
          },
        ],
      }),
    ),
  ),
  threadTitleInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  branchNamingMode: BranchNamingMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("static" as const)),
  ),
  branchNamePrefix: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("t3"))),
  branchNameInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  removeAgentCreditsOnMerge: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  sourceControlWritingStyle: SourceControlWritingStyleSetting.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  sourceControlWriterModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  reviewGuidesEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  reviewGuideModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  reviewGuideInstructions: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),

  pullRequestMergeMethod: Schema.NullOr(PullRequestMergeMethod).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),

  // Schema.Unknown preserves unknown-driver configs across versions; see providerInstance.ts.
  providerInstances: Schema.Record(ProviderInstanceId, ProviderInstanceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // Sidebar local-model manager (mlx-serve) configuration.
  // DEPRECATED: read only to migrate into `localLlm` on first decode.
  localModels: LocalModelsSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // Local LLM overhaul: catalog-driven provider overrides + user model configs.
  localLlm: LocalLlmSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // Opt-in open access: every client is authenticated with admin scopes, i.e. authentication is
  // disabled, not just the pairing UI. Overridable per launch via T3CODE_DISABLE_AUTH or
  // --disable-auth; read once at startup.
  disableAuthentication: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  // Master switch for subagent offload. Off writes every thread's flag file as
  // `default`; `subagentBackend.set` then refuses a Cursor selection but still admits
  // `default`, so the machine-wide file never strands on a Cursor target with no way to
  // clear it; and the controls stay visible, saying why they cannot be used.
  subagentBackendEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
    // Same containment as `autoCompactWindow`/`outputStyle` above. An undecodable value
    // reads as `true`, the default.
    Schema.catchDecoding(() => Effect.succeedSome(true)),
  ),
  subagentBackendThreadModes: SubagentBackendThreadModes.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
    // Same containment as `autoCompactWindow`/`outputStyle` above. Degrading the whole map
    // to `{}` means every thread inherits — the conservative direction, since only an
    // explicit `"on"` enables offload.
    Schema.catchDecoding(() => Effect.succeedSome({})),
  ),
  // When false, a provider instance whose published usage windows report 100% is blocked:
  // running turns on it are interrupted and new ones are refused. Default true, so an
  // environment that never touches this setting behaves exactly as before.
  allowSpendingCredits: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
    // Same containment as `subagentBackendEnabled` above. An undecodable value reads as
    // `true`, the default — the direction that keeps working rather than the one that
    // silently stops every provider.
    Schema.catchDecoding(() => Effect.succeedSome(true)),
  ),
  sourceControlHosts: Schema.Record(Schema.String, SourceControlHostSettings).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  // User-chosen ids preserve rows across edits; undecodable entries round-trip untouched.
  usageLimitSources: Schema.Record(UsageLimitSourceId, UsageLimitSourceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  cursorKeychainUsageEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),

  usagePriceOverrides: Schema.Record(TrimmedNonEmptyString, UsageModelPriceOverride).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  // How many threads the sidebar Queue lets be busy before it sends. Absent until first set, so a
  // device's older local value can be imported without overwriting one already here. Any stored
  // shape decodes (bad values clamp, non-objects read as absent): it must never fail the file.
  queueSlots: Schema.optionalKey(Schema.Unknown).pipe(
    Schema.decodeTo(
      Schema.optionalKey(QueueSlotSettings),
      SchemaTransformation.transformOptional({
        decode: (stored) =>
          Option.isSome(stored) && isPlainObject(stored.value)
            ? Option.some(normalizeQueueSlots(stored.value))
            : Option.none(),
        encode: (value) => value,
      }),
    ),
  ),
  usageModelAliases: Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  // User-defined sidebar sections, keyed by id. Membership lives on each thread
  // (`sidebarSectionId`); this is only the definitions. Lenient like `queueSlots`.
  sidebarSections: Schema.Unknown.pipe(
    Schema.decodeTo(
      Schema.Record(Schema.String, SidebarSectionDefinition),
      SchemaTransformation.transform<Record<string, SidebarSectionDefinition>, unknown>({
        decode: normalizeSidebarSections,
        encode: (value) => value,
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export const providerInstanceConfigEnabledFlag = (config: unknown): boolean | undefined => {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }
  const enabled = (config as { readonly enabled?: unknown }).enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
};

// Must match each driver's enabled decoding default.
const DEFAULT_DISABLED_PROVIDER_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set(
  ["cursor", "grok", "fx", "muse", "pi", "opencode", "antigravity"].map((driver) =>
    ProviderDriverKind.make(driver),
  ),
);

const DEFAULT_ENABLED_DEFAULT_INSTANCES: ReadonlySet<ProviderInstanceId> = new Set(
  ["codex", "claudeAgent"].map((instanceId) => ProviderInstanceId.make(instanceId)),
);

export const isUnconfiguredDefaultInstanceEnabled = (instanceId: ProviderInstanceId): boolean =>
  DEFAULT_ENABLED_DEFAULT_INSTANCES.has(instanceId);

const defaultEnabledForDriver = (driver: ProviderDriverKind): boolean =>
  !DEFAULT_DISABLED_PROVIDER_DRIVERS.has(driver);

export const resolveProviderInstanceEnabled = (
  instance: Pick<ProviderInstanceConfig, "driver" | "enabled" | "config">,
): boolean => {
  const configEnabled = providerInstanceConfigEnabledFlag(instance.config);
  if (instance.enabled === false || configEnabled === false) {
    return false;
  }
  return instance.enabled ?? configEnabled ?? defaultEnabledForDriver(instance.driver);
};

export const resolveProjectProviderInstanceEnabled = (
  settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">,
  projectId: ProjectId | null,
  instanceId: ProviderInstanceId,
): boolean => {
  const override =
    projectId === null
      ? undefined
      : settings.projectSettingsOverrides[projectId]?.providerInstances?.[instanceId]?.enabled;
  if (override !== undefined) return override;
  const instanceConfig = Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId]
    : undefined;
  return instanceConfig !== undefined
    ? resolveProviderInstanceEnabled(instanceConfig)
    : isUnconfiguredDefaultInstanceEnabled(instanceId);
};

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

type IdleCompactionSettings = Pick<ServerSettings, "compactIdleThreads" | "idleCompaction">;

/** The environment-wide idle compaction mode, from whichever field the settings carry. */
export const globalIdleCompaction = (settings: IdleCompactionSettings): IdleCompactionMode =>
  settings.idleCompaction ??
  (typeof settings.compactIdleThreads === "string"
    ? settings.compactIdleThreads
    : settings.compactIdleThreads
      ? "beforeCacheExpires"
      : "onReturn");

/** Sets the mode, and the legacy switch shipped clients still read alongside it. */
export const withIdleCompaction = <S extends IdleCompactionSettings>(
  settings: S,
  mode: IdleCompactionMode,
): S => ({ ...settings, idleCompaction: mode, compactIdleThreads: mode === "beforeCacheExpires" });

/** Whether a server reads modes, rather than only the boolean switch from before them. */
export const readsIdleCompactionModes = (settings: IdleCompactionSettings) =>
  settings.idleCompaction !== undefined || typeof settings.compactIdleThreads === "string";

/**
 * The patch that sets `mode` in the form the server's settings show it reads:
 * the mode for a server that has `idleCompaction` or kept the mode in the legacy
 * field, the boolean switch for a server from before modes.
 */
export const idleCompactionPatch = (settings: IdleCompactionSettings, mode: IdleCompactionMode) =>
  settings.idleCompaction !== undefined
    ? { idleCompaction: mode }
    : readsIdleCompactionModes(settings)
      ? { compactIdleThreads: mode }
      : { compactIdleThreads: mode === "beforeCacheExpires" };

export const resolveIdleCompaction = (
  settings: Pick<ServerSettings, "providerInstances" | "compactIdleThreads" | "idleCompaction">,
  instanceId: ProviderInstanceId,
): IdleCompactionMode => {
  const instance = Object.hasOwn(settings.providerInstances, instanceId)
    ? settings.providerInstances[instanceId]
    : undefined;
  const override = decodeClaudeSettings(instance?.config ?? {}).pipe(
    Option.map((config) => config.idleCompaction),
    Option.getOrElse(() => "default" as const),
  );
  return override === "default" ? globalIdleCompaction(settings) : override;
};

export const ServerSettingsOperation = Schema.Literals([
  "normalize",
  "check-exists",
  "create-provider-instance",
  "read-file",
  "read-provider-history",
  "read-project-settings",
  "read-secret",
  "remove-secret",
  "remove-stale-secret",
  "write-secret",
  "write-file",
  "prepare-directory",
]);
export type ServerSettingsOperation = typeof ServerSettingsOperation.Type;

export class ServerSettingsError extends Schema.TaggedError<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    operation: ServerSettingsOperation,
    providerInstanceId: Schema.optional(Schema.String),
    environmentVariable: Schema.optional(Schema.String),
    /** Why the operation was refused, when nothing threw. */
    reason: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const provider =
      this.providerInstanceId === undefined ? "" : ` for provider ${this.providerInstanceId}`;
    const variable =
      this.environmentVariable === undefined
        ? ""
        : ` and environment variable ${this.environmentVariable}`;
    const reason = this.reason === undefined ? "" : `: ${this.reason}`;
    return `Server settings ${this.operation} failed${provider}${variable} at ${this.settingsPath}${reason}.`;
  }
}

export type UnifiedSettings = Omit<ServerSettings, keyof ModelPreferences> & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

const ModelSelectionPatch = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  model: Schema.optionalKey(TrimmedNonEmptyString),
  options: Schema.optionalKey(ProviderOptionSelections),
});

export const ServerSettingsPatch = Schema.Struct({
  setModelFavorites: Schema.optionalKey(
    Schema.Array(Schema.Struct({ ...ModelFavorite.fields, favorite: Schema.Boolean })),
  ),
  setModelsHidden: Schema.optionalKey(
    Schema.Array(Schema.Struct({ ...ModelFavorite.fields, hidden: Schema.Boolean })),
  ),
  setProviderModelOrder: Schema.optionalKey(
    Schema.Struct({ provider: ProviderInstanceId, modelOrder: Schema.Array(TrimmedString) }),
  ),
  favorites: Schema.optionalKey(ModelFavorites),
  providerModelPreferences: Schema.optionalKey(ProviderModelPreferences),
  // Applied under the settings service's write lock, only while still unset.
  migrateModelPreferences: Schema.optionalKey(
    Schema.Struct({
      favorites: Schema.optionalKey(ModelFavorites),
      providerModelPreferences: Schema.optionalKey(ProviderModelPreferences),
    }),
  ),
  worktreeCleanup: Schema.optionalKey(
    Schema.NullOr(
      Schema.Union([
        Schema.Struct({ mode: Schema.Literal("off") }),
        Schema.Struct({
          mode: Schema.Literal("custom"),
          rules: Schema.Struct({
            worktreeKeepWhen: Schema.optionalKey(WorktreeKeepWhen),
            worktreeAfterDays: Schema.optionalKey(StorageRetentionDays),
            worktreeSettledAfterDays: Schema.optionalKey(SettledWorktreeRetentionDays),
            worktreeOnMerge: Schema.optionalKey(Schema.Boolean),
            worktreeOnDelete: Schema.optionalKey(Schema.Boolean),
            worktreeUnchanged: Schema.optionalKey(Schema.Boolean),
          }),
        }),
      ]),
    ),
  ),
  storageCleanup: Schema.optionalKey(
    Schema.Struct({
      worktreeKeepWhen: Schema.optionalKey(WorktreeKeepWhen),
      worktreeAfterDays: Schema.optionalKey(StorageRetentionDays),
      worktreeSettledAfterDays: Schema.optionalKey(SettledWorktreeRetentionDays),
      worktreeOnMerge: Schema.optionalKey(Schema.Boolean),
      worktreeOnDelete: Schema.optionalKey(Schema.Boolean),
      worktreeUnchanged: Schema.optionalKey(Schema.Boolean),
      browserArtifactsAfterDays: Schema.optionalKey(StorageRetentionDays),
      logsAfterDays: Schema.optionalKey(StorageRetentionDays),
    }),
  ),
  worktreesDirectory: Schema.optionalKey(TrimmedString),
  responseStreamingMode: Schema.optionalKey(ResponseStreamingMode),
  enableProviderUpdateChecks: Schema.optionalKey(Schema.Boolean),
  continueThreadsAfterServerUpdate: Schema.optionalKey(Schema.Boolean),
  enableAgentBrowserAccess: Schema.optionalKey(Schema.Boolean),
  // Every key optional so a single-category edit patches just that key. Using the
  // defaulted struct here would materialize the untouched siblings and deepMerge
  // would write them back over the user's choices.
  notificationCategories: Schema.optionalKey(
    Schema.Struct({
      finished: Schema.optionalKey(Schema.Boolean),
      finishedBackground: Schema.optionalKey(Schema.Boolean),
      needsInput: Schema.optionalKey(Schema.Boolean),
      failed: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  projectAgentBrowserAccessOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Boolean)),
  ),
  defaultAutoPull: Schema.optionalKey(Schema.Boolean),
  defaultProjectScripts: Schema.optionalKey(Schema.Array(ProjectScript)),
  projectScriptOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Array(ProjectScript))),
  ),
  projectAutoPullOverrides: Schema.optionalKey(
    Schema.Record(ProjectId, Schema.NullOr(Schema.Boolean)),
  ),
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  defaultRuntimeMode: Schema.optionalKey(RuntimeMode),
  fallbackModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  /** Replaces each project's override set; null removes it. Omitted providerInstances retains its stored value. */
  projectSettingsOverrides: Schema.optionalKey(
    Schema.Record(
      ProjectId,
      Schema.NullOr(
        Schema.Struct({
          ...ProjectSettingsOverrides.fields,
          sourceControlWritingStyle: Schema.optionalKey(SourceControlWritingStyleSettings),
        }),
      ),
    ),
  ),
  enableAgentDeviceAccess: Schema.optionalKey(Schema.Boolean),
  enableDeviceSupport: Schema.optionalKey(Schema.Boolean),
  deviceOnboardingCompleted: Schema.optionalKey(Schema.Boolean),
  deviceHosts: Schema.optionalKey(SshDeviceHostConfigs),
  easDeviceHosts: Schema.optionalKey(EasDeviceHostConfigs),
  simlockDeviceHosts: Schema.optionalKey(SimlockDeviceHostConfigs),
  simlockDeviceHostsEnabled: Schema.optionalKey(Schema.Boolean),
  sidebarAutoSettleAfterDays: Schema.optionalKey(Schema.NullOr(SidebarAutoSettleAfterDays)),
  compactIdleThreads: Schema.optionalKey(LegacyCompactIdleThreads),
  idleCompaction: Schema.optionalKey(IdleCompactionMode),
  sidebarAutoSettleKeepPullRequests: Schema.optionalKey(Schema.Boolean),
  sidebarAutoSettleOnMerge: Schema.optionalKey(Schema.Boolean),
  autoResumeLimitedThreads: Schema.optionalKey(Schema.Boolean),
  snoozeLimitedThreads: Schema.optionalKey(Schema.Boolean),
  snoozePresets: Schema.optionalKey(SnoozePresetSettings),
  guestSharingEnabled: Schema.optionalKey(Schema.Boolean),
  linkedEnvironmentsEnabled: Schema.optionalKey(Schema.Boolean),
  backgroundActivity: Schema.optionalKey(
    Schema.Struct({
      schemaVersion: Schema.optionalKey(Schema.Literal(1)),
      profile: Schema.optionalKey(BackgroundActivityProfileSelection),
      baseProfile: Schema.optionalKey(BackgroundActivityProfile),
      overrides: Schema.optionalKey(BackgroundActivityOverrides),
    }),
  ),
  automaticGitFetchInterval: Schema.optionalKey(Schema.DurationFromMillis),
  providerHealthRefreshInterval: Schema.optionalKey(Schema.DurationFromMillis),
  backgroundActivityProfile: Schema.optionalKey(BackgroundActivityProfile),
  environmentIcon: Schema.optionalKey(Schema.NullOr(EnvironmentMachineKind)),
  defaultThreadEnvMode: Schema.optionalKey(Schema.NullOr(ThreadEnvMode)),
  newWorktreesStartFromOrigin: Schema.optionalKey(Schema.Boolean),
  worktreeSubmodules: Schema.optionalKey(Schema.NullOr(WorktreeSubmodules)),
  addProjectBaseDirectory: Schema.optionalKey(TrimmedString),
  jiraBaseUrl: Schema.optionalKey(TrimmedString),
  jiraProjectKeys: Schema.optionalKey(TrimmedString),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  threadTitleInstructions: Schema.optionalKey(TrimmedString),
  branchNamingMode: Schema.optionalKey(BranchNamingMode),
  branchNamePrefix: Schema.optionalKey(TrimmedString),
  branchNameInstructions: Schema.optionalKey(TrimmedString),
  removeAgentCreditsOnMerge: Schema.optionalKey(Schema.Boolean),
  sourceControlWritingStyle: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.optionalKey(SourceControlWritingStyleMode),
      customInstructions: Schema.optionalKey(TrimmedString),
      followChangeRequestTemplates: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  sourceControlWriterModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  reviewGuidesEnabled: Schema.optionalKey(Schema.Boolean),
  reviewGuideModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  reviewGuideInstructions: Schema.optionalKey(TrimmedString),
  pullRequestMergeMethod: Schema.optionalKey(Schema.NullOr(PullRequestMergeMethod)),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(TrimmedString),
      otlpMetricsUrl: Schema.optionalKey(TrimmedString),
      otlpLogsUrl: Schema.optionalKey(TrimmedString),
    }),
  ),
  /** Merges per host, replacing patched fields whole; redaction markers retain secrets, empty or omitted secrets remove them. */
  sourceControlHosts: Schema.optionalKey(Schema.Record(Schema.String, SourceControlHostSettings)),
  // Replace whole maps to avoid half-merged driver configs.
  providerInstances: Schema.optionalKey(Schema.Record(ProviderInstanceId, ProviderInstanceConfig)),
  // Whole-object replacement (like providerInstances): deepMerge never deletes keys, so only a
  // replacement lets removing a `perModel` / `ds4.perModel` key persist.
  localModels: Schema.optionalKey(LocalModelsSettings),
  // Whole-object replacement, same rationale: removing a provider override must persist.
  localLlm: Schema.optionalKey(LocalLlmSettings),
  subagentBackendEnabled: Schema.optionalKey(Schema.Boolean),
  // A partial record: one thread's entry merges over the map (`deepMerge`), so a
  // client patches `{ [threadId]: mode }` without resending every other thread.
  subagentBackendThreadModes: Schema.optionalKey(SubagentBackendThreadModes),
  allowSpendingCredits: Schema.optionalKey(Schema.Boolean),
  // `disableAuthentication` is deliberately NOT patchable: it is a startup-only switch that boot
  // falls back to when persisted, so a settings-write client could turn auth off for the next
  // restart (standard-to-administrative escalation). No UI ever sent it.
  // Merge per source to avoid racing other edits; null removes an entry.
  usageLimitSources: Schema.optionalKey(
    Schema.Record(UsageLimitSourceId, Schema.NullOr(UsageLimitSourceConfig)),
  ),
  cursorKeychainUsageEnabled: Schema.optionalKey(Schema.Boolean),

  usagePriceOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, Schema.NullOr(UsageModelPriceOverride)),
  ),
  // Partial: only the changed fields, merged per key (and per provider entry) over the server's value.
  queueSlots: Schema.optionalKey(
    Schema.Struct({
      slots: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_QUEUE_SLOTS })),
      ),
      perProvider: Schema.optionalKey(Schema.Boolean),
      providerSlots: Schema.optionalKey(
        Schema.Record(
          Schema.String,
          Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_QUEUE_SLOTS })),
        ),
      ),
    }),
  ),
  // A device's whole local value, applied only when this server has no `queueSlots` yet.
  queueSlotsImport: Schema.optionalKey(QueueSlotSettings),
  usageModelAliases: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, Schema.NullOr(TrimmedNonEmptyString)),
  ),
  /** Per entry, like `usageLimitSources`: `null` deletes; a rename resends the whole entry. */
  sidebarSections: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.NullOr(SidebarSectionDefinition)),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export function requiredScopesForServerSettingsPatch(
  patch: ServerSettingsPatch,
): ReadonlyArray<AuthEnvironmentScope> {
  let changesProviders = false;
  let changesSettings = false;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "providers" || key === "providerInstances" || key === "usageLimitSources") {
      changesProviders = true;
    } else {
      changesSettings = true;
    }
  }
  return [
    ...(changesSettings || !changesProviders ? [AuthSettingsWriteScope] : []),
    ...(changesProviders ? [AuthProvidersManageScope] : []),
  ];
}

/** Host-executed project scripts require settings-write authority in addition to orchestration:operate. */
export function requiredScopesForProjectMutation(
  mutation: ProjectMutation,
): ReadonlyArray<AuthEnvironmentScope> {
  if (mutation.type === "project.delete" || mutation.scripts === undefined) {
    return [AuthOrchestrationOperateScope];
  }
  return [
    AuthOrchestrationOperateScope,
    ...requiredScopesForServerSettingsPatch({ defaultProjectScripts: mutation.scripts }),
  ];
}

export const ClientSettingsPatch = Schema.Struct({
  notificationMode: Schema.optionalKey(NotificationMode),
  inAppNotificationsEnabled: Schema.optionalKey(Schema.Boolean),
  diffColorScheme: Schema.optionalKey(DiffColorScheme),
  chatWidth: Schema.optionalKey(ChatWidth),
  effortDisplay: Schema.optionalKey(EffortDisplay),
  loadBalancingEnabled: Schema.optionalKey(Schema.Boolean),
  loadBalancingWeights: Schema.optionalKey(LoadBalancingWeights),
  appearanceContrast: Schema.optionalKey(AppearanceContrast),
  panelAnimationDurationMs: Schema.optionalKey(PanelAnimationDurationMs),
  browserDefaultViewport: Schema.optionalKey(PreviewViewportSetting),
  browserDefaultZoomFactor: Schema.optionalKey(PreviewZoomFactor),
  browserDefaultAppearance: Schema.optionalKey(PreviewAppearancePreference),
  browserRecordingFrameRate: Schema.optionalKey(BrowserRecordingFrameRate),
  browserRecordingShowKeyPresses: Schema.optionalKey(Schema.Boolean),
  browserRecordingShowMousePresses: Schema.optionalKey(Schema.Boolean),
  browserLinkTarget: Schema.optionalKey(BrowserLinkTarget),
  browserSearchEngine: Schema.optionalKey(BrowserSearchEngine),
  browserCustomSearchUrl: Schema.optionalKey(BrowserCustomSearchUrl),
  browserAutoShowFloatingPreview: Schema.optionalKey(Schema.Boolean),
  composerShortcuts: Schema.optionalKey(Schema.Array(ComposerShortcut)),
  browserProfiles: Schema.optionalKey(Schema.Array(BrowserProfile)),
  browserDefaultProfileId: Schema.optionalKey(BrowserProfileId),
  confirmQuit: Schema.optionalKey(QuitConfirmationMode),
  confirmThreadArchive: Schema.optionalKey(Schema.Boolean),
  confirmThreadDelete: Schema.optionalKey(Schema.Boolean),
  confirmThreadUnpin: Schema.optionalKey(Schema.Boolean),
  diffFilesCollapsed: Schema.optionalKey(Schema.Boolean),
  diffIgnoreWhitespace: Schema.optionalKey(Schema.Boolean),
  diffLayout: Schema.optionalKey(DiffLayout),
  environmentIdentificationMode: Schema.optionalKey(EnvironmentIdentificationMode),
  glassOpacity: Schema.optionalKey(GlassOpacity),
  notifyOnThreadCompletion: Schema.optionalKey(Schema.Boolean),
  onboardingCompletedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  fontSizeInterface: Schema.optionalKey(InterfaceFontSize),
  fontSizePrompt: Schema.optionalKey(PromptFontSize),
  fontSizeCode: Schema.optionalKey(CodeFontSize),
  fontSizeTerminal: Schema.optionalKey(TerminalFontSize),
  fontFamilyCode: Schema.optionalKey(FontFamilyPreference),
  fontFamilyComposer: Schema.optionalKey(FontFamilyPreference),
  fontFamilySans: Schema.optionalKey(FontFamilyPreference),
  fontFamilyTerminal: Schema.optionalKey(FontFamilyPreference),
  fontSmoothing: Schema.optionalKey(Schema.Boolean),
  persistComposerContextStrip: Schema.optionalKey(Schema.Boolean),
  favorites: Schema.optionalKey(ModelFavorites),
  providerModelPreferences: Schema.optionalKey(ProviderModelPreferences),
  composerContextStripCollapsed: Schema.optionalKey(Schema.Boolean),
  pullRequestMergeMethodOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, PullRequestMergeMethod),
  ),
  pullRequestLinksOpenInApp: Schema.optionalKey(Schema.Boolean),
  planModeEnabled: Schema.optionalKey(Schema.Boolean),
  contextWindowMeterEnabled: Schema.optionalKey(Schema.Boolean),
  composerRichTextEnabled: Schema.optionalKey(Schema.Boolean),
  sendShortcut: Schema.optionalKey(Schema.Literals(["enter", "mod-enter-multiline", "mod-enter"])),
  followUpBehavior: Schema.optionalKey(Schema.Literals(["queue", "steer"])),
  proactivePanelsEnabled: Schema.optionalKey(Schema.Boolean),
  showSkillsInSlashMenu: Schema.optionalKey(Schema.Boolean),
  boringSidebarEnabled: Schema.optionalKey(Schema.Boolean),
  boringSidebarMultilineRows: Schema.optionalKey(Schema.Boolean),
  threadDetailsUsageEnabled: Schema.optionalKey(Schema.Boolean),
  threadDetailsItems: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
  legacySidebarEnabled: Schema.optionalKey(Schema.Boolean),
  alwaysShowMessageTimestamps: Schema.optionalKey(Schema.Boolean),
  sidebarWorkingShelfEnabled: Schema.optionalKey(Schema.Boolean),
  sidebarProjectGroupingMode: Schema.optionalKey(SidebarProjectGroupingMode),
  sidebarProjectGroupingOverrides: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, SidebarProjectGroupingMode),
  ),
  sidebarProjectSortOrder: Schema.optionalKey(SidebarProjectSortOrder),
  sidebarThreadSortOrder: Schema.optionalKey(SidebarThreadSortOrder),
  timestampFormat: Schema.optionalKey(TimestampFormat),
  usagePaceTolerance: Schema.optionalKey(UsagePaceTolerance),
  threadDetailsSectionRowLimit: Schema.optionalKey(ThreadDetailsSectionRowLimit),
  snapShotEnabled: Schema.optionalKey(Schema.Boolean),
  snapShotIncludeAccessibility: Schema.optionalKey(Schema.Boolean),
  snapShotShortcut: Schema.optionalKey(SnapShotShortcut),
  snapShotPlaySound: Schema.optionalKey(Schema.Boolean),
  snapShotSound: Schema.optionalKey(SnapShotSound),
  snapShotFlash: Schema.optionalKey(Schema.Boolean),
  snapShotAnimations: Schema.optionalKey(Schema.Boolean),
  wordWrap: Schema.optionalKey(Schema.Boolean),
  mathRenderingEnabled: Schema.optionalKey(Schema.Boolean),
});
export type ClientSettingsPatch = typeof ClientSettingsPatch.Type;
