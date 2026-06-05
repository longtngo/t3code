import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSelectedComposerInstanceId } from "./composerInstanceSelection";
import type { ProviderInstanceEntry } from "../../providerInstances";

const claudeKind = ProviderDriverKind.make("claudeAgent");
const codexKind = ProviderDriverKind.make("codex");

function makeEntry(args: {
  id: string;
  driverKind?: ProviderDriverKind;
  enabled?: boolean;
  continuationGroupKey?: string;
}): ProviderInstanceEntry {
  return {
    instanceId: ProviderInstanceId.make(args.id),
    driverKind: args.driverKind ?? claudeKind,
    displayName: args.id,
    accentColor: undefined,
    continuationGroupKey: args.continuationGroupKey,
    enabled: args.enabled ?? true,
    installed: true,
    status: "ready",
    isDefault: false,
    isAvailable: true,
    snapshot: { auth: { status: "authenticated" } } as ProviderInstanceEntry["snapshot"],
    models: [],
  } satisfies ProviderInstanceEntry;
}

const codexDisabled = makeEntry({ id: "codex", driverKind: codexKind, enabled: false });
const claude = makeEntry({ id: "claudeAgent" });
const claudePersonal = makeEntry({ id: "claude_personal" });

const baseInput = {
  draftActiveProvider: null,
  sessionInstanceId: null,
  threadSelectionInstanceId: null,
  projectDefaultInstanceId: null,
  selectedProvider: codexKind,
  lockedProvider: null,
  lockedContinuationGroupKey: null,
  instanceEntries: [codexDisabled, claudePersonal, claude],
} as const;

describe("resolveSelectedComposerInstanceId", () => {
  it("skips a persisted instance id that exists but is disabled", () => {
    // The cold-home bug: the draft fallback persisted "codex" while codex is
    // disabled; the composer must land on an enabled instance instead.
    const result = resolveSelectedComposerInstanceId({
      ...baseInput,
      threadSelectionInstanceId: "codex",
    });
    expect(result).toBe(claudePersonal.instanceId);
  });

  it("keeps an unknown persisted id verbatim while entries have not hydrated", () => {
    const result = resolveSelectedComposerInstanceId({
      ...baseInput,
      instanceEntries: [],
      threadSelectionInstanceId: "claude_custom",
    });
    expect(result).toBe("claude_custom");
  });

  it("prefers the composer draft's unsaved picker selection", () => {
    const result = resolveSelectedComposerInstanceId({
      ...baseInput,
      draftActiveProvider: "claudeAgent",
      threadSelectionInstanceId: "claude_personal",
    });
    expect(result).toBe(claude.instanceId);
  });

  it("falls back to the first enabled entry of the selected driver kind", () => {
    const result = resolveSelectedComposerInstanceId({
      ...baseInput,
      selectedProvider: claudeKind,
    });
    expect(result).toBe(claudePersonal.instanceId);
  });

  it("falls back to any enabled entry when no kind match exists", () => {
    const result = resolveSelectedComposerInstanceId({
      ...baseInput,
      selectedProvider: codexKind,
    });
    expect(result).toBe(claudePersonal.instanceId);
  });

  it("ignores persisted ids from another driver kind when locked", () => {
    const result = resolveSelectedComposerInstanceId({
      ...baseInput,
      selectedProvider: claudeKind,
      lockedProvider: claudeKind,
      projectDefaultInstanceId: "codex_enabled",
      instanceEntries: [
        makeEntry({ id: "codex_enabled", driverKind: codexKind }),
        claudePersonal,
        claude,
      ],
    });
    expect(result).toBe(claudePersonal.instanceId);
  });

  it("keeps the persisted id under a lock when no enabled instance of the locked kind exists", () => {
    // Never silently retarget a started thread at a foreign-kind instance:
    // the persisted (disabled) id must surface rather than anyEnabled winning.
    const result = resolveSelectedComposerInstanceId({
      ...baseInput,
      selectedProvider: claudeKind,
      lockedProvider: claudeKind,
      threadSelectionInstanceId: "claudeAgent",
      instanceEntries: [
        makeEntry({ id: "claudeAgent", enabled: false }),
        makeEntry({ id: "codex_enabled", driverKind: codexKind }),
      ],
    });
    expect(result).toBe(claude.instanceId);
  });

  it("keeps the persisted id under a lock when no enabled instance is in the locked group", () => {
    const result = resolveSelectedComposerInstanceId({
      ...baseInput,
      selectedProvider: claudeKind,
      lockedProvider: claudeKind,
      lockedContinuationGroupKey: "group-a",
      threadSelectionInstanceId: "claude_personal",
      instanceEntries: [
        makeEntry({ id: "claude_personal", continuationGroupKey: "group-a", enabled: false }),
        makeEntry({ id: "claudeAgent", continuationGroupKey: "group-b" }),
      ],
    });
    expect(result).toBe(claudePersonal.instanceId);
  });

  it("ignores persisted ids outside the locked continuation group", () => {
    const grouped = makeEntry({ id: "claudeAgent", continuationGroupKey: "group-a" });
    const other = makeEntry({ id: "claude_personal", continuationGroupKey: "group-b" });
    const result = resolveSelectedComposerInstanceId({
      ...baseInput,
      selectedProvider: claudeKind,
      lockedProvider: claudeKind,
      lockedContinuationGroupKey: "group-a",
      threadSelectionInstanceId: "claude_personal",
      instanceEntries: [other, grouped],
    });
    expect(result).toBe(grouped.instanceId);
  });

  it("defaults to codex with no entries and no persisted selection", () => {
    const result = resolveSelectedComposerInstanceId({
      ...baseInput,
      instanceEntries: [],
    });
    expect(result).toBe("codex");
  });
});
