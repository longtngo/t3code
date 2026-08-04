# Multi-Repo Workspace, Phase 1 (Model + Agent Reach) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project declare additional repositories ("workspace members") that its threads' agent can read and edit without a per-directory permission prompt.

**Architecture:** `OrchestrationProject` gains a `members` array carried through the existing event-sourced command → decider → event → projector flow. Member paths are threaded into the provider session start input, where the Claude adapter passes them as `additionalDirectories`, and into the trusted-read sandbox. No new aggregates, no new RPC namespaces, and nothing existing changes shape — a project with `members: []` behaves exactly as today.

**Tech Stack:** TypeScript, Effect v4 (beta.103), `effect/Schema` for contracts, `@effect/vitest` for tests, pnpm workspaces, React for the web client.

**Design doc:** `docs/design/2026-08-04-multi-repo-workspace-design.md`

**Branch:** `feat/multi-repo-workspace` (already exists, already has the design commits)

## Global Constraints

- **Import style:** namespace imports only — `import * as Schema from "effect/Schema"`, never named imports from `effect/*`.
- **Contract primitives:** reuse `TrimmedNonEmptyString` from `packages/contracts/src/baseSchemas.ts`. Do not introduce new string primitives.
- **Version skew is mandatory, both directions.** Every new field on an existing schema is either `Schema.optional(...)` or carries `Schema.withDecodingDefault(Effect.succeed(<default>))`. An older server must decode on a newer client and vice versa. This is the pattern already used for `archivedAt` and `settledOverride`.
- **Event payloads are replayed from history.** A payload field added now will be absent on every event already in the store, so payload fields are always `Schema.optional` and the projector supplies the default.
- **Effect language service diagnostics fail typecheck.** Do not use `node:child_process`, bare `setTimeout`, `console.log`, or `Effect.fail(new Error(...))` in server code. Use `Effect.sleep`, `Console.log`, and typed `Schema.TaggedErrorClass` errors.
- **Tests:** `import { assert, describe, it } from "@effect/vitest"`. Effect-returning tests use `it.effect(name, () => Effect.gen(function* () { ... }))`.
- **Test commands:** per package, `pnpm --filter <pkg> test run <path>`. Package names: `@t3tools/contracts`, `t3` (the server), `@t3tools/web`, `@t3tools/client-runtime`.
- **Full gate:** `pnpm verify` (typecheck + lint + test) must be green before the phase is merged. Baseline on this branch is 2139 passed / 7 skipped.
- **No `members` on `ProjectCreateCommand`.** Members are attached after a project exists, via `project.meta.update`. Keeping create unchanged keeps the create path and its invariants untouched.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `packages/contracts/src/orchestration.ts` | `WorkspaceMember` schema; `members` on the project read model, shell, update command, and both project payloads | Modify |
| `packages/contracts/src/orchestration.test.ts` | Skew and round-trip coverage for the above | Modify |
| `apps/server/src/orchestration/decider.ts` | Pass `members` from command into the `project.meta-updated` event | Modify |
| `apps/server/src/orchestration/projector.ts` | Apply `members` to the read model on create and update | Modify |
| `packages/contracts/src/provider.ts` | `workspaceMemberPaths` on `ProviderSessionStartInput` | Modify |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` | Fill `workspaceMemberPaths` from the resolved project | Modify |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts` | Include member paths in `additionalDirectories` | Modify |
| `apps/web/src/components/WorkspaceMembersControl.logic.ts` | Pure add/remove/validate logic for the members editor | **Create** |
| `apps/web/src/components/WorkspaceMembersControl.logic.test.ts` | Unit coverage for the logic module | **Create** |
| `apps/web/src/components/WorkspaceMembersControl.tsx` | The members editor UI | **Create** |

The `.logic.ts` + `.logic.test.ts` split for the client component follows the established
pattern in this codebase (`GitActionsControl.logic.ts`, `SettingsPanels.logic.ts`,
`ConnectionsSettings.logic.ts`): all decision-making lives in a pure, directly-testable
module, and the `.tsx` file is wiring only.

---

## Task 1: Contract — `WorkspaceMember` and `members`

