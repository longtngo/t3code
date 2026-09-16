import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  browserProfileRemovalAvailable,
  clearBrowserProfileData,
  importFailureReason,
  jiraProjectKeysStatus,
  jiraSettingsRowStatuses,
} from "./IntegrationsSettings";

const environmentId = "environment-a" as EnvironmentId;
const secondEnvironmentId = "environment-b" as EnvironmentId;

describe("clearBrowserProfileData", () => {
  it("waits for cookie and cache cleanup", async () => {
    const clearCookies = vi.fn().mockResolvedValue(undefined);
    const clearCache = vi.fn().mockResolvedValue(undefined);

    await clearBrowserProfileData({ clearCookies, clearCache }, [environmentId], "profile-a");

    expect(clearCookies).toHaveBeenCalledWith(environmentId, "profile-a");
    expect(clearCache).toHaveBeenCalledWith(environmentId, "profile-a");
  });

  it("clears every known environment before succeeding", async () => {
    const clearCookies = vi.fn().mockResolvedValue(undefined);
    const clearCache = vi.fn().mockResolvedValue(undefined);

    await clearBrowserProfileData(
      { clearCookies, clearCache },
      [environmentId, secondEnvironmentId],
      "profile-a",
    );

    expect(clearCookies.mock.calls).toEqual([
      [environmentId, "profile-a"],
      [secondEnvironmentId, "profile-a"],
    ]);
    expect(clearCache.mock.calls).toEqual([
      [environmentId, "profile-a"],
      [secondEnvironmentId, "profile-a"],
    ]);
  });

  it("propagates cleanup failures", async () => {
    const failure = new Error("clear failed");
    await expect(
      clearBrowserProfileData(
        {
          clearCookies: vi.fn().mockRejectedValue(failure),
          clearCache: vi.fn().mockResolvedValue(undefined),
        },
        [environmentId],
        "profile-a",
      ),
    ).rejects.toBe(failure);
  });

  it("does not report success without an environment or bridge", async () => {
    const bridge = {
      clearCookies: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined),
    };

    await expect(clearBrowserProfileData(bridge, [], "profile-a")).rejects.toThrow();
    await expect(clearBrowserProfileData(null, [environmentId], "profile-a")).rejects.toThrow();
    expect(bridge.clearCookies).not.toHaveBeenCalled();
    expect(bridge.clearCache).not.toHaveBeenCalled();
  });
});

describe("browserProfileRemovalAvailable", () => {
  it("requires a ready non-empty catalog and desktop bridge", () => {
    expect(browserProfileRemovalAvailable(true, true, 1)).toBe(true);
    expect(browserProfileRemovalAvailable(true, true, 0)).toBe(false);
    expect(browserProfileRemovalAvailable(true, false, 1)).toBe(false);
    expect(browserProfileRemovalAvailable(false, true, 1)).toBe(false);
  });
});

// Mirrors `BrowserImportFailedError.message`, which IPC flattens to a string
// before the renderer sees it.
const failure = (reason: string) => ({
  message: `Importing cookies from safari failed: ${reason}.`,
});

describe("importFailureReason", () => {
  it("recovers the reason token from the flattened message", () => {
    expect(importFailureReason(failure("needsFullDiskAccess"))).toBe("needsFullDiskAccess");
    expect(importFailureReason(failure("browserRunning"))).toBe("browserRunning");
    expect(importFailureReason(failure("readFailed"))).toBe("readFailed");
    expect(importFailureReason(failure("keychainUnavailable"))).toBe("keychainUnavailable");
    // A settings write that fails after the cookies landed is its own case,
    // not a read failure over a database that was in fact read.
    expect(importFailureReason(failure("profileNotSaved"))).toBe("profileNotSaved");
    expect(importFailureReason(failure("profileLimitReached"))).toBe("profileLimitReached");
  });

  it("falls back to readFailed for anything it cannot classify", () => {
    expect(importFailureReason(new Error("something else entirely"))).toBe("readFailed");
    expect(importFailureReason(undefined)).toBe("readFailed");
  });
});

