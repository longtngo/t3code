import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  resolveThreadProviderInstanceId,
  resolveThreadProviderPresentation,
  type ThreadProviderAccentSource,
} from "./threadProviderRail.logic";

const uniSub = ProviderInstanceId.make("claudeAgent");
const personalSub = ProviderInstanceId.make("claudeAgent_personalsub");
const claudeKind = ProviderDriverKind.make("claudeAgent");
const codexKind = ProviderDriverKind.make("codex");

function thread(input: {
  selection: ProviderInstanceId;
  sessionInstance?: ProviderInstanceId | undefined;
  hasSession?: boolean;
}) {
  return {
    modelSelection: { instanceId: input.selection },
    session:
      input.hasSession === false
        ? null
        : input.sessionInstance !== undefined || input.hasSession === true
          ? { providerInstanceId: input.sessionInstance }
          : null,
  };
}

describe("resolveThreadProviderInstanceId", () => {
  it("uses the thread's stored selection when there is no session", () => {
    expect(resolveThreadProviderInstanceId(thread({ selection: uniSub, hasSession: false }))).toBe(
      uniSub,
    );
  });

  it("prefers a live session's provider over the stored selection", () => {
    expect(
      resolveThreadProviderInstanceId(
        thread({ selection: uniSub, sessionInstance: personalSub }),
      ),
    ).toBe(personalSub);
  });

  it("falls back to the stored selection when a session carries no provider", () => {
    expect(
      resolveThreadProviderInstanceId(thread({ selection: uniSub, hasSession: true })),
    ).toBe(uniSub);
  });
});