**Files:**
- Modify: `packages/contracts/src/orchestration.ts` (add schema near `ProjectScript` at `:211`; touch `OrchestrationProject` `:213`, `OrchestrationProjectShell` `:407`, `ProjectMetaUpdateCommand` `:603`, `ProjectCreatedPayload` `:1024`, `ProjectMetaUpdatedPayload` `:1035`)
- Test: `packages/contracts/src/orchestration.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `WorkspaceMember` (type and schema) with fields `id: string`, `path: string`, `title: string`, `integrationBranch: string`. `OrchestrationProject.members: ReadonlyArray<WorkspaceMember>` and the same on `OrchestrationProjectShell`. `ProjectMetaUpdateCommand.members?: ReadonlyArray<WorkspaceMember>`. `ProjectCreatedPayload.members?` and `ProjectMetaUpdatedPayload.members?`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/contracts/src/orchestration.test.ts`. Add `WorkspaceMember` to the existing
import block from `./orchestration.ts`, and add this decoder alongside the others near `:38`:

```ts
const decodeOrchestrationProject = Schema.decodeUnknownEffect(OrchestrationProject);
const decodeProjectMetaUpdateCommand = Schema.decodeUnknownEffect(ProjectMetaUpdateCommand);
```

(`OrchestrationProject` and `ProjectMetaUpdateCommand` must be added to the import list too.)

Then append these tests:

```ts
it.effect("defaults project members to an empty array for older payloads", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProject({
      id: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    });
    assert.deepStrictEqual(parsed.members, []);
  }),
);

it.effect("preserves project members when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProject({
      id: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      defaultModelSelection: null,
      scripts: [],
      members: [
        {
          id: "member-1",
          path: "/tmp/prm_portal_api",
          title: "prm_portal_api",
          integrationBranch: "pickup-v2",
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    });
    assert.strictEqual(parsed.members.length, 1);
    assert.strictEqual(parsed.members[0]?.integrationBranch, "pickup-v2");
  }),
);

it.effect("accepts members on project.meta.update", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectMetaUpdateCommand({
      type: "project.meta.update",
      commandId: "command-1",
      projectId: "project-1",
      members: [
        {
          id: "member-1",
          path: "/tmp/warehouse",
          title: "warehouse",
          integrationBranch: "pickup-v2",
        },
      ],
    });
    assert.strictEqual(parsed.members?.[0]?.title, "warehouse");
  }),
);

it.effect("decodes project.created payloads without members", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: "project-1",
      title: "Legacy project",
      workspaceRoot: "/tmp/legacy",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.members, undefined);
  }),
);
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @t3tools/contracts test run src/orchestration.test.ts
```

Expected: FAIL. The first three fail on the missing `members` field; the fourth fails at
compile time because `members` is not a property of the payload type.

- [ ] **Step 3: Add the schema and the fields**

In `packages/contracts/src/orchestration.ts`, immediately after the `ProjectScript` export
(around `:211`):

```ts
/**
 * An additional repository a project's threads operate on, beyond `workspaceRoot`.
 *
 * `integrationBranch` is per member and concrete rather than nullable: once a feature
 * branch is cut, the "current branch" IS the feature branch, so an auto-detected value
 * would be ambiguous exactly when it matters. It is resolved once at attach time and
 * stored. A member whose stored branch no longer matches the checkout is treated as
 * unmanaged — see docs/design/2026-08-04-multi-repo-workspace-design.md.
 */
export const WorkspaceMember = Schema.Struct({
  id: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  integrationBranch: TrimmedNonEmptyString,
});
export type WorkspaceMember = typeof WorkspaceMember.Type;
```

Add to **both** `OrchestrationProject` (`:213`) and `OrchestrationProjectShell` (`:407`),
after their `scripts` field:

```ts
  members: Schema.Array(WorkspaceMember).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
```

Add to `ProjectMetaUpdateCommand` (`:603`), after `scripts`:

```ts
  members: Schema.optional(Schema.Array(WorkspaceMember)),
```

Add to **both** `ProjectCreatedPayload` (`:1024`) and `ProjectMetaUpdatedPayload` (`:1035`),
after their `scripts` field:

```ts
  members: Schema.optional(Schema.Array(WorkspaceMember)),
```

