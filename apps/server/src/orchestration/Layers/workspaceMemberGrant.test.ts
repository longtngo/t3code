import { describe, expect, it } from "vite-plus/test";

import { workspaceMemberGrantChanged } from "./workspaceMemberGrant.ts";

describe("workspaceMemberGrantChanged", () => {
  it("is false when the running grant already matches", () => {
    expect(
      workspaceMemberGrantChanged({
        providerGrantsMemberPaths: true,
        sessionMemberPaths: ["/srv/prm_portal_api", "/srv/warehouse"],
        desiredMemberPaths: ["/srv/prm_portal_api", "/srv/warehouse"],
      }),
    ).toBe(false);
  });

  it("is false for a project with no members on a session with no grant", () => {
    expect(
      workspaceMemberGrantChanged({
        providerGrantsMemberPaths: true,
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
        providerGrantsMemberPaths: true,
        sessionMemberPaths: undefined,
        desiredMemberPaths: ["/srv/warehouse"],
      }),
    ).toBe(true);
  });

  it("is true when a member is detached mid-thread", () => {
    expect(
      workspaceMemberGrantChanged({
        providerGrantsMemberPaths: true,
        sessionMemberPaths: ["/srv/prm_portal_api", "/srv/warehouse"],
        desiredMemberPaths: ["/srv/prm_portal_api"],
      }),
    ).toBe(true);
  });

  it("is true when a member is swapped for a different path", () => {
    expect(
      workspaceMemberGrantChanged({
        providerGrantsMemberPaths: true,
        sessionMemberPaths: ["/srv/prm_portal_api"],
        desiredMemberPaths: ["/srv/warehouse"],
      }),
    ).toBe(true);
  });

  // An adapter that never applies the grant also never echoes it, so its
  // sessions always report an empty set. Without this gate that would be
  // "changed" on every turn and restart the session each time.
  it("never reports a change for an adapter that does not apply the grant", () => {
    expect(
      workspaceMemberGrantChanged({
        providerGrantsMemberPaths: false,
        sessionMemberPaths: undefined,
        desiredMemberPaths: ["/srv/warehouse"],
      }),
    ).toBe(false);
  });
});
