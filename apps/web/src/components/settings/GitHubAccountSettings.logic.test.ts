import { describe, expect, it } from "vite-plus/test";

import {
  groupGitHubAccounts,
  nextGitHubHosts,
  gitHubHostPickerState,
} from "./GitHubAccountSettings.logic";

describe("groupGitHubAccounts", () => {
  it("groups logins by host, keeping broken and environment logins out of the picker", () => {
    expect(
      groupGitHubAccounts([
        { host: "github.com", account: "personal", active: true, authenticated: true },
        { host: "github.com", account: "work", active: false, authenticated: true },
        { host: "github.com", account: "old", active: false, authenticated: false, error: "bad" },
        {
          host: "github.com",
          account: "bot",
          active: false,
          authenticated: true,
          environmentVariable: "GH_TOKEN",
        },
        { host: "ghe.acme.test", account: "jm", active: false, authenticated: true },
      ]),
    ).toEqual([
      {
        host: "github.com",
        activeAccount: "personal",
        activeUsable: true,
        selectable: ["personal", "work"],
        broken: [
          { host: "github.com", account: "old", active: false, authenticated: false, error: "bad" },
        ],
        environmentVariable: "GH_TOKEN",
      },
      {
        host: "ghe.acme.test",
        activeAccount: "jm",
        activeUsable: true,
        selectable: ["jm"],
        broken: [],
        environmentVariable: null,
      },
    ]);
  });

  it("keeps gh's active login even when it is broken, and says it cannot be used", () => {
    const [group] = groupGitHubAccounts([
      { host: "github.com", account: "work", active: false, authenticated: true },
      { host: "github.com", account: "old", active: true, authenticated: false, error: "bad" },
    ]);
    expect(group).toMatchObject({ activeAccount: "old", activeUsable: false });
  });
});

describe("nextGitHubHosts", () => {
  it("pins an account, keeps other hosts, and drops a host back on gh's defaults", () => {
    const other = { "ghe.acme.test": { enabled: false } };
    const pinned = nextGitHubHosts(other, "github.com", { account: "work" });
    expect(pinned).toEqual({ ...other, "github.com": { enabled: true, account: "work" } });

    const disabled = nextGitHubHosts(pinned, "github.com", { enabled: false });
    expect(disabled["github.com"]).toEqual({ enabled: false, account: "work" });

    expect(nextGitHubHosts(disabled, "github.com", { enabled: true, account: null })).toEqual(
      other,
    );
  });
});

describe("gitHubHostPickerState", () => {
  const group = {
    selectable: ["a", "b"],
    broken: [{ host: "github.com", account: "old", active: false, authenticated: false }],
    environmentVariable: null,
  };
  const state = (
    pin: string | undefined,
    overrides: { enabled?: boolean; savedToken?: boolean; environmentVariable?: string } = {},
  ) =>
    gitHubHostPickerState({
      pin,
      enabled: overrides.enabled ?? true,
      savedToken: overrides.savedToken ?? false,
      group: { ...group, environmentVariable: overrides.environmentVariable ?? null },
    });

  it("selects per folder with no pin and the pin when gh holds it", () => {
    expect(state(undefined)).toEqual({ pinProblem: null, warning: null, override: null });
    expect(state("b")).toEqual({ pinProblem: null, warning: null, override: null });
  });

  it("tells a signed-out pin from one gh holds but GitHub rejects", () => {
    expect(state("gone")).toEqual({
      pinProblem: "signedOut",
      warning: "signedOut",
      override: null,
    });
    expect(state("old")).toEqual({ pinProblem: "broken", warning: "broken", override: null });
  });

  it("warns about the pin only when it is what requests use", () => {
    expect(state("gone", { enabled: false })).toEqual({
      pinProblem: "signedOut",
      warning: null,
      override: null,
    });
    expect(state("old", { environmentVariable: "GH_TOKEN" })).toEqual({
      pinProblem: "broken",
      warning: null,
      override: "environment",
    });
    expect(state("gone", { savedToken: true })).toEqual({
      pinProblem: "signedOut",
      warning: null,
      override: "savedToken",
    });
  });

  it("names no override for a host turned off", () => {
    expect(state("b", { enabled: false, environmentVariable: "GH_TOKEN" }).override).toBeNull();
    expect(state("b", { enabled: false, savedToken: true }).override).toBeNull();
  });

  it("names a saved token over GH_TOKEN, since the saved token is used first", () => {
    expect(state(undefined, { savedToken: true, environmentVariable: "GH_TOKEN" }).override).toBe(
      "savedToken",
    );
  });
});