Payload fields are `optional` rather than defaulted because they are replayed from events
already in the store, where the field is genuinely absent. The projector supplies the
default (Task 2).

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @t3tools/contracts test run src/orchestration.test.ts
```

Expected: PASS, all four new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/orchestration.ts packages/contracts/src/orchestration.test.ts
git commit -m "feat(contracts): add workspace members to the project model

Members are additional repositories a project's threads operate on beyond
workspaceRoot. integrationBranch is per member because branch names are not
uniform across an effort's repos.

Read-model fields carry a decoding default so older servers decode; payload
fields are optional because they are replayed from events that predate them."
```

---

## Task 2: Decider and projector carry `members` through the event flow

**Files:**
- Modify: `apps/server/src/orchestration/decider.ts:284-295` (the `project.meta.update` case)
- Modify: `apps/server/src/orchestration/projector.ts:207-250` (the `project.created` and `project.meta-updated` cases)
- Test: `apps/server/src/orchestration/projector.test.ts`

**Interfaces:**
- Consumes: `WorkspaceMember`, `OrchestrationProject.members`, `ProjectMetaUpdateCommand.members`, `ProjectMetaUpdatedPayload.members`, `ProjectCreatedPayload.members` from Task 1
- Produces: a read model whose `project.members` reflects the last `project.meta.update`. Nothing else depends on this beyond the read model shape already declared in Task 1.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("orchestration projector", ...)` block in
`apps/server/src/orchestration/projector.test.ts`. This file uses `describe`/`it`/`expect`
from `vite-plus/test` (not `@effect/vitest`), plain `async` tests with `Effect.runPromise`,
and the local `makeEvent` helper plus `createEmptyReadModel` / `projectEvent` imported from
`./projector.ts`. All of these already exist at the top of the file — do not add imports
beyond what is listed here.

```ts
  const PROJECT_CREATED_AT = "2026-01-01T00:00:00.000Z";

  const projectCreatedEvent = (sequence: number) =>
    makeEvent({
      sequence,
      type: "project.created",
      aggregateKind: "project",
      aggregateId: "project-1",
      occurredAt: PROJECT_CREATED_AT,
      commandId: "cmd-project-create",
      payload: {
        projectId: "project-1",
        title: "Project",
        workspaceRoot: "/tmp/workspace",
        defaultModelSelection: null,
        scripts: [],
        createdAt: PROJECT_CREATED_AT,
        updatedAt: PROJECT_CREATED_AT,
      },
    });

  const memberFixture = {
    id: "member-1",
    path: "/tmp/prm_portal_api",
    title: "prm_portal_api",
    integrationBranch: "pickup-v2",
  };

  it("defaults members to an empty array on project.created", async () => {
    const model = createEmptyReadModel(PROJECT_CREATED_AT);
    const next = await Effect.runPromise(projectEvent(model, projectCreatedEvent(1)));

    expect(next.projects[0]?.members).toEqual([]);
  });

  it("applies members from project.meta-updated", async () => {
    const model = createEmptyReadModel(PROJECT_CREATED_AT);
    const created = await Effect.runPromise(projectEvent(model, projectCreatedEvent(1)));
    const next = await Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "project.meta-updated",
          aggregateKind: "project",
          aggregateId: "project-1",
          occurredAt: "2026-01-02T00:00:00.000Z",
          commandId: "cmd-project-update",
          payload: {
            projectId: "project-1",
            members: [memberFixture],
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        }),
      ),
    );

    expect(next.projects[0]?.members).toEqual([memberFixture]);
  });

  it("leaves members untouched when project.meta-updated omits them", async () => {
    const model = createEmptyReadModel(PROJECT_CREATED_AT);
    const created = await Effect.runPromise(projectEvent(model, projectCreatedEvent(1)));
    const withMembers = await Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "project.meta-updated",
          aggregateKind: "project",
          aggregateId: "project-1",
          occurredAt: "2026-01-02T00:00:00.000Z",
          commandId: "cmd-project-update",
          payload: {
            projectId: "project-1",
            members: [memberFixture],
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        }),
      ),
    );
    const renamed = await Effect.runPromise(
      projectEvent(
        withMembers,
        makeEvent({
          sequence: 3,
          type: "project.meta-updated",
          aggregateKind: "project",
          aggregateId: "project-1",
          occurredAt: "2026-01-03T00:00:00.000Z",
          commandId: "cmd-project-rename",
          payload: {
            projectId: "project-1",
            title: "Renamed",
            updatedAt: "2026-01-03T00:00:00.000Z",
          },
        }),
      ),
    );

    expect(renamed.projects[0]?.title).toBe("Renamed");
    expect(renamed.projects[0]?.members).toEqual([memberFixture]);
  });
