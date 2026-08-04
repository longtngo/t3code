import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  providerGrantsWorkspaceMembers,
  workspaceMemberGrantChanged,
} from "./workspaceMemberGrant.ts";

describe("providerGrantsWorkspaceMembers", () => {
  it("recognises the claude driver", () => {
    expect(providerGrantsWorkspaceMembers(ProviderDriverKind.make("claudeAgent"))).toBe(true);
  });

  it("rejects drivers that ignore the grant", () => {
    expect(providerGrantsWorkspaceMembers(ProviderDriverKind.make("codex"))).toBe(false);
    expect(providerGrantsWorkspaceMembers(undefined)).toBe(false);
  });
});

describe("workspaceMemberGrantChanged", () => {
  it("is false when the running grant already matches", () => {
    expect(
      workspaceMemberGrantChanged({
        sessionProvider: ProviderDriverKind.make("claudeAgent"),
        sessionMemberPaths: ["/srv/prm_portal_api", "/srv/warehouse"],
        desiredMemberPaths: ["/srv/prm_portal_api", "/srv/warehouse"],
      }),
    ).toBe(false);
  });

  it("is false for a project with no members on a session with no grant", () => {
    expect(
      workspaceMemberGrantChanged({
        sessionProvider: ProviderDriverKind.make("claudeAgent"),
        sessionMemberPaths: undefined,
        desiredMemberPaths: [],
      }),
    ).toBe(false);
  });

  // The user-visible symptom this exists for: attaching a repository to a
  // running thread used to be a silent no-op, and the next tool call in that
  // repository prompted for approval.
  it("is true when a member is attached mid-thread", () => {
    expect(
      workspaceMemberGrantChanged({
        sessionProvider: ProviderDriverKind.make("claudeAgent"),
        sessionMemberPaths: undefined,
        desiredMemberPaths: ["/srv/warehouse"],
      }),
    ).toBe(true);
  });

  it("is true when a member is detached mid-thread", () => {
    expect(
      workspaceMemberGrantChanged({
        sessionProvider: ProviderDriverKind.make("claudeAgent"),
        sessionMemberPaths: ["/srv/prm_portal_api", "/srv/warehouse"],
        desiredMemberPaths: ["/srv/prm_portal_api"],
      }),
    ).toBe(true);
  });

  it("is true when a member is swapped for a different path", () => {
    expect(
      workspaceMemberGrantChanged({
        sessionProvider: ProviderDriverKind.make("claudeAgent"),
        sessionMemberPaths: ["/srv/prm_portal_api"],
        desiredMemberPaths: ["/srv/warehouse"],
      }),
    ).toBe(true);
  });

  // A driver that never applies the grant also never echoes it, so its
  // sessions always report an empty set. Without the driver gate this would be
  // "changed" on every turn and restart the session each time.
  it("never reports a change for a driver that does not apply the grant", () => {
    expect(
      workspaceMemberGrantChanged({
        sessionProvider: ProviderDriverKind.make("codex"),
        sessionMemberPaths: undefined,
        desiredMemberPaths: ["/srv/warehouse"],
      }),
    ).toBe(false);
  });
});