describe("resolveThreadProviderPresentation", () => {
  const providers: ReadonlyArray<ThreadProviderAccentSource> = [
    { instanceId: uniSub, driver: claudeKind, displayName: "UniSub", accentColor: "#ea580c" },
    { instanceId: personalSub, driver: claudeKind, displayName: "PersonalSub", accentColor: "#16a34a" },
  ];

  it("resolves the accent and name of a known instance", () => {
    expect(resolveThreadProviderPresentation(uniSub, providers)).toEqual({
      accentColor: "#ea580c",
      displayName: "UniSub",
    });
  });

  it("returns nothing for an instance this environment does not know", () => {
    expect(
      resolveThreadProviderPresentation(ProviderInstanceId.make("codex"), providers),
    ).toBeUndefined();
  });

  it("returns nothing when the instance has no accent colour", () => {
    expect(
      resolveThreadProviderPresentation(uniSub, [{ instanceId: uniSub, driver: claudeKind, displayName: "UniSub" }]),
    ).toBeUndefined();
  });

  it("treats a malformed accent as absent rather than passing it to the DOM", () => {
    for (const accentColor of ["red", "#fff", "#12345g", "ea580c", ""]) {
      expect(
        resolveThreadProviderPresentation(uniSub, [{ instanceId: uniSub, driver: claudeKind, accentColor }]),
      ).toBeUndefined();
    }
  });

  it("announces the instance id when the snapshot carries no display name", () => {
    expect(
      resolveThreadProviderPresentation(uniSub, [{ instanceId: uniSub, driver: claudeKind, accentColor: "#ea580c" }]),
    ).toEqual({ accentColor: "#ea580c", displayName: "claudeAgent" });
  });

  it("qualifies a display name shared by two instances with its driver", () => {
    // Naming the Claude and Codex instances of one subscription alike is normal; the bare
    // name then identifies nothing, which is exactly when the driver has to appear.
    const sameName: ReadonlyArray<ThreadProviderAccentSource> = [
      { instanceId: personalSub, driver: claudeKind, displayName: "PersonalSub", accentColor: "#16a34a" },
      { instanceId: ProviderInstanceId.make("codex"), driver: codexKind, displayName: "PersonalSub", accentColor: "#7c3aed" },
    ];
    expect(resolveThreadProviderPresentation(personalSub, sameName)?.displayName).toBe(
      "PersonalSub (Claude)",
    );
    expect(
      resolveThreadProviderPresentation(ProviderInstanceId.make("codex"), sameName)?.displayName,
    ).toBe("PersonalSub (Codex)");
  });

  it("leaves an unambiguous display name unqualified", () => {
    expect(resolveThreadProviderPresentation(uniSub, providers)?.displayName).toBe("UniSub");
  });

  it("omits the monogram when the accent is unique", () => {
    expect(resolveThreadProviderPresentation(uniSub, providers)?.initials).toBeUndefined();
  });

  it("adds a monogram to every instance sharing an accent", () => {
    const qwenId = ProviderInstanceId.make("claudeAgent_qwen");
    const codexId = ProviderInstanceId.make("codex");
    const clashing: ReadonlyArray<ThreadProviderAccentSource> = [
      { instanceId: uniSub, driver: claudeKind, displayName: "UniSub", accentColor: "#ea580c" },
      { instanceId: qwenId, driver: claudeKind, displayName: "Qwen", accentColor: "#7c3aed" },
      { instanceId: codexId, driver: codexKind, displayName: "Gemma 4 26B", accentColor: "#7c3aed" },
    ];
    expect(resolveThreadProviderPresentation(qwenId, clashing)?.initials).toBe("QW");
    expect(resolveThreadProviderPresentation(codexId, clashing)?.initials).toBe("G4");
    // The instance whose accent is unique stays unadorned even though others collide.
    expect(resolveThreadProviderPresentation(uniSub, clashing)?.initials).toBeUndefined();
  });

  it("initials the raw name, not the driver-qualified one", () => {
    // Regression: initialling the qualified "PersonalSub (Codex)" produced "P(" on a live row,
    // because the parenthesised driver counts as a second word to the initialler.
    const codexId = ProviderInstanceId.make("codex");
    const bothNamedAlike: ReadonlyArray<ThreadProviderAccentSource> = [
      { instanceId: personalSub, driver: claudeKind, displayName: "PersonalSub", accentColor: "#7c3aed" },
      { instanceId: codexId, driver: codexKind, displayName: "PersonalSub", accentColor: "#7c3aed" },
    ];
    const codex = resolveThreadProviderPresentation(codexId, bothNamedAlike);
    expect(codex?.displayName).toBe("PersonalSub (Codex)");
    expect(codex?.initials).toBe("PE");
    expect(codex?.initials).not.toContain("(");
  });

  it("treats differently-cased spellings of one colour as the collision they look like", () => {
    const other = ProviderInstanceId.make("codex");
    const cased: ReadonlyArray<ThreadProviderAccentSource> = [
      { instanceId: uniSub, driver: claudeKind, displayName: "UniSub", accentColor: "#EA580C" },
      { instanceId: other, driver: codexKind, displayName: "Twin", accentColor: "#ea580c" },
    ];
    expect(resolveThreadProviderPresentation(uniSub, cased)?.initials).toBe("UN");
    expect(resolveThreadProviderPresentation(other, cased)?.initials).toBe("TW");
  });

  it("does not collide an instance with an unusable accent", () => {
    const other = ProviderInstanceId.make("codex");
    const withInvalid: ReadonlyArray<ThreadProviderAccentSource> = [
      { instanceId: uniSub, driver: claudeKind, displayName: "UniSub", accentColor: "#ea580c" },
      { instanceId: other, driver: codexKind, displayName: "Broken", accentColor: "not-a-colour" },
    ];
    expect(resolveThreadProviderPresentation(uniSub, withInvalid)?.initials).toBeUndefined();
  });

  it("keeps instances that share an accent distinguishable by name", () => {
    const shared: ReadonlyArray<ThreadProviderAccentSource> = [
      { instanceId: ProviderInstanceId.make("claudeAgent_qwen"), driver: claudeKind, displayName: "Qwen", accentColor: "#7c3aed" },
      { instanceId: ProviderInstanceId.make("codex"), driver: codexKind, displayName: "PersonalSub", accentColor: "#7c3aed" },
    ];
    const qwen = resolveThreadProviderPresentation(ProviderInstanceId.make("claudeAgent_qwen"), shared);
    const codex = resolveThreadProviderPresentation(ProviderInstanceId.make("codex"), shared);
    expect(qwen?.accentColor).toBe(codex?.accentColor);
    expect(qwen?.displayName).toBe("Qwen");
    expect(codex?.displayName).toBe("PersonalSub");
  });
});
