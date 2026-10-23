// @effect-diagnostics nodeBuiltinImport:off - the invariant is about the source
// on disk (does the panel render this catalog entry), no Effect runtime here.
import * as NodeFS from "node:fs";

import { NOTIFICATION_CATEGORIES } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import {
  filterAvailableSettingsSearchItems,
  getSettingsSearchTargetScope,
  getThreadAutoSettlementSearchAvailability,
  isSettingsSearchScopeAvailable,
  searchSettings,
  SETTINGS_SEARCH_ITEMS,
  SETTINGS_SECTION_LABELS,
  type SettingsSearchItem,
} from "./settingsSearch";

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/general",
    searchTerms: ["long lines in code previews"],
  },
  {
    id: "network-access",
    title: "Network access",
    to: "/settings/connections",
    searchTerms: ["remote pairing backend"],
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
    searchTerms: ["claude codex agents"],
  },
  {
    id: "provider-updates",
    title: "Update checks",
    to: "/settings/general",
  },
  {
    id: "automatic-updates",
    title: "Automatic updates",
    to: "/settings/general",
  },
];

describe("searchSettings", () => {
  it("matches titles, sections, and remembered setting details", () => {
    expect(searchSettings("word", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("network", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("connections", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("claude", ITEMS).map((item) => item.id)).toEqual(["providers"]);
    expect(searchSettings("long lines", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
  });

  it("matches normalized title substrings", () => {
    expect(searchSettings("  WORD   WRAP  ", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("glass").map((item) => item.id)).toEqual(["setting-glass-opacity"]);
    expect(searchSettings("panel animations").map((item) => item.id)).toEqual(["panel-animations"]);
    expect(searchSettings("thè\u{1ab0}mes")[0]?.id).toBe("theme");
    const localeLowerCase = vi.spyOn(String.prototype, "toLocaleLowerCase").mockReturnValue("gıt");
    try {
      expect(searchSettings("GIT")[0]?.id).toBe("git-fetch-interval");
      expect(localeLowerCase).not.toHaveBeenCalled();
    } finally {
      localeLowerCase.mockRestore();
    }
    expect(searchSettings("xyzzy")).toEqual([]);
  });

  it("matches query words across fields and ranks the strongest result first", () => {
    expect(searchSettings("pairing remote", ITEMS).map((item) => item.id)).toEqual([
      "network-access",
    ]);
    expect(
      searchSettings("remote pairing")
        .slice(0, 2)
        .map((item) => item.id),
    ).toEqual(["network-access", "connections-environment"]);
  });

  it("hides desktop-only settings from browser search", () => {
    expect(SETTINGS_SEARCH_ITEMS.some((item) => item.id === "quit-confirmation")).toBe(true);
    expect(searchSettings("hold to quit")).toEqual([]);
    expect(searchSettings("wsl")).toEqual([]);
    expect(searchSettings("update track")).toEqual([]);
  });

  it("hides settings whose controls are unavailable", () => {
    const available = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: false,
      hasEnvironment: false,
      hasProviderSettingsEnvironment: false,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
      hasSubagentBackendThreadModes: false,
      hasAllowSpendingCredits: false,
      hasJiraTicketLinks: false,
    });

    const gatedIds = new Set<string>([
      "follow-change-request-templates",
      "git-fetch-interval",
      "network-access",
      "publish-agent-activity",
      "provider-health-check-interval",
      "cursor-keychain-usage",
      "source-control-writer-model",
      "review-guide-model",
      "review-guide-instructions",
      "source-control-writing-style",
      "t3-connect",
      "hold-webhooks-while-offline",
      "tailscale-https",
      "wsl-backend",
      "auto-settle-inactive-threads",
      "auto-settle-merged-threads",
      "days-before-auto-settle",
    ]);
    expect(available.map((item) => item.id).filter((id) => gatedIds.has(id))).toEqual([]);
  });

  it("hides the subagent offload switch on servers without the capability", () => {
    const without = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: true,
      hasSubagentBackendThreadModes: false,
      hasAllowSpendingCredits: false,
      hasJiraTicketLinks: false,
    });
    const with_ = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: true,
      hasSubagentBackendThreadModes: true,
      hasAllowSpendingCredits: true,
      hasJiraTicketLinks: false,
    });
    expect(without.some((item) => item.id === "subagent-offload")).toBe(false);
    expect(with_.some((item) => item.id === "subagent-offload")).toBe(true);
    // The same silent-snap-back gate: an older server strips the unknown
    // `allowSpendingCredits` key from the patch, so an ungated row would accept the flip
    // and revert with no error — and here the direction it reverts to is "keep spending".
    expect(without.some((item) => item.id === "allow-spending-credits")).toBe(false);
    expect(with_.some((item) => item.id === "allow-spending-credits")).toBe(true);
  });

  it("shows Jira ticket links only when an environment supports them", () => {
    const base = {
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: true,
      hasSubagentBackendThreadModes: false,
      hasAllowSpendingCredits: false,
    };
    expect(
      filterAvailableSettingsSearchItems({ ...base, hasJiraTicketLinks: false }).some(
        (item) => item.id === "jira-ticket-links",
      ),
    ).toBe(false);
    expect(
      filterAvailableSettingsSearchItems({ ...base, hasJiraTicketLinks: true }).some(
        (item) => item.id === "jira-ticket-links",
      ),
    ).toBe(true);
  });

  it("finds keybinding commands by label, command id, and default key", () => {
    expect(searchSettings("toggle sidebar")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("sidebar.toggle")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("mod+b")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("copy link")[0]).toMatchObject({
      id: "keybinding-thread.copyReference",
      to: "/settings/keybindings",
    });
  });

  it("sends commands without a default binding to the section", () => {
    expect(searchSettings("thread.stop")[0]).toMatchObject({
      id: "keybinding-thread.stop",
      targetId: "keybindings",
    });
    expect(searchSettings("sidebar.toggle")[0]?.targetId).toBeUndefined();
  });

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("settings search targets", () => {
  it("requires an environment for the resolved telemetry export destination", () => {
    const result = searchSettings("OpenTelemetry export").find(
      (item) => item.id === "telemetry-export",
    )!;
    const target = getSettingsSearchTargetScope(result.targetId ?? result.id)!;
    expect(isSettingsSearchScopeAvailable(target.scope, "all")).toBe(false);
    expect(isSettingsSearchScopeAvailable(target.scope, "project")).toBe(false);
    expect(isSettingsSearchScopeAvailable(target.scope, "environment")).toBe(true);
  });
  // FORK: the queue slots row is not scoped to a server selection.
  it("treats the queue slots row as reachable from every selection", () => {
    const setting = getSettingsSearchTargetScope("queue-slots")!;
    expect(setting).toMatchObject({ scope: null });
    expect(isSettingsSearchScopeAvailable(setting.scope, "project")).toBe(true);
  });

  it("keeps environment-wide settings out of project scopes", () => {
    const updates = getSettingsSearchTargetScope("provider-update-checks")!;
    expect(updates.scope).toBe("environment-defaults");
    expect(isSettingsSearchScopeAvailable(updates.scope, "environment")).toBe(true);
    expect(isSettingsSearchScopeAvailable(updates.scope, "all")).toBe(true);
    expect(isSettingsSearchScopeAvailable(updates.scope, "project")).toBe(false);
    const streaming = getSettingsSearchTargetScope("response-streaming")!;
    expect(streaming.scope).toBe("project-defaults");
    expect(isSettingsSearchScopeAvailable(streaming.scope, "project")).toBe(true);
    for (const id of ["legacy-plan-mode", "legacy-context-window-indicator", "legacy-sidebar"]) {
      expect(getSettingsSearchTargetScope(id)!.scope).toBeNull();
    }
  });
});

describe("auto-settlement search availability", () => {
  function environment(id: string, { connected = true, loaded = true, supported = true } = {}) {
    return {
      environmentId: EnvironmentId.make(id),
      connection: { phase: connected ? ("connected" as const) : ("offline" as const) },
      serverConfig: loaded
        ? { environment: { capabilities: { threadAutoSettlement: supported } } }
        : null,
    };
  }

  const capable = environment("capable");
  const unsupported = environment("unsupported", { supported: false });
  const offline = environment("offline", { connected: false });
  const loading = environment("loading", { loaded: false });
  const environments = [capable, unsupported, offline, loading];

  it("keeps results discoverable when one connected environment supports them", () => {
    const availability = getThreadAutoSettlementSearchAvailability(environments);
    expect(availability.eligibleEnvironmentIds).toEqual([capable.environmentId]);
    const items = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: availability.eligibleEnvironmentIds.length > 0,
      hasSubagentBackendThreadModes: false,
      hasAllowSpendingCredits: false,
      hasJiraTicketLinks: false,
    });
    expect(searchSettings("auto-settle", items).map((item) => item.id)).toEqual([
      "auto-settle-inactive-threads",
      "auto-settle-merged-threads",
      "days-before-auto-settle",
    ]);
  });

  it("offers only capable environments when an aggregate has mixed capabilities", () => {
    expect(
      getThreadAutoSettlementSearchAvailability(environments, {
        kind: "all",
        environmentIds: environments.map((entry) => entry.environmentId),
      }),
    ).toEqual({ eligibleEnvironmentIds: [capable.environmentId], isTargetAvailable: false });
  });

  it.each([unsupported, offline, loading])(
    "does not render the target on $environmentId or silently fall back",
    (selected) => {
      expect(
        getThreadAutoSettlementSearchAvailability(environments, {
          kind: "environment",
          environmentIds: [selected.environmentId],
        }),
      ).toEqual({ eligibleEnvironmentIds: [capable.environmentId], isTargetAvailable: false });
    },
  );

  it("ignores offline and unloaded targets when all connected targets support the setting", () => {
    const selected = [capable, offline, loading];
    expect(
      getThreadAutoSettlementSearchAvailability(selected, {
        kind: "all",
        environmentIds: selected.map((entry) => entry.environmentId),
      }).isTargetAvailable,
    ).toBe(true);
  });
});

