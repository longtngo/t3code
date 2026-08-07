import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  resolveThreadProviderInstanceId,
  resolveThreadProviderPresentation,
  type ThreadProviderAccentSource,
} from "./threadProviderRail.logic";

const uniSub = ProviderInstanceId.make("claudeAgent");
const personalSub = ProviderInstanceId.make("claudeAgent_personalsub");

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
    { instanceId: uniSub, displayName: "UniSub", accentColor: "#ea580c" },
    { instanceId: personalSub, displayName: "PersonalSub", accentColor: "#16a34a" },
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
      resolveThreadProviderPresentation(uniSub, [{ instanceId: uniSub, displayName: "UniSub" }]),
    ).toBeUndefined();
  });

  it("treats a malformed accent as absent rather than passing it to the DOM", () => {
    for (const accentColor of ["red", "#fff", "#12345g", "ea580c", ""]) {
      expect(
        resolveThreadProviderPresentation(uniSub, [{ instanceId: uniSub, accentColor }]),
      ).toBeUndefined();
    }
  });

  it("announces the instance id when the snapshot carries no display name", () => {
    expect(
      resolveThreadProviderPresentation(uniSub, [{ instanceId: uniSub, accentColor: "#ea580c" }]),
    ).toEqual({ accentColor: "#ea580c", displayName: "claudeAgent" });
  });

  it("keeps instances that share an accent distinguishable by name", () => {
    const shared: ReadonlyArray<ThreadProviderAccentSource> = [
      { instanceId: ProviderInstanceId.make("claudeAgent_qwen"), displayName: "Qwen", accentColor: "#7c3aed" },
      { instanceId: ProviderInstanceId.make("codex"), displayName: "PersonalSub", accentColor: "#7c3aed" },
    ];
    const qwen = resolveThreadProviderPresentation(ProviderInstanceId.make("claudeAgent_qwen"), shared);
    const codex = resolveThreadProviderPresentation(ProviderInstanceId.make("codex"), shared);
    expect(qwen?.accentColor).toBe(codex?.accentColor);
    expect(qwen?.displayName).toBe("Qwen");
    expect(codex?.displayName).toBe("PersonalSub");
  });
});