```

The third test is the one that matters most: it pins the conditional-spread behavior, so a
partial update (rename only) cannot silently wipe the member list.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter t3 test run src/orchestration/projector.test.ts
```

Expected: FAIL — `members` is `undefined` on the projected project, so the first assertion
throws.

- [ ] **Step 3: Implement the decider pass-through**

In `apps/server/src/orchestration/decider.ts`, in the `project.meta.update` case, add to the
payload spread after the `scripts` line (`:292`):

```ts
          ...(command.members !== undefined ? { members: command.members } : {}),
```

- [ ] **Step 4: Implement the projector**

In `apps/server/src/orchestration/projector.ts`, in the `project.created` case, add to the
`nextProject` object literal after `scripts` (`:212`):

```ts
            members: payload.members ?? [],
```

In the `project.meta-updated` case, add after the `scripts` spread (`:245`):

```ts
                  ...(payload.members !== undefined ? { members: payload.members } : {}),
```

The conditional spread is what makes the third test pass: an update that omits `members`
must not clear them.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter t3 test run src/orchestration/projector.test.ts
```

Expected: PASS, all three new tests.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/orchestration/decider.ts apps/server/src/orchestration/projector.ts apps/server/src/orchestration/projector.test.ts
git commit -m "feat(orchestration): carry workspace members through the event flow

project.meta.update passes members into project.meta-updated, and the
projector applies them. An update that omits members leaves them intact
rather than clearing them, so partial updates stay partial."
```

---

## Task 3: Agent reach — member paths become `additionalDirectories`

**Files:**
- Modify: `packages/contracts/src/provider.ts:53-74` (`ProviderSessionStartInput`)
- Modify: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:622-643`
- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.ts:3708-3713`
- Test: `packages/contracts/src/provider.test.ts`

**Interfaces:**
- Consumes: `OrchestrationProject.members` (Task 1), applied to the read model by Task 2
- Produces: `ProviderSessionStartInput.workspaceMemberPaths?: ReadonlyArray<string>`, consumed by every provider adapter. Only the Claude adapter acts on it in this phase; other adapters ignore it harmlessly.

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/provider.test.ts` (add `ProviderSessionStartInput` to its
imports and a decoder in the file's existing style):

```ts
const decodeProviderSessionStartInput = Schema.decodeUnknownEffect(ProviderSessionStartInput);

it.effect("carries workspace member paths on session start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProviderSessionStartInput({
      threadId: "thread-1",
      runtimeMode: "full-access",
      cwd: "/tmp/workspace",
      workspaceMemberPaths: ["/tmp/prm_portal_api", "/tmp/warehouse"],
    });
    assert.deepStrictEqual(parsed.workspaceMemberPaths, [
      "/tmp/prm_portal_api",
      "/tmp/warehouse",
    ]);
  }),
);

it.effect("omits workspace member paths for older clients", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProviderSessionStartInput({
      threadId: "thread-1",
      runtimeMode: "full-access",
      cwd: "/tmp/workspace",
    });
    assert.strictEqual(parsed.workspaceMemberPaths, undefined);
  }),
);
```

`"full-access"` is `DEFAULT_RUNTIME_MODE` (`packages/contracts/src/orchestration.ts:124`).
The other valid `RuntimeMode` literals are `"approval-required"`, `"auto-accept-edits"`,
and `"auto"`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @t3tools/contracts test run src/provider.test.ts
```

Expected: FAIL — `workspaceMemberPaths` is not a property of the decoded type.

- [ ] **Step 3: Add the contract field**

In `packages/contracts/src/provider.ts`, inside `ProviderSessionStartInput`, after `cwd`
(`:58`):

```ts
  /**
   * Absolute paths of the project's workspace members. Adapters that support
   * scoped filesystem access grant these alongside `cwd`, so the agent can edit
   * sibling repositories without a per-directory approval prompt.
   */
  workspaceMemberPaths: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
```