describe("jiraProjectKeysStatus", () => {
  it("uses the singular phrasing for one invalid entry", () => {
    expect(jiraProjectKeysStatus(["DRST-12"])).toBe(
      "Not a project key: DRST-12. Use keys like OPS, DRST.",
    );
  });

  it("uses the plural phrasing and names every entry, up to the cap", () => {
    expect(jiraProjectKeysStatus(["DRST-12", "ß"])).toBe(
      "Not project keys: DRST-12, ß. Use keys like OPS, DRST.",
    );
    expect(jiraProjectKeysStatus(["a", "b", "c"])).toBe(
      "Not project keys: a, b, c. Use keys like OPS, DRST.",
    );
  });

  it("shows only the first three entries and counts the rest", () => {
    expect(jiraProjectKeysStatus(["a", "b", "c", "d"])).toBe(
      "Not project keys: a, b, c, and 1 more. Use keys like OPS, DRST.",
    );
    expect(jiraProjectKeysStatus(["a", "b", "c", "d", "e"])).toBe(
      "Not project keys: a, b, c, and 2 more. Use keys like OPS, DRST.",
    );
  });

  it("is undefined when nothing is invalid", () => {
    expect(jiraProjectKeysStatus([])).toBeUndefined();
  });
});

describe("jiraSettingsRowStatuses", () => {
  const base = {
    baseUrl: "",
    projectKeys: "",
    mixed: false,
    invalidBaseUrl: false,
    invalidProjectKeys: [] as ReadonlyArray<string>,
  };

  it("shows nothing when both settings are empty", () => {
    expect(jiraSettingsRowStatuses(base)).toEqual({
      baseUrlStatus: undefined,
      projectKeysStatus: undefined,
    });
  });

  it("nudges for project keys when only the URL is set", () => {
    expect(jiraSettingsRowStatuses({ ...base, baseUrl: "https://example.atlassian.net" })).toEqual({
      baseUrlStatus: undefined,
      projectKeysStatus: "Add project keys to turn on links.",
    });
  });

  it("nudges for the site URL when only the project keys are set", () => {
    expect(jiraSettingsRowStatuses({ ...base, projectKeys: "OPS" })).toEqual({
      baseUrlStatus: "Add your Jira site URL to turn on links.",
      projectKeysStatus: undefined,
    });
  });

  it("shows nothing when both settings are filled in", () => {
    expect(
      jiraSettingsRowStatuses({
        ...base,
        baseUrl: "https://example.atlassian.net",
        projectKeys: "OPS",
      }),
    ).toEqual({ baseUrlStatus: undefined, projectKeysStatus: undefined });
  });

  it("lets an invalid URL take priority on its own row over the nudge", () => {
    expect(
      jiraSettingsRowStatuses({
        ...base,
        baseUrl: "not a url",
        projectKeys: "OPS",
        invalidBaseUrl: true,
      }),
    ).toEqual({
      baseUrlStatus: "Enter an http(s) URL.",
      projectKeysStatus: undefined,
    });
  });

  it("lets invalid project keys take priority on their own row over the nudge", () => {
    expect(
      jiraSettingsRowStatuses({
        ...base,
        baseUrl: "https://example.atlassian.net",
        projectKeys: "nope!",
        invalidProjectKeys: ["nope!"],
      }),
    ).toEqual({
      baseUrlStatus: undefined,
      projectKeysStatus: "Not a project key: nope!. Use keys like OPS, DRST.",
    });
  });

  it("shows nothing for either row while the values are mixed across environments", () => {
    expect(jiraSettingsRowStatuses({ ...base, projectKeys: "OPS", mixed: true })).toEqual({
      baseUrlStatus: undefined,
      projectKeysStatus: undefined,
    });
    expect(
      jiraSettingsRowStatuses({
        ...base,
        baseUrl: "https://example.atlassian.net",
        mixed: true,
      }),
    ).toEqual({ baseUrlStatus: undefined, projectKeysStatus: undefined });
  });

  it("nudges for project keys when the field holds no usable key, not just when it's empty", () => {
    // "," has content but resolves to zero keys, so links are still off.
    expect(
      jiraSettingsRowStatuses({
        ...base,
        baseUrl: "https://example.atlassian.net",
        projectKeys: ",",
      }),
    ).toEqual({
      baseUrlStatus: undefined,
      projectKeysStatus: "Add project keys to turn on links.",
    });
  });

  it("does not nudge for the site URL when the keys field has no usable key", () => {
    // Entering the URL would not turn on links, since "123" resolves to zero
    // valid keys - the entered value is fully invalid, not just missing.
    expect(
      jiraSettingsRowStatuses({
        ...base,
        projectKeys: "123",
        invalidProjectKeys: ["123"],
      }),
    ).toEqual({
      baseUrlStatus: undefined,
      projectKeysStatus: "Not a project key: 123. Use keys like OPS, DRST.",
    });
  });
});
