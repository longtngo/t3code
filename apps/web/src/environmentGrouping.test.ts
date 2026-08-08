import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveLogicalProjectKey,
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  getProjectOrderKey,
  resolveProjectGroupingMode,
} from "./logicalProject";
import {
  buildPhysicalToLogicalProjectKeyMap,
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
  resolveSidebarProjectGroupByRef,
} from "./sidebarProjectGrouping";
import { orderItemsByPreferredIds } from "./components/Sidebar.logic";
import { legacyProjectCwdPreferenceKey } from "./uiStateStore";
import type { Project } from "./types";

const primaryEnvironmentId = EnvironmentId.make("env-primary");
const remoteEnvironmentId = EnvironmentId.make("env-remote");
const repositoryIdentity = {
  canonicalKey: "github.com/example/shared-repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/shared-repo.git",
  },
};
const defaultGroupingSettings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make("project-1"),
    environmentId: primaryEnvironmentId,
    title: "shared-repo",
    workspaceRoot: "/tmp/shared-repo",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    members: [],
    ...overrides,
  };
}

describe("environment grouping", () => {
  it("groups matching repository identities across environments", () => {
    const primary = makeProject({ repositoryIdentity });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });

    expect(deriveLogicalProjectKey(primary)).toBe(repositoryIdentity.canonicalKey);
    expect(deriveLogicalProjectKey(remote)).toBe(repositoryIdentity.canonicalKey);
  });

  it("counts cross-environment copies as one new-thread project choice", () => {
    const primary = makeProject({ repositoryIdentity });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });

    const projectGroupCount = buildSidebarProjectSnapshots({
      projects: [primary, remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    }).length;

    expect(projectGroupCount).toBe(1);
  });

  it("keeps projects without repository identity physically scoped", () => {
    const primary = makeProject();
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
    });

    expect(deriveLogicalProjectKey(primary)).toBe(derivePhysicalProjectKey(primary));
    expect(deriveLogicalProjectKey(remote)).toBe(derivePhysicalProjectKey(remote));
    expect(deriveLogicalProjectKey(primary)).not.toBe(deriveLogicalProjectKey(remote));
  });

  it("uses the physical key when repository grouping is disabled", () => {
    const project = makeProject({ repositoryIdentity });

    expect(
      deriveLogicalProjectKeyFromSettings(project, {
        sidebarProjectGroupingMode: "separate",
        sidebarProjectGroupingOverrides: {},
      }),
    ).toBe(derivePhysicalProjectKey(project));
  });

  it("allows a per-project override to separate an otherwise grouped repository", () => {
    const project = makeProject({ repositoryIdentity });
    const physicalKey = derivePhysicalProjectKey(project);

    expect(
      deriveLogicalProjectKeyFromSettings(project, {
        ...defaultGroupingSettings,
        sidebarProjectGroupingOverrides: {
          [physicalKey]: "separate",
        },
      }),
    ).toBe(physicalKey);
  });

  it("allows a per-project override to group a repository while the global mode is separate", () => {
    const project = makeProject({ repositoryIdentity });

    expect(
      deriveLogicalProjectKeyFromSettings(project, {
        sidebarProjectGroupingMode: "separate",
        sidebarProjectGroupingOverrides: {
          [derivePhysicalProjectKey(project)]: "repository",
        },
      }),
    ).toBe(repositoryIdentity.canonicalKey);
  });

  it("reports the effective grouping mode after applying an override", () => {
    const project = makeProject({ repositoryIdentity });
    const physicalKey = derivePhysicalProjectKey(project);

    expect(resolveProjectGroupingMode(project, defaultGroupingSettings)).toBe("repository");
    expect(
      resolveProjectGroupingMode(project, {
        ...defaultGroupingSettings,
        sidebarProjectGroupingOverrides: {
          [physicalKey]: "separate",
        },
      }),
    ).toBe("separate");
  });

  it("dedupes stale project rows with the same environment and workspace path", () => {
    const duplicate = makeProject({
      id: ProjectId.make("project-duplicate"),
      workspaceRoot: "/tmp/shared-repo/",
      repositoryIdentity,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const primary = makeProject({
      id: ProjectId.make("project-primary"),
      repositoryIdentity,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      workspaceRoot: "/tmp/shared-repo",
      repositoryIdentity,
    });

    const snapshots = buildSidebarProjectSnapshots({
      projects: [primary, duplicate, remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) =>
        environmentId === remoteEnvironmentId ? "remote" : "primary",
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.groupedProjectCount).toBe(2);
    expect(snapshots[0]?.memberProjects.map((project) => project.id)).toEqual([
      primary.id,
      remote.id,
    ]);
  });

  it("prefers the fresher project row when duplicate stale rows are ordered first", () => {
    const staleDuplicate = makeProject({
      id: ProjectId.make("project-stale"),
      workspaceRoot: "/tmp/shared-repo/",
      repositoryIdentity,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const canonical = makeProject({
      id: ProjectId.make("project-canonical"),
      workspaceRoot: "/tmp/shared-repo",
      repositoryIdentity,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    const snapshots = buildSidebarProjectSnapshots({
      projects: [staleDuplicate, canonical],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => "primary",
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.memberProjects.map((project) => project.id)).toEqual([canonical.id]);
    expect(snapshots[0]?.id).toBe(canonical.id);
  });

  it("dedupes stale project rows before logical grouping", () => {
    const staleWithoutRepositoryIdentity = makeProject({
      id: ProjectId.make("project-stale"),
      repositoryIdentity: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const canonical = makeProject({
      id: ProjectId.make("project-canonical"),
      repositoryIdentity,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });

    const snapshots = buildSidebarProjectSnapshots({
      projects: [staleWithoutRepositoryIdentity, canonical, remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) =>
        environmentId === remoteEnvironmentId ? "remote" : "primary",
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.projectKey).toBe(repositoryIdentity.canonicalKey);
    expect(snapshots[0]?.memberProjects.map((project) => project.id)).toEqual([
      canonical.id,
      remote.id,
    ]);
    expect(snapshots[0]?.memberProjectRefs).toEqual([
      {
        environmentId: primaryEnvironmentId,
        projectId: staleWithoutRepositoryIdentity.id,
      },
      { environmentId: primaryEnvironmentId, projectId: canonical.id },
      { environmentId: remoteEnvironmentId, projectId: remote.id },
    ]);

    const [pickerEntry] = buildSidebarProjectPickerEntries({
      groups: snapshots,
      preferredProjectRef: {
        environmentId: primaryEnvironmentId,
        projectId: staleWithoutRepositoryIdentity.id,
      },
    });
    expect(pickerEntry?.isPreferred).toBe(true);
    expect(pickerEntry?.targetProject.id).toBe(canonical.id);
  });

  it("routes duplicate physical project keys to the winning logical group", () => {
    const staleWithoutRepositoryIdentity = makeProject({
      id: ProjectId.make("project-stale"),
      repositoryIdentity: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const canonical = makeProject({
      id: ProjectId.make("project-canonical"),
      repositoryIdentity,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    const physicalToLogicalKey = buildPhysicalToLogicalProjectKeyMap({
      projects: [staleWithoutRepositoryIdentity, canonical],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
    });

    expect(physicalToLogicalKey.get(derivePhysicalProjectKey(staleWithoutRepositoryIdentity))).toBe(
      repositoryIdentity.canonicalKey,
    );
    // Deriving from the stale project alone misses the identity its sibling
    // carries, so consumers must go through the map to match the sidebar.
    expect(
      deriveLogicalProjectKeyFromSettings(staleWithoutRepositoryIdentity, defaultGroupingSettings),
    ).not.toBe(repositoryIdentity.canonicalKey);
  });

  it("builds one picker entry per logical project and targets the preferred environment", () => {
    const primary = makeProject({ repositoryIdentity });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });
    const separate = makeProject({
      id: ProjectId.make("project-separate"),
      title: "separate",
      workspaceRoot: "/tmp/separate",
    });
    const groups = buildSidebarProjectSnapshots({
      projects: [separate, primary, remote],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });

    const entries = buildSidebarProjectPickerEntries({
      groups,
      preferredProjectRef: {
        environmentId: remoteEnvironmentId,
        projectId: remote.id,
      },
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]?.group.projectKey).toBe(repositoryIdentity.canonicalKey);
    expect(entries[0]?.targetProject).toMatchObject({
      environmentId: remoteEnvironmentId,
      id: remote.id,
    });
    expect(entries[0]?.isPreferred).toBe(true);
    expect(entries[1]?.group.displayName).toBe("separate");
  });

  it("keeps manual project order when building grouped sidebar entries", () => {
    const primary = makeProject({ repositoryIdentity });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });
    const separate = makeProject({
      id: ProjectId.make("project-separate"),
      title: "separate",
      workspaceRoot: "/tmp/separate",
    });
    const orderedProjects = orderItemsByPreferredIds({
      items: [primary, remote, separate],
      preferredIds: [getProjectOrderKey(separate), getProjectOrderKey(primary)],
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });

    const groups = buildSidebarProjectSnapshots({
      projects: orderedProjects,
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });

    expect(groups.map((group) => group.displayName)).toEqual(["separate", "shared-repo"]);
  });
});

describe("resolveSidebarProjectGroupByRef", () => {
  const buildGroups = (projects: ReadonlyArray<Project>) =>
    buildSidebarProjectSnapshots({
      projects,
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });

  it("returns null for no target", () => {
    expect(resolveSidebarProjectGroupByRef(buildGroups([makeProject()]), null)).toBeNull();
  });

  it("returns null when the target project is gone", () => {
    const groups = buildGroups([makeProject()]);

    expect(
      resolveSidebarProjectGroupByRef(groups, {
        environmentId: primaryEnvironmentId,
        projectId: ProjectId.make("project-deleted"),
      }),
    ).toBeNull();
  });

  it("finds the group by a non-representative member project", () => {
    const primary = makeProject({ repositoryIdentity });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });
    const groups = buildGroups([primary, remote]);

    const resolved = resolveSidebarProjectGroupByRef(groups, {
      environmentId: remoteEnvironmentId,
      projectId: remote.id,
    });

    expect(resolved?.memberProjects.map((member) => member.id)).toEqual([primary.id, remote.id]);
  });

  // The regression this exists for: the project settings dialog used to hold
  // the snapshot it was opened with. Attaching a workspace member dispatched
  // the update, but the dialog kept rendering the pre-attach member list, so
  // the SECOND attach was computed from the empty list and dropped the first.
  // Re-deriving from live state on each render is what makes both survive.
  it("re-derives members after the project is updated", () => {
    const memberA = {
      id: "member-a",
      path: "/srv/prm_portal_api",
      title: "prm_portal_api",
      integrationBranch: "pickup-v2",
    };
    const memberB = {
      id: "member-b",
      path: "/srv/warehouse",
      title: "warehouse",
      integrationBranch: "pickup-v2",
    };
    const target = {
      environmentId: primaryEnvironmentId,
      projectId: ProjectId.make("project-1"),
    };

    const beforeAttach = resolveSidebarProjectGroupByRef(buildGroups([makeProject()]), target);
    expect(beforeAttach?.members).toEqual([]);

    const afterFirstAttach = resolveSidebarProjectGroupByRef(
      buildGroups([makeProject({ members: [memberA] })]),
      target,
    );
    expect(afterFirstAttach?.members).toEqual([memberA]);

    // What the dialog now feeds the editor, so the second attach appends
    // rather than replacing.
    const afterSecondAttach = resolveSidebarProjectGroupByRef(
      buildGroups([makeProject({ members: [...(afterFirstAttach?.members ?? []), memberB] })]),
      target,
    );
    expect(afterSecondAttach?.members).toEqual([memberA, memberB]);
  });
});