- [ ] **Step 4: Fill it from the resolved project**

In `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`, the project is already
resolved at `:622` (`const project = yield* resolveProject(thread.projectId);`). Add this
directly below the `effectiveCwd` assignment (`:626`):

```ts
    const workspaceMemberPaths = (project?.members ?? []).map((member) => member.path);
```

Then in the `startProviderSession` call, after the `cwd` line (`:640`):

```ts
        ...(workspaceMemberPaths.length > 0 ? { workspaceMemberPaths } : {}),
```

- [ ] **Step 5: Grant them in the Claude adapter**

In `apps/server/src/provider/Layers/ClaudeAdapter.ts`, replace the `additionalDirectories`
block at `:3710-3713`:

```ts
        // The attachments dir holds files uploaded via the web/remote fallback for dropped
        // non-image files; allow the agent to Read them without a permission prompt.
        // Workspace member repositories are granted for the same reason — a thread whose
        // work spans several repos would otherwise prompt once per repo.
        additionalDirectories: [
          ...(input.cwd ? [input.cwd] : []),
          ...(input.workspaceMemberPaths ?? []),
          serverConfig.attachmentsDir,
        ],
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm --filter @t3tools/contracts test run src/provider.test.ts
pnpm --filter t3 test run src/orchestration/Layers/ProviderCommandReactor.test.ts
```

Expected: PASS. The reactor's existing tests must stay green — the new field is additive and
absent when a project has no members.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/provider.ts packages/contracts/src/provider.test.ts apps/server/src/orchestration/Layers/ProviderCommandReactor.ts apps/server/src/provider/Layers/ClaudeAdapter.ts
git commit -m "feat(provider): grant workspace members to the agent session

Session start now carries the project's member paths, and the Claude adapter
passes them as additionalDirectories alongside cwd. Without this a thread
spanning several repos prompts for approval once per repo.

This deliberately widens what the agent writes without prompting; it is the
point of the feature and is recorded in the design doc."
```

---

## Task 4: Attach and detach members in the UI

**Files:**
- Create: `apps/web/src/components/WorkspaceMembersControl.logic.ts`
- Create: `apps/web/src/components/WorkspaceMembersControl.logic.test.ts`
- Create: `apps/web/src/components/WorkspaceMembersControl.tsx`

**Interfaces:**
- Consumes: `WorkspaceMember` (Task 1); `updateProject` from `packages/client-runtime/src/operations/commands.ts:98`, whose input type is `CommandInput<"project.meta.update">` and therefore already accepts `members` with no client-runtime change
- Produces: nothing consumed by later Phase 1 tasks

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/WorkspaceMembersControl.logic.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest";

import {
  addMember,
  memberTitleFromPath,
  removeMember,
  validateNewMember,
} from "./WorkspaceMembersControl.logic";

const existing = [
  { id: "m1", path: "/srv/prm_portal_api", title: "prm_portal_api", integrationBranch: "pickup-v2" },
];

describe("memberTitleFromPath", () => {
  it("uses the final path segment", () => {
    assert.strictEqual(memberTitleFromPath("/srv/uni/warehouse"), "warehouse");
  });

  it("ignores a trailing separator", () => {
    assert.strictEqual(memberTitleFromPath("/srv/uni/warehouse/"), "warehouse");
  });
});

describe("validateNewMember", () => {
  it("rejects a relative path", () => {
    assert.strictEqual(
      validateNewMember({ path: "../warehouse", integrationBranch: "main" }, existing),
      "Enter an absolute path.",
    );
  });

  it("rejects a blank branch", () => {
    assert.strictEqual(
      validateNewMember({ path: "/srv/warehouse", integrationBranch: "  " }, existing),
      "Enter the branch this repository integrates into.",
    );
  });

  it("rejects a duplicate path", () => {
    assert.strictEqual(
      validateNewMember(
        { path: "/srv/prm_portal_api", integrationBranch: "pickup-v2" },
        existing,
      ),
      "That repository is already attached.",
    );
  });

  it("accepts a valid member", () => {
    assert.strictEqual(
      validateNewMember({ path: "/srv/warehouse", integrationBranch: "pickup-v2" }, existing),
      null,
    );
  });
});

describe("addMember", () => {
  it("appends a member with a generated id and derived title", () => {
    const next = addMember(existing, {
      id: "m2",
      path: "/srv/warehouse",
      integrationBranch: "pickup-v2",
    });
    assert.strictEqual(next.length, 2);
    assert.strictEqual(next[1]?.title, "warehouse");
    assert.strictEqual(next[1]?.id, "m2");
  });

  it("does not mutate the input array", () => {
    addMember(existing, { id: "m2", path: "/srv/warehouse", integrationBranch: "pickup-v2" });
    assert.strictEqual(existing.length, 1);
  });
});

describe("removeMember", () => {
  it("removes by id", () => {
    assert.deepStrictEqual(removeMember(existing, "m1"), []);
  });

  it("is a no-op for an unknown id", () => {
    assert.deepStrictEqual(removeMember(existing, "nope"), existing);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @t3tools/web test run src/components/WorkspaceMembersControl.logic.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the logic module**

Create `apps/web/src/components/WorkspaceMembersControl.logic.ts`:

```ts
import type { WorkspaceMember } from "@t3tools/contracts";

