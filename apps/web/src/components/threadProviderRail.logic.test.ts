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