describe("notification settings search entries", () => {
  it("routes every notification category to the notifications tab", () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      const [hit] = searchSettings(category.label);
      expect(hit).toMatchObject({ id: `notify-${category.key}`, to: "/settings/notifications" });
    }
  });

  it("keeps the relocated delivery rows pointing at their new home", () => {
    // These two rows moved out of General; their anchor ids are unchanged so
    // existing deep links keep working, but the section must follow the move.
    expect(searchSettings("task completion notifications")[0]).toMatchObject({
      id: "task-completion-notifications",
      to: "/settings/notifications",
    });
    expect(searchSettings("background notifications")[0]).toMatchObject({
      id: "background-notifications",
      to: "/settings/notifications",
    });
  });
});

describe("General panel catalog coverage", () => {
  // The General panel mounts some anchors itself (`searchableSetting`) and some
  // through a child that computes its own `SettingsSection id` - upstream's
  // `project-defaults` is the second kind, and grepping only the panel reports
  // it missing while the anchor is really there.
  const panelSource = NodeFS.readFileSync(new URL("./SettingsPanels.tsx", import.meta.url), "utf8");
  const generalPanelSources = [
    panelSource,
    // One level deep: the sibling components the panel mounts. Deeper nesting
    // would need a real render, which this coverage check deliberately is not.
    ...[...panelSource.matchAll(/from "\.\/([A-Za-z0-9_]+)"/g)]
      .map((match) => new URL(`./${match[1]}.tsx`, import.meta.url))
      .filter((url) => NodeFS.existsSync(url))
      .map((url) => NodeFS.readFileSync(url, "utf8")),
  ].join("\n");

  const anchorIsMounted = (id: string) =>
    generalPanelSources.includes(`searchableSetting("${id}")`) ||
    generalPanelSources.includes(`"${id}"`);

  it("mounts every General catalog entry in the General panel", () => {
    for (const item of SETTINGS_SEARCH_ITEMS.filter((item) => item.to === "/settings/general")) {
      expect(anchorIsMounted(item.id), item.id).toBe(true);
    }
  });

  it("reports an unmounted anchor as missing", () => {
    // Guards the guard: a substring search over two whole files matches a lot,
    // so prove it can still say no.
    expect(anchorIsMounted("not-a-real-settings-anchor")).toBe(false);
  });
});

describe("queue settings search", () => {
  it("routes the queue items to the Queue tab", () => {
    expect(SETTINGS_SECTION_LABELS["/settings/queue"]).toBe("Queue");
    for (const id of ["queue-slots", "queue-per-provider"]) {
      expect(SETTINGS_SEARCH_ITEMS.find((item) => item.id === id)).toMatchObject({
        to: "/settings/queue",
      });
    }
  });

  it("titles the queue items like the rows they land on", () => {
    const title = (id: string) => SETTINGS_SEARCH_ITEMS.find((item) => item.id === id)?.title;
    expect(title("queue-slots")).toBe("Active slots");
    expect(title("queue-per-provider")).toBe("Per provider");
  });
});