export interface NewWorkspaceMemberInput {
  readonly path: string;
  readonly integrationBranch: string;
}

/** Final path segment, ignoring a trailing separator. Used as the display title. */
export function memberTitleFromPath(path: string): string {
  const segments = path.replaceAll("\\", "/").split("/").filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? path;
}

/** Null when the input is attachable; otherwise a message to show the user. */
export function validateNewMember(
  input: NewWorkspaceMemberInput,
  existing: ReadonlyArray<WorkspaceMember>,
): string | null {
  const path = input.path.trim();
  const branch = input.integrationBranch.trim();
  if (path.length === 0) return "Enter a repository path.";
  if (!path.startsWith("/")) return "Enter an absolute path.";
  if (branch.length === 0) return "Enter the branch this repository integrates into.";
  if (existing.some((member) => member.path === path)) {
    return "That repository is already attached.";
  }
  return null;
}

export function addMember(
  existing: ReadonlyArray<WorkspaceMember>,
  input: NewWorkspaceMemberInput & { readonly id: string },
): ReadonlyArray<WorkspaceMember> {
  const path = input.path.trim();
  return [
    ...existing,
    {
      id: input.id,
      path,
      title: memberTitleFromPath(path),
      integrationBranch: input.integrationBranch.trim(),
    },
  ];
}

export function removeMember(
  existing: ReadonlyArray<WorkspaceMember>,
  id: string,
): ReadonlyArray<WorkspaceMember> {
  return existing.some((member) => member.id === id)
    ? existing.filter((member) => member.id !== id)
    : existing;
}
```

`validateNewMember` checks `startsWith("/")` rather than using `node:path`, because this
module runs in the browser. Windows support is out of scope for this phase. This validation
is a convenience for the user, not a security boundary — a member path only ever widens what
the agent may touch, and the agent already runs with the user's own filesystem permissions.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @t3tools/web test run src/components/WorkspaceMembersControl.logic.test.ts
```

Expected: PASS, all eleven tests.

- [ ] **Step 5: Build the component**

Create `apps/web/src/components/WorkspaceMembersControl.tsx`. Like
`ProjectScriptsControl.tsx`, this is a **presentational** component: it receives the array
and callbacks, and the parent owns command dispatch. That keeps the dispatch wiring in one
place and the component trivially renderable in isolation.

```tsx
import { useState } from "react";

import type { WorkspaceMember } from "@t3tools/contracts";

import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  addMember,
  removeMember,
  validateNewMember,
} from "./WorkspaceMembersControl.logic";

interface WorkspaceMembersControlProps {
  members: ReadonlyArray<WorkspaceMember>;
  onMembersChange: (next: ReadonlyArray<WorkspaceMember>) => void;
}

export default function WorkspaceMembersControl({
  members,
  onMembersChange,
}: WorkspaceMembersControlProps) {
  const [path, setPath] = useState("");
  const [integrationBranch, setIntegrationBranch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    const message = validateNewMember({ path, integrationBranch }, members);
    setError(message);
    if (message !== null) return;
    onMembersChange(
      addMember(members, { id: crypto.randomUUID(), path, integrationBranch }),
    );
    setPath("");
    setIntegrationBranch("");
  };

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2">
        {members.map((member) => (
          <li key={member.id} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{member.title}</div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {member.path}
              </div>
            </div>
            <span className="shrink-0 font-mono text-xs">{member.integrationBranch}</span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Detach ${member.title}`}
              onClick={() => onMembersChange(removeMember(members, member.id))}
            >
              Detach
            </Button>
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2">
        <Label htmlFor="workspace-member-path">Repository path</Label>
        <Input
          id="workspace-member-path"
          value={path}
          placeholder="/Users/you/src/uni/prm_portal_api"
          onChange={(event) => setPath(event.target.value)}
        />
        <Label htmlFor="workspace-member-branch">Integration branch</Label>
        <Input
          id="workspace-member-branch"
          value={integrationBranch}
          placeholder="pickup-v2"
          onChange={(event) => setIntegrationBranch(event.target.value)}
        />
        {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button onClick={handleAdd}>Attach repository</Button>
      </div>
    </div>
  );
}
```

Mount it next to the scripts control in the project settings surface, and have the parent
dispatch on change. The precedent for the dispatch is `SidebarV2.tsx:1195` (which builds
`updateProject` via `useAtomCommand(projectEnvironment.update, …)`) and `:1518` (which calls
it):

```tsx
<WorkspaceMembersControl
  members={project.members}
  onMembersChange={(members) => {
    void updateProject({ projectId: project.id, members });
  }}
/>
```

**Verify the class names against a neighbouring component before committing.** The names
above (`text-muted-foreground`, `text-destructive`) follow this codebase's Tailwind theme
conventions, but confirm they resolve rather than assuming — a class that does not exist
fails silently as unstyled markup rather than as an error.

- [ ] **Step 6: Run the full gate**

```bash
pnpm verify
```

Expected: typecheck clean, lint clean, tests pass. Baseline is 2139 passed / 7 skipped, so
expect roughly 2160 passed with this phase's additions and **zero** failures.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/WorkspaceMembersControl.logic.ts apps/web/src/components/WorkspaceMembersControl.logic.test.ts apps/web/src/components/WorkspaceMembersControl.tsx
git commit -m "feat(web): attach and detach workspace members in project settings

Validation, title derivation, and add/remove live in a pure logic module so
they are testable without rendering, matching the pattern used by
GitActionsControl and SettingsPanels."
```

---

## Manual verification

After Task 4, before considering the phase done:

1. Attach `~/src/uni/prm_portal_api` with integration branch `pickup-v2` to a project.
2. Reload the client. The member persists — this proves the event round-tripped through the
   projector rather than living in component state.
3. Start a thread and ask the agent to read a file in `prm_portal_api`. It should read
   **without a directory-approval prompt**. That is the phase's actual deliverable.
4. Detach the member, start a fresh thread, and ask again. The prompt should return, which
   confirms the grant is driven by the member list and not by something ambient.

Step 4 matters: without it, a passing step 3 could just as easily mean the sandbox never
restricted that path in the first place.

## What this phase deliberately does not do

Files and Diff panels still operate on `workspaceRoot` alone; no branch is cut in any member
repository; no pull request targets an integration branch; and checkpoints are unchanged.
Those are Phases 2 through 4. Phase 1 is read-and-edit reach only, and nothing in it writes
to a member repository's git state.

**The trusted-read sandbox is deliberately untouched**, though the design doc lists it under
Phase 1. `allowedReadRoots` (`apps/server/src/workspace/readAccess.ts:21`) accepts extra
roots but is currently called with none (`WorkspaceFileSystem.ts:297`), so the sandbox is
`$HOME` plus the OS temp dir — which **already covers every member repository in the
motivating layout**, since they all live under `~/src/uni/`. Widening it would require
inverting a dependency so the filesystem layer can reach server-side project state, and it
would deliver nothing observable today.

Add it when a member repository first lives outside `$HOME`. The failure mode if that
happens before the work lands is clear rather than subtle: the file preview refuses the read
with an out-of-sandbox error, while the agent — which is scoped by `additionalDirectories`,
not by this sandbox — can still edit the repository normally.
