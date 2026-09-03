# Per-Thread Subagent Offload Implementation Plan

> Superseded details: the file-name bound is now expressed as 248 file-name characters
> (`THREAD_BACKEND_MAX_FILE_NAME_LENGTH`), `isThreadBackendFileNameWritable` and
> `subagentThreadControlVisibility` were removed, and master-off admits
> `set({ backend: "default" })`. The design doc (revision 7) and git history are
> authoritative.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each thread choose whether its subagents offload to Cursor (inherit / on / off), and add a master switch in Settings → General that turns the whole feature off and hides its controls.

**Architecture:** The server keeps writing the machine-global flag file the `~/bin/subagent-dispatch` wrapper reads today, and additionally writes one small per-thread flag file under T3 state (`<stateDir>/subagent-threads/<base64url(threadId)>.json`) for every live provider session. The Claude adapter points each thread's subprocess at its own file via the wrapper's existing `SUBAGENT_BACKEND_STATE` env var. Three writers (session start, settings change, global `set`) all resolve the same pure truth table and serialize through the one existing write semaphore. Two new server settings (`subagentBackendEnabled`, `subagentBackendThreadModes`) carry the user's choices; a new capability flag gates every client control.

**Tech Stack:** Effect (effect-smol, `Effect.fn`, `Semaphore`, `FileSystem`), Effect Schema contracts, React 19 + `@effect/atom-react`, vitest via `vp test run`.

**Spec:** `docs/design/2026-09-03-thread-subagent-offload-design.md` (revision 6). Read it first; every decision below argues from it.

## Global Constraints

- Never write to `~/.local/state/subagent-dispatch/backend.json` or `~/.t3/userdata` from a test. Every test builds its own tmpdir and sets `HOME` to it (pattern in `SubagentBackend.reconciler.test.ts`).
- Every flag-file write goes through `backendWriteSemaphore` (one permit, non-reentrant). A function that takes the permit must never call another function that takes it.
- Fail safe toward "default": a missing, unreadable, or over-long thread file must make the wrapper refuse (rc=3), never dispatch to Cursor.
- Thread file name = `Encoding.encodeBase64Url(threadId) + ".json"`. Refuse to write when the encoded name exceeds 243 characters (mkdtemp appends `.XXXXXX` and the darwin NAME_MAX is 255). The env var is still injected so the wrapper refuses on the absent file.
- Thread mode values are exactly `"inherit" | "on" | "off"`. `"inherit"` is stored literally (deepMerge never deletes keys) and resolves the same as an absent entry.
- `subagentBackendEnabled === false` (master off): every thread file is written as `default`, `setBackend` refuses without writing, and clients hide the per-thread control. The global toggle stays visible but dimmed in the sidebar.
- Run server tests from `apps/server` and web tests from `apps/web` with `vp test run <file>`. No repo-wide checks until the final `pnpm verify`.
- One commit per task, conventional-commit titles.

---

### Task 1: Contracts — two settings fields, patch mirrors, capability flag

**Files:**

- Modify: `packages/contracts/src/settings.ts:1181-1190` (ServerSettings tail) and `:1405-1416` (ServerSettingsPatch tail)
- Modify: `packages/contracts/src/environment.ts:103-105`
- Modify: `apps/server/src/environment/ServerEnvironment.ts:226`
- Test: `packages/contracts/src/settings.test.ts`, `apps/server/src/environment/ServerEnvironment.test.ts:165-176`

**Interfaces:**

- Produces: `ServerSettings.subagentBackendEnabled: boolean` (default `true`); `ServerSettings.subagentBackendThreadModes: Readonly<Record<ThreadId, "inherit" | "on" | "off">>` (default `{}`); exported `SubagentBackendThreadMode` schema/type; `EnvironmentCapabilities.subagentBackendThreadModes?: boolean`.

- [ ] **Step 1: Write the failing contract tests**

Append to `packages/contracts/src/settings.test.ts` (top-level, after the parity describe block):

```ts
describe("subagent offload settings", () => {
  it("defaults master on and thread modes empty", () => {
    expect(DEFAULT_SERVER_SETTINGS.subagentBackendEnabled).toBe(true);
    expect(DEFAULT_SERVER_SETTINGS.subagentBackendThreadModes).toEqual({});
  });

  it("decodes a settings file written before the fields existed", () => {
    const decoded = Schema.decodeUnknownSync(ServerSettings)({});
    expect(decoded.subagentBackendEnabled).toBe(true);
    expect(decoded.subagentBackendThreadModes).toEqual({});
  });

  it("rejects an unknown thread mode", () => {
    expect(() =>
      Schema.decodeUnknownSync(ServerSettings)({
        subagentBackendThreadModes: { t1: "cursor" },
      }),
    ).toThrow();
  });

  it("accepts a single-key thread-mode patch", () => {
    const patch = Schema.decodeUnknownSync(ServerSettingsPatch)({
      subagentBackendThreadModes: { t1: "inherit" },
    });
    expect(patch.subagentBackendThreadModes).toEqual({ t1: "inherit" });
  });
});
```

Check the file's existing imports cover `Schema`, `ServerSettings`, `ServerSettingsPatch`, `DEFAULT_SERVER_SETTINGS`; add any missing one from `effect/Schema` / `./settings.ts`.

Append to `apps/server/src/environment/ServerEnvironment.test.ts` right after line 175 (`threadPullRequestLinking`):

```ts
expect(second.capabilities.subagentBackend).toBe(true);
expect(second.capabilities.subagentBackendThreadModes).toBe(true);
```

- [ ] **Step 2: Run both tests to verify they fail**

Run from `packages/contracts`: `vp test run src/settings.test.ts`
Expected: FAIL — `subagentBackendEnabled` undefined; parity test also fails once fields are added without patch mirrors, which is the next step's guard.

Run from `apps/server`: `vp test run src/environment/ServerEnvironment.test.ts`
Expected: FAIL — `subagentBackendThreadModes` is `undefined`.

- [ ] **Step 3: Add the schema fields**

In `packages/contracts/src/settings.ts`, directly above the `ServerSettings` struct (search for `export const ServerSettings = Schema.Struct({`), add:

```ts
export const SubagentBackendThreadMode = Schema.Literals(["inherit", "on", "off"]);
export type SubagentBackendThreadMode = typeof SubagentBackendThreadMode.Type;

/** Per-thread subagent-offload overrides. `"inherit"` is stored literally rather than
 * deleted — `deepMerge` never removes keys, so it is the only way a patch can undo an
 * override — and resolves exactly like an absent entry. */
export const SubagentBackendThreadModes = Schema.Record(ThreadId, SubagentBackendThreadMode);
```

`ThreadId` is exported from `./baseSchemas.ts`; confirm it is already imported at the top of `settings.ts` (grep `ThreadId` in the import block) and add it if not.

Inside the `ServerSettings` struct, after the `disableAuthentication` line (`:1189`), add:

```ts
  // Master switch for subagent offload. Off writes every thread's flag file as
  // `default`, makes `subagentBackend.set` refuse, and hides the controls.
  subagentBackendEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  subagentBackendThreadModes: SubagentBackendThreadModes.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
```

Inside `ServerSettingsPatch`, after the `localLlm` line (`:1409`) and before the `disableAuthentication` comment, add:

```ts
  subagentBackendEnabled: Schema.optionalKey(Schema.Boolean),
  // A partial record: one thread's entry merges over the map (`deepMerge`), so a
  // client patches `{ [threadId]: mode }` without resending every other thread.
  subagentBackendThreadModes: Schema.optionalKey(SubagentBackendThreadModes),
```

- [ ] **Step 4: Add the capability flag**

In `packages/contracts/src/environment.ts`, after line 105 (`subagentBackend: Schema.optionalKey(Schema.Boolean),`), add:

```ts
  /** Server writes per-thread offload flag files and honours `subagentBackendEnabled` /
      `subagentBackendThreadModes`. Absent on servers from before it shipped, so clients hide
      the per-thread control and the master switch rather than write settings nothing reads. */
  subagentBackendThreadModes: Schema.optionalKey(Schema.Boolean),
```

In `apps/server/src/environment/ServerEnvironment.ts`, after line 226 (`subagentBackend: true,`), add:

```ts
      subagentBackendThreadModes: true,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run from `packages/contracts`: `vp test run src/settings.test.ts` — Expected: PASS, including the parity test (both new fields have patch mirrors).
Run from `apps/server`: `vp test run src/environment/ServerEnvironment.test.ts` — Expected: PASS.
Run from `packages/contracts`: `vp typecheck` — Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts packages/contracts/src/environment.ts apps/server/src/environment/ServerEnvironment.ts apps/server/src/environment/ServerEnvironment.test.ts
git commit -m "feat(contracts): subagent offload master switch, thread modes, capability flag"
```

---

### Task 2: Thread flag-file path — derived dir and encoded file name

**Files:**

- Modify: `apps/server/src/config.ts:31-51` (`ServerDerivedPaths`) and `:129-149` (`deriveServerPaths` return)
- Create: `apps/server/src/subagentBackend/ThreadBackendPath.ts`
- Test: `apps/server/src/subagentBackend/ThreadBackendPath.test.ts`

**Interfaces:**

- Produces: `ServerDerivedPaths.subagentThreadsDir: string` (= `join(stateDir, "subagent-threads")`); `threadBackendFileName(threadId): string`; `threadBackendFilePath(threadsDir, threadId): string`; `THREAD_BACKEND_MAX_NAME_LENGTH = 243`; `isThreadBackendFileNameWritable(name): boolean`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/subagentBackend/ThreadBackendPath.test.ts`:

```ts
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodePath from "node:path";

import {
  THREAD_BACKEND_MAX_NAME_LENGTH,
  isThreadBackendFileNameWritable,
  threadBackendFileName,
  threadBackendFilePath,
} from "./ThreadBackendPath.ts";

const dir = "/state/subagent-threads";

describe("threadBackendFilePath", () => {
  it("stays inside the threads dir for a traversal-shaped thread id", () => {
    const threadId = ThreadId.make("../../etc/passwd");
    const filePath = threadBackendFilePath(dir, threadId);
    expect(NodePath.dirname(filePath)).toBe(dir);
    expect(NodePath.basename(filePath)).not.toContain("/");
    expect(NodePath.basename(filePath)).not.toContain("..");
  });

  it("is injective for ids that differ only in case or punctuation", () => {
    const a = threadBackendFileName(ThreadId.make("thread-A"));
    const b = threadBackendFileName(ThreadId.make("thread-a"));
    const c = threadBackendFileName(ThreadId.make("thread_A"));
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("encodes a non-ASCII id to a plain file name", () => {
    const name = threadBackendFileName(ThreadId.make("线程-🧵"));
    expect(name).toMatch(/^[A-Za-z0-9_-]+\.json$/);
  });

  it("refuses names past the mkdtemp cliff and accepts names at it", () => {
    // 182 UTF-8 bytes encode to 243 base64url chars; 183 bytes encode to 244.
    const atLimit = threadBackendFileName(ThreadId.make("x".repeat(182)));
    const pastLimit = threadBackendFileName(ThreadId.make("x".repeat(183)));
    expect(atLimit.length - ".json".length).toBe(THREAD_BACKEND_MAX_NAME_LENGTH);
    expect(isThreadBackendFileNameWritable(atLimit)).toBe(true);
    expect(isThreadBackendFileNameWritable(pastLimit)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run from `apps/server`: `vp test run src/subagentBackend/ThreadBackendPath.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the path helper and the derived dir**

Create `apps/server/src/subagentBackend/ThreadBackendPath.ts`:

```ts
/**
 * Where a thread's subagent-offload flag file lives. Pure path arithmetic so the
 * Claude adapter can compute the same path it points `SUBAGENT_BACKEND_STATE` at
 * without importing the writer module.
 *
 * The file name is `encodeBase64Url(threadId)` — the same encoding checkpoint refs and
 * terminal logs use for thread ids — so a client-supplied id with `/` or `..` cannot
 * escape the directory, and two distinct ids never share a file.
 */
import * as Encoding from "effect/Encoding";
import type { ThreadId } from "@t3tools/contracts";

/** darwin NAME_MAX is 255; `writeFileStringAtomically`'s mkdtemp appends `.XXXXXX` (7),
 * and the `.json` suffix takes 5. Names longer than this cannot be written at all. */
export const THREAD_BACKEND_MAX_NAME_LENGTH = 243;

const SUFFIX = ".json";

export function threadBackendFileName(threadId: ThreadId): string {
  return `${Encoding.encodeBase64Url(threadId)}${SUFFIX}`;
}

/** Total, never throws: an over-long id still yields a path, so the env var can point
 * at a file that will be absent, and the wrapper refuses on it. */
export function threadBackendFilePath(threadsDir: string, threadId: ThreadId): string {
  return `${threadsDir}/${threadBackendFileName(threadId)}`;
}

export function isThreadBackendFileNameWritable(fileName: string): boolean {
  return fileName.length - SUFFIX.length <= THREAD_BACKEND_MAX_NAME_LENGTH;
}
```

In `apps/server/src/config.ts`, add to `ServerDerivedPaths` after `secretsDir` (`:50`):

```ts
  /** Per-thread subagent-offload flag files, one per live provider session. */
  readonly subagentThreadsDir: string;
```

and in the `deriveServerPaths` return object after `secretsDir: join(stateDir, "secrets"),` (`:148`):

```ts
    subagentThreadsDir: join(stateDir, "subagent-threads"),
```

- [ ] **Step 4: Run to verify it passes**

Run from `apps/server`: `vp test run src/subagentBackend/ThreadBackendPath.test.ts`
Expected: PASS (4 tests).
Run from `apps/server`: `vp typecheck` — Expected: clean (every `ServerConfig.of({...})` literal spreads `derivedPaths`, so no other site needs the new key; if typecheck names one that builds the struct by hand, add `subagentThreadsDir` there the same way).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/config.ts apps/server/src/subagentBackend/ThreadBackendPath.ts apps/server/src/subagentBackend/ThreadBackendPath.test.ts
git commit -m "feat(server): derive the per-thread subagent flag-file path"
```

---

### Task 3: Extract `resolveCursorTarget` and `serializePersistedBackend` (behaviour-preserving)

**Files:**

- Modify: `apps/server/src/subagentBackend/SubagentBackend.ts:157-184` (`writeBackendFileBody`), `:277-331` (`setBackend`), `:397-429` (`reconcileBackend`)
- Test: existing `SubagentBackend.test.ts`, `SubagentBackend.set.test.ts`, `SubagentBackend.reconciler.test.ts` (no new tests; this is a refactor guarded by the existing suite)

**Interfaces:**

- Produces: `resolveCursorTarget(validated: ValidCursorInstance, model: string): Effect<PersistedBackend>` (exported); `serializePersistedBackend(next: PersistedBackend, updatedAt: string): string` (module-private); `OFF` now exported.

- [ ] **Step 1: Run the existing suite to record the baseline**

Run from `apps/server`: `vp test run src/subagentBackend/`
Expected: PASS. Note the test count; it must not change in this task.

- [ ] **Step 2: Extract the serializer**

In `SubagentBackend.ts`, replace lines 156-184 (`writeBackendFileBody` and its doc) with:

```ts
/** The exact plain shape `parsePersistedBackend` and the wrapper's jq filter read. Shared by
 * the global file and every per-thread file, so the wrapper needs no second parser. */
function serializePersistedBackend(next: PersistedBackend, updatedAt: string): string {
  // Writes back the same hand-parsed plain shape `parsePersistedBackend` reads, on purpose, not Schema.
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  return `${JSON.stringify(
    {
      schemaVersion: SUBAGENT_BACKEND_SCHEMA_VERSION,
      backend: next.backend,
      instanceId: next.instanceId,
      model: next.model,
      binaryPath: next.binaryPath,
      apiEndpoint: next.apiEndpoint,
      updatedAt,
      degraded: next.degraded,
    },
    null,
    2,
  )}\n`;
}

/** The write itself, with no locking. Only ever called from inside a `backendWriteSemaphore` permit. */
const writeBackendFileBody = Effect.fn("subagentBackend.writeBody")(function* (
  next: PersistedBackend,
) {
  const fs = yield* FileSystem.FileSystem;
  const filePath = yield* subagentBackendFilePath();
  const updatedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  yield* writeFileStringAtomically({
    filePath,
    contents: serializePersistedBackend(next, updatedAt),
  });
  // After the rename, not before: `writeFileStringAtomically` renames from a temp
  // directory it owns, so there is no earlier handle to chmod. The window is one
  // effect step at the destination, versus a permanent umask leak without it.
  yield* fs.chmod(filePath, 0o600).pipe(Effect.ignore);
});
```

Change line 56 `const OFF: PersistedBackend = {` to `export const OFF: PersistedBackend = {`.

- [ ] **Step 3: Extract `resolveCursorTarget`**

Immediately after `validateCursorInstance` (ends at `:260`), add:

```ts
/**
 * Turns a validated Cursor instance into the record the flag file stores. Resolves the
 * binary on the server's PATH (`resolveCommandPath` is a memoised in-process lookup, not a
 * subprocess) and degrades — writes the configured string as-is with a reason — when that
 * fails, because the wrapper's own shell PATH may still find it.
 */
export const resolveCursorTarget = Effect.fn("subagentBackend.resolveCursorTarget")(function* (
  validated: ValidCursorInstance,
  model: string,
) {
  const { config } = validated;
  const resolution = yield* Effect.result(resolveCommandPath(config.binaryPath));
  const binaryPath = Result.isSuccess(resolution) ? resolution.success : config.binaryPath;
  const degraded = Result.isFailure(resolution)
    ? `Could not resolve "${config.binaryPath}" on the server's PATH; wrote it as-is ` +
      `because the wrapper's own shell PATH may still find it.`
    : null;
  const next: PersistedBackend = {
    schemaVersion: SUBAGENT_BACKEND_SCHEMA_VERSION,
    backend: SUBAGENT_BACKEND_CURSOR,
    instanceId: validated.instanceId,
    model,
    binaryPath,
    apiEndpoint: config.apiEndpoint,
    updatedAt: null,
    degraded,
  };
  return next;
});
```

- [ ] **Step 4: Use it in `setBackend` (keeping the current two-phase shape for now)**

Replace `setBackend` (`:262-331`, doc comment included) with:

```ts
/**
 * Validates a subagent-backend selection, resolves the Cursor binary, and persists
 * it. See the module notes on `backendWriteSemaphore` for why the write itself is
 * always routed through `writeBackendFile`/`writeBackendFileBody`. Settings are
 * re-read inside the permit and the instance validated again right where the write
 * happens, so a disable or reconciliation that landed between the two reads wins.
 */
export const setBackend = Effect.fn("subagentBackend.set")(function* (
  input: SubagentBackendSetInput,
) {
  const serverSettings = yield* ServerSettingsService;

  if (input.backend !== SUBAGENT_BACKEND_CURSOR) {
    const next: PersistedBackend = { ...OFF };
    yield* writeBackendFile(next);
    return next;
  }

  const settings = yield* serverSettings.getRawSettings;
  const validated = validateCursorInstance(settings, input.instanceId);
  if (!validated.ok) {
    const next: PersistedBackend = { ...OFF, degraded: validated.reason };
    yield* writeBackendFile(next);
    return next;
  }

  const model = input.model ?? "auto";

  return yield* backendWriteSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const freshSettings = yield* serverSettings.getRawSettings;
      const revalidated = validateCursorInstance(freshSettings, input.instanceId);
      const next: PersistedBackend = revalidated.ok
        ? yield* resolveCursorTarget(revalidated, model)
        : { ...OFF, degraded: revalidated.reason };
      yield* writeBackendFileBody(next);
      return next;
    }),
  );
});
```

- [ ] **Step 5: Use it in `reconcileBackend`**

Replace the `else` branch of `reconcileBackend` (`:408-422`, from `const resolution =` through the closing `};` of `next = {...}`) with:

```ts
const resolved = yield * resolveCursorTarget(validated, current.model ?? "auto");
next = { ...current, ...resolved, model: current.model };
```

`current.model` is preserved explicitly because reconciliation must never change the user's model; `resolved` carries a fresh `instanceId`, `binaryPath`, `apiEndpoint`, and `degraded`, which is exactly the set the old inline block updated.

- [ ] **Step 6: Run the suite; count must match Step 1**

Run from `apps/server`: `vp test run src/subagentBackend/` — Expected: PASS, same count.
Run from `apps/server`: `vp typecheck` — Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/subagentBackend/SubagentBackend.ts
git commit -m "refactor(server): extract resolveCursorTarget and the flag-file serializer"
```

---

### Task 4: `resolveThreadBackend` — the pure truth table

**Files:**

- Modify: `apps/server/src/subagentBackend/SubagentBackend.ts` (append after `resolveCursorTarget`)
- Test: `apps/server/src/subagentBackend/SubagentBackend.thread.test.ts` (new)

**Interfaces:**

- Consumes: `OFF`, `validateCursorInstance`, `cursorInstances`, `resolveCursorTarget`, `SubagentBackendThreadMode` (Task 1).
- Produces: `resolveThreadBackend(input: { settings: ServerSettings; threadId: ThreadId; global: PersistedBackend }): Effect<PersistedBackend>` (exported).

Truth table from the spec:

| master | thread mode                                           | result                                                            |
| ------ | ----------------------------------------------------- | ----------------------------------------------------------------- |
| false  | any                                                   | `OFF`, degraded `"Subagent offload is switched off in Settings."` |
| true   | absent / `"inherit"`                                  | `global` as-is                                                    |
| true   | `"off"`                                               | `OFF`                                                             |
| true   | `"on"`, global is cursor                              | `global` as-is                                                    |
| true   | `"on"`, global is default, ≥1 enabled Cursor instance | cursor target from the first enabled instance, model `"auto"`     |
| true   | `"on"`, global is default, no Cursor instance         | `OFF`, degraded reason from `validateCursorInstance`              |

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/subagentBackend/SubagentBackend.thread.test.ts`:

```ts
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { type ServerSettings, ThreadId } from "@t3tools/contracts";

import { OFF, type PersistedBackend, resolveThreadBackend } from "./SubagentBackend.ts";

const t1 = ThreadId.make("t1");

const CURSOR: PersistedBackend = {
  schemaVersion: 1,
  backend: "cursor",
  instanceId: "cursor",
  model: "sonnet",
  binaryPath: "/tmp/agent",
  apiEndpoint: "",
  updatedAt: null,
  degraded: null,
};

function settings(input: {
  enabled?: boolean;
  modes?: Record<string, "inherit" | "on" | "off">;
  cursor?: boolean;
}): ServerSettings {
  return {
    subagentBackendEnabled: input.enabled ?? true,
    subagentBackendThreadModes: input.modes ?? {},
    providerInstances:
      input.cursor === false
        ? {}
        : {
            cursor: {
              driver: "cursor",
              displayName: "UniSub",
              enabled: true,
              config: { binaryPath: "/tmp/agent", apiEndpoint: "" },
            },
          },
  } as unknown as ServerSettings;
}

describe("resolveThreadBackend", () => {
  it.layer(NodeServices.layer)("resolveThreadBackend", (it) => {
    it.effect("master off forces default whatever the thread asks", () =>
      Effect.gen(function* () {
        const r = yield* resolveThreadBackend({
          settings: settings({ enabled: false, modes: { t1: "on" } }),
          threadId: t1,
          global: CURSOR,
        });
        expect(r.backend).toBe("default");
        expect(r.degraded).toContain("switched off");
      }),
    );

    it.effect("absent and inherit both return the global record unchanged", () =>
      Effect.gen(function* () {
        const absent = yield* resolveThreadBackend({
          settings: settings({}),
          threadId: t1,
          global: CURSOR,
        });
        const inherit = yield* resolveThreadBackend({
          settings: settings({ modes: { t1: "inherit" } }),
          threadId: t1,
          global: CURSOR,
        });
        expect(absent).toBe(CURSOR);
        expect(inherit).toBe(CURSOR);
      }),
    );

    it.effect("off is default even when the global is cursor", () =>
      Effect.gen(function* () {
        const r = yield* resolveThreadBackend({
          settings: settings({ modes: { t1: "off" } }),
          threadId: t1,
          global: CURSOR,
        });
        expect(r).toEqual(OFF);
      }),
    );

    it.effect("on with a cursor global reuses the global (model included)", () =>
      Effect.gen(function* () {
        const r = yield* resolveThreadBackend({
          settings: settings({ modes: { t1: "on" } }),
          threadId: t1,
          global: CURSOR,
        });
        expect(r).toBe(CURSOR);
      }),
    );

    it.effect("on with a default global resolves the first enabled cursor instance", () =>
      Effect.gen(function* () {
        const r = yield* resolveThreadBackend({
          settings: settings({ modes: { t1: "on" } }),
          threadId: t1,
          global: OFF,
        });
        expect(r.backend).toBe("cursor");
        expect(r.instanceId).toBe("cursor");
        expect(r.model).toBe("auto");
      }),
    );

    it.effect("on with no cursor instance degrades to default with a reason", () =>
      Effect.gen(function* () {
        const r = yield* resolveThreadBackend({
          settings: settings({ modes: { t1: "on" }, cursor: false }),
          threadId: t1,
          global: OFF,
        });
        expect(r.backend).toBe("default");
        expect(r.degraded).toContain("Cursor instance");
      }),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run from `apps/server`: `vp test run src/subagentBackend/SubagentBackend.thread.test.ts`
Expected: FAIL — `resolveThreadBackend` is not exported.

- [ ] **Step 3: Implement**

In `SubagentBackend.ts`, add `type ThreadId` to the `@t3tools/contracts` import, then append after `resolveCursorTarget`:

```ts
export const MASTER_OFF_REASON = "Subagent offload is switched off in Settings.";

/**
 * The one truth table every per-thread writer uses. Master off beats everything;
 * `"inherit"` and an absent entry are the same thing; `"on"` reuses the global Cursor
 * target when there is one and otherwise resolves the first enabled Cursor instance,
 * so a thread can offload without the user first flipping the machine-wide toggle.
 */
export const resolveThreadBackend = Effect.fn("subagentBackend.resolveThread")(function* (input: {
  readonly settings: ServerSettings;
  readonly threadId: ThreadId;
  readonly global: PersistedBackend;
}) {
  const { settings, threadId, global } = input;
  if (settings.subagentBackendEnabled === false) {
    return { ...OFF, degraded: MASTER_OFF_REASON } satisfies PersistedBackend;
  }
  const mode = settings.subagentBackendThreadModes[threadId] ?? "inherit";
  if (mode === "inherit") return global;
  if (mode === "off") return OFF;
  if (global.backend === SUBAGENT_BACKEND_CURSOR) return global;
  const first = cursorInstances(settings)[0]?.instanceId;
  const validated = validateCursorInstance(settings, first);
  if (!validated.ok) return { ...OFF, degraded: validated.reason } satisfies PersistedBackend;
  return yield* resolveCursorTarget(validated, "auto");
});
```

- [ ] **Step 4: Run to verify it passes**

Run from `apps/server`: `vp test run src/subagentBackend/SubagentBackend.thread.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/subagentBackend/SubagentBackend.ts apps/server/src/subagentBackend/SubagentBackend.thread.test.ts
git commit -m "feat(server): resolve a thread's subagent backend from master, mode, and global"
```

---

### Task 5: Per-thread writer and the batch reconciler

**Files:**

- Modify: `apps/server/src/subagentBackend/SubagentBackend.ts` (append after `resolveThreadBackend`; also change `reconcileBackend`)
- Test: `apps/server/src/subagentBackend/SubagentBackend.thread.test.ts` (extend)

**Interfaces:**

- Consumes: `threadBackendFilePath`, `threadBackendFileName`, `isThreadBackendFileNameWritable` (Task 2); `ServerConfig` (`subagentThreadsDir`); `ProviderAdapterRegistry` (`listInstances`, `getByInstance(id).listSessions()`).
- Produces (all exported):
  - `writeThreadBackendFile(threadsDir: string, threadId: ThreadId, next: PersistedBackend): Effect<void, ThreadBackendNameTooLongError | PlatformError>` — no permit.
  - `readThreadBackendFile(threadsDir, threadId): Effect<PersistedBackend>` — test/inspection helper, parses with `parsePersistedBackend`.
  - `reconcileThreadBackendsBody(settings: ServerSettings, global: PersistedBackend): Effect<void>` — no permit; enumerates live sessions per adapter with `Effect.exit`, writes each thread file with per-item `Effect.exit`, logs failures.
  - `reconcileBackendBody(settings): Effect<PersistedBackend>` — no permit; the old `reconcileBackend` body, returning the global record now on disk.
  - `reconcileBackend(settings)` — now `withPermits(1)(reconcileBackendBody(settings))`, signature unchanged.
  - `reconcileAllBackends(): Effect<void>` — takes the permit, reads settings via `getRawSettings`, runs `reconcileBackendBody` then `reconcileThreadBackendsBody`.
  - `writeThreadBackendForSession(threadId): Effect<void>` — takes the permit, resolves and writes one thread file; failures logged and swallowed.

- [ ] **Step 1: Write the failing tests**

Append to `SubagentBackend.thread.test.ts` (add the imports it needs at the top: `Layer` from `effect/Layer`, `Exit` from `effect/Exit`, `FileSystem` from `effect/FileSystem`, `NodeFS`/`NodeOS`/`NodePath` from node, `ProviderInstanceId` from contracts, `ProviderAdapterRegistry` from `../provider/Services/ProviderAdapterRegistry.ts`, `layerTest as serverConfigLayerTest` from `../config.ts`, `layerTest as serverSettingsLayerTest` from `../serverSettings.ts`, `ServerConfig` from `../config.ts`, and from `./SubagentBackend.ts`: `readBackendFile`, `readThreadBackendFile`, `reconcileAllBackends`, `writeBackendFile`, `writeThreadBackendFile`, `writeThreadBackendForSession`, `threadBackendFileName` from `./ThreadBackendPath.ts`). Add the same `HOME`-to-tmpdir `beforeEach`/`afterEach` block as `SubagentBackend.reconciler.test.ts:12-27` so the global file lands in a tmpdir. Add the `// @effect-diagnostics nodeBuiltinImport:off` header comment from that file.

```ts
/** Registry double: every listed instance answers `listSessions` with the given thread ids,
 * except an instance whose id starts with "dead", which dies — the adapter crash the
 * per-adapter isolation exists for. */
function registryLayer(sessions: Record<string, ReadonlyArray<string>>) {
  const ids = Object.keys(sessions).map((id) => ProviderInstanceId.make(id));
  return Layer.succeed(
    ProviderAdapterRegistry,
    ProviderAdapterRegistry.of({
      listInstances: () => Effect.succeed(ids),
      getByInstance: (id) =>
        Effect.succeed({
          listSessions: () =>
            id.startsWith("dead")
              ? Effect.die(new Error("adapter binding mismatch"))
              : Effect.succeed(
                  (sessions[id] ?? []).map((threadId) => ({ threadId: ThreadId.make(threadId) })),
                ),
        } as never),
      getInstanceInfo: () => Effect.die("unused"),
      subscribeChanges: Effect.die("unused"),
    }),
  );
}

const cursorSettings = {
  providerInstances: {
    cursor: {
      driver: "cursor",
      displayName: "UniSub",
      enabled: true,
      config: { binaryPath: "/tmp/agent", apiEndpoint: "" },
    },
  },
};

describe("thread flag files", () => {
  it.layer(NodeServices.layer)("thread flag files", (it) => {
    const withLayers = (
      sessions: Record<string, ReadonlyArray<string>>,
      overrides: Parameters<typeof serverSettingsLayerTest>[0],
    ) =>
      Layer.mergeAll(
        registryLayer(sessions),
        serverConfigLayerTest("/tmp", { prefix: "sbt-thread-" }),
        serverSettingsLayerTest(overrides),
      );

    it.effect("writes a 0600 file inside the threads dir, and reads it back", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { subagentThreadsDir } = yield* ServerConfig;
        yield* writeThreadBackendFile(subagentThreadsDir, t1, CURSOR);
        const info = yield* fs.stat(`${subagentThreadsDir}/${threadBackendFileName(t1)}`);
        expect(Number(info.mode) & 0o777).toBe(0o600);
        const back = yield* readThreadBackendFile(subagentThreadsDir, t1);
        expect(back.backend).toBe("cursor");
        expect(back.instanceId).toBe("cursor");
      }).pipe(Effect.provide(withLayers({}, {}))),
    );

    it.effect("refuses an over-long name instead of failing inside mkdtemp", () =>
      Effect.gen(function* () {
        const { subagentThreadsDir } = yield* ServerConfig;
        const exit = yield* Effect.exit(
          writeThreadBackendFile(subagentThreadsDir, ThreadId.make("x".repeat(183)), CURSOR),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(String(exit)).toContain("ThreadBackendNameTooLongError");
      }).pipe(Effect.provide(withLayers({}, {}))),
    );

    it.effect("reconcileAllBackends writes every live thread and survives a dying adapter", () =>
      Effect.gen(function* () {
        yield* writeBackendFile(CURSOR);
        const { subagentThreadsDir } = yield* ServerConfig;
        yield* reconcileAllBackends();
        const a = yield* readThreadBackendFile(subagentThreadsDir, ThreadId.make("a"));
        const b = yield* readThreadBackendFile(subagentThreadsDir, ThreadId.make("b"));
        expect(a.backend).toBe("cursor");
        expect(b.backend).toBe("default");
      }).pipe(
        Effect.provide(
          withLayers(
            { cursor: ["a"], deadClaude: ["never-written"], claude: ["b"] },
            { ...cursorSettings, subagentBackendThreadModes: { b: "off" } },
          ),
        ),
      ),
    );

    it.effect("master off flips a live thread's file to default in one reconcile", () =>
      Effect.gen(function* () {
        yield* writeBackendFile(CURSOR);
        const { subagentThreadsDir } = yield* ServerConfig;
        yield* reconcileAllBackends();
        const a = yield* readThreadBackendFile(subagentThreadsDir, ThreadId.make("a"));
        expect(a.backend).toBe("default");
        expect(a.degraded).toContain("switched off");
        // The global file is NOT rewritten by the master switch: the wrapper is only ever
        // pointed at thread files from a T3 session, and the user's global choice survives.
        expect((yield* readBackendFile()).backend).toBe("cursor");
      }).pipe(
        Effect.provide(
          withLayers({ cursor: ["a"] }, { ...cursorSettings, subagentBackendEnabled: false }),
        ),
      ),
    );

    it.effect("writeThreadBackendForSession resolves inherit from the global file", () =>
      Effect.gen(function* () {
        yield* writeBackendFile(CURSOR);
        const { subagentThreadsDir } = yield* ServerConfig;
        yield* writeThreadBackendForSession(t1);
        const back = yield* readThreadBackendFile(subagentThreadsDir, t1);
        expect(back.backend).toBe("cursor");
        expect(back.model).toBe("sonnet");
      }).pipe(Effect.provide(withLayers({}, cursorSettings))),
    );

    it.effect("300 concurrent thread writes across 4 threads leave every file parseable", () =>
      Effect.gen(function* () {
        const { subagentThreadsDir } = yield* ServerConfig;
        const ids = ["w1", "w2", "w3", "w4"].map((id) => ThreadId.make(id));
        yield* Effect.forEach(
          Array.from({ length: 300 }, (_, i) => ids[i % 4]!),
          (id) => writeThreadBackendForSession(id),
          { concurrency: "unbounded", discard: true },
        );
        for (const id of ids) {
          const back = yield* readThreadBackendFile(subagentThreadsDir, id);
          expect(back.degraded).toBeNull();
          expect(back.backend).toBe("cursor");
        }
      }).pipe(Effect.provide(withLayers({}, cursorSettings))),
    );
  });
});
```

The storm test needs the global file written first: add `yield* writeBackendFile(CURSOR);` as its first line. `readThreadBackendFile` returns `OFF` with a non-null `degraded` on a torn or missing file (same contract as `readBackendFile`), which is what the `degraded === null` assertion catches.

- [ ] **Step 2: Run to verify it fails**

Run from `apps/server`: `vp test run src/subagentBackend/SubagentBackend.thread.test.ts`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 3: Implement the per-thread writer and reader**

In `SubagentBackend.ts`, add imports:

```ts
import * as Exit from "effect/Exit";
import * as Data from "effect/Data";
import { ServerConfig } from "../config.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import {
  isThreadBackendFileNameWritable,
  threadBackendFileName,
  threadBackendFilePath,
} from "./ThreadBackendPath.ts";
```

Append after `resolveThreadBackend`:

```ts
export class ThreadBackendNameTooLongError extends Data.TaggedError(
  "ThreadBackendNameTooLongError",
)<{ readonly threadId: ThreadId; readonly length: number }> {}

/**
 * Writes one thread's flag file. No locking here — callers hold `backendWriteSemaphore`.
 * Directory 0700 and file 0600 for the same reason as the global file: the record names
 * a binary path and an API endpoint.
 */
export const writeThreadBackendFile = Effect.fn("subagentBackend.writeThread")(function* (
  threadsDir: string,
  threadId: ThreadId,
  next: PersistedBackend,
) {
  const fs = yield* FileSystem.FileSystem;
  const fileName = threadBackendFileName(threadId);
  if (!isThreadBackendFileNameWritable(fileName)) {
    return yield* new ThreadBackendNameTooLongError({ threadId, length: fileName.length });
  }
  yield* fs.makeDirectory(threadsDir, { recursive: true });
  yield* fs.chmod(threadsDir, 0o700).pipe(Effect.ignore);
  const filePath = threadBackendFilePath(threadsDir, threadId);
  const updatedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  yield* writeFileStringAtomically({
    filePath,
    contents: serializePersistedBackend(next, updatedAt),
  });
  yield* fs.chmod(filePath, 0o600).pipe(Effect.ignore);
});

/** Reads a thread's file with the same fail-safe parse as the global one: missing or
 * malformed yields `default` with a `degraded` reason. */
export const readThreadBackendFile = Effect.fn("subagentBackend.readThread")(function* (
  threadsDir: string,
  threadId: ThreadId,
) {
  const fs = yield* FileSystem.FileSystem;
  const filePath = threadBackendFilePath(threadsDir, threadId);
  const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return { ...OFF, degraded: "No thread flag file." } satisfies PersistedBackend;
  const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
  return parsePersistedBackend(raw);
});
```

`parsePersistedBackend(contents: string): PersistedBackend` (`SubagentBackend.ts:70`) takes the raw file text and sets `degraded` on anything it cannot use, so the call above is its exact shape.

- [ ] **Step 4: Implement the batch reconciler and the session writer**

Append after `readThreadBackendFile`:

```ts
/**
 * Rewrites every live thread's file from `settings` and the global record. No locking —
 * callers hold the permit. Sessions are enumerated per adapter, each under `Effect.exit`,
 * because `ProviderService.listSessions` dies on a binding mismatch and one crashed
 * adapter must not stop the other providers' threads from being reconciled. Each write is
 * likewise isolated: one over-long or unwritable thread id is logged, not fatal.
 */
export const reconcileThreadBackendsBody = Effect.fn("subagentBackend.reconcileThreads")(function* (
  settings: ServerSettings,
  global: PersistedBackend,
) {
  const registry = yield* ProviderAdapterRegistry;
  const { subagentThreadsDir } = yield* ServerConfig;
  const threadIds = new Set<ThreadId>();
  for (const instanceId of yield* registry.listInstances()) {
    const sessions = yield* Effect.exit(
      registry.getByInstance(instanceId).pipe(Effect.flatMap((adapter) => adapter.listSessions())),
    );
    if (Exit.isFailure(sessions)) {
      yield* Effect.logWarning("subagentBackend.reconcileThreads: listSessions failed", {
        instanceId,
        cause: sessions.cause,
      });
      continue;
    }
    for (const session of sessions.value) threadIds.add(session.threadId);
  }
  yield* Effect.forEach(
    threadIds,
    (threadId) =>
      resolveThreadBackend({ settings, threadId, global }).pipe(
        Effect.flatMap((next) => writeThreadBackendFile(subagentThreadsDir, threadId, next)),
        Effect.exit,
        Effect.flatMap((exit) =>
          Exit.isFailure(exit)
            ? Effect.logWarning("subagentBackend.reconcileThreads: write failed", {
                threadId,
                cause: exit.cause,
              })
            : Effect.void,
        ),
      ),
    { concurrency: 8, discard: true },
  );
});

/**
 * Global + every thread, under one permit, from one settings read taken inside the permit
 * so a settings write racing this call cannot leave the thread files reflecting an older
 * snapshot than the global file.
 */
export const reconcileAllBackends = Effect.fn("subagentBackend.reconcileAll")(function* () {
  const serverSettings = yield* ServerSettingsService;
  yield* backendWriteSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const settings = yield* serverSettings.getRawSettings;
      const global = yield* reconcileBackendBody(settings);
      yield* reconcileThreadBackendsBody(settings, global);
    }),
  );
});

/**
 * Called by `ProviderService` immediately before every `adapter.startSession`, so the file
 * the new subprocess's `SUBAGENT_BACKEND_STATE` points at exists before the first subagent
 * could be dispatched. Failures are logged and swallowed: an absent file makes the wrapper
 * refuse, which is the safe direction, and must never block a session from starting.
 */
export const writeThreadBackendForSession = Effect.fn("subagentBackend.writeForSession")(function* (
  threadId: ThreadId,
) {
  const serverSettings = yield* ServerSettingsService;
  const { subagentThreadsDir } = yield* ServerConfig;
  yield* backendWriteSemaphore
    .withPermits(1)(
      Effect.gen(function* () {
        const settings = yield* serverSettings.getRawSettings;
        const global = yield* readBackendFile();
        const next = yield* resolveThreadBackend({ settings, threadId, global });
        yield* writeThreadBackendFile(subagentThreadsDir, threadId, next);
      }),
    )
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("subagentBackend.writeForSession failed", { threadId, cause }),
      ),
    );
});
```

- [ ] **Step 5: Split `reconcileBackend` into body + permit wrapper**

Replace the `reconcileBackend` definition (`export const reconcileBackend = Effect.fn("subagentBackend.reconcile")(function* (settings: ServerSettings) { ... });`) with:

```ts
/** The reconcile itself, no locking; returns the global record now on disk (rewritten or not). */
export const reconcileBackendBody = Effect.fn("subagentBackend.reconcileBody")(function* (
  settings: ServerSettings,
) {
  const current = yield* readBackendFile();
  if (current.backend !== SUBAGENT_BACKEND_CURSOR) return current;

  const validated = validateCursorInstance(settings, current.instanceId ?? undefined);
  let next: PersistedBackend;
  if (!validated.ok) {
    next = { ...OFF, degraded: validated.reason };
  } else {
    const resolved = yield* resolveCursorTarget(validated, current.model ?? "auto");
    next = { ...current, ...resolved, model: current.model };
  }

  // Nothing dispatch-relevant changed: skip the write rather than bumping
  // `updatedAt` on every unrelated settings change.
  if (!haveReconcilableFieldsChanged(next, current)) return current;
  yield* writeBackendFileBody(next);
  return next;
});

export const reconcileBackend = Effect.fn("subagentBackend.reconcile")(function* (
  settings: ServerSettings,
) {
  yield* backendWriteSemaphore.withPermits(1)(reconcileBackendBody(settings));
});
```

Keep the doc comment that sat above the old `reconcileBackend` on `reconcileBackendBody`.

- [ ] **Step 6: Run to verify it passes**

Run from `apps/server`: `vp test run src/subagentBackend/` — Expected: PASS, all files (the old reconciler test still passes because `reconcileBackend` kept its signature).
Run from `apps/server`: `vp typecheck` — Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/subagentBackend/SubagentBackend.ts apps/server/src/subagentBackend/SubagentBackend.thread.test.ts
git commit -m "feat(server): write per-thread subagent flag files and reconcile them in one pass"
```

---

### Task 6: Wire the writers — `setBackend` master gate + thread fan-out, reconciler subscriber, session start, spawn env

**Files:**

- Modify: `apps/server/src/subagentBackend/SubagentBackend.ts` (`setBackend`, `subagentBackendReconciler`)
- Modify: `apps/server/src/provider/Layers/ProviderService.ts:484-486` and `:706-708`
- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.ts:5024`
- Modify: `apps/server/src/subagentBackend/SubagentBackend.set.test.ts:80-112` and `SubagentBackend.reconciler.test.ts` (provide the two new layers)
- Test: `SubagentBackend.set.test.ts` (new cases), `SubagentBackend.thread.test.ts` (reconciler case), `apps/server/src/provider/Layers/ClaudeAdapter.test.ts` (or the nearest existing spawn-options test; see Step 5)

**Interfaces:**

- Consumes: `reconcileThreadBackendsBody`, `reconcileAllBackends`, `writeThreadBackendForSession`, `MASTER_OFF_REASON` (Task 5), `threadBackendFilePath` (Task 2).
- Produces: `setBackend` now requires `ProviderAdapterRegistry | ServerConfig` in addition to `ServerSettingsService`; under master-off it returns the current global record with `degraded: MASTER_OFF_REASON` and writes nothing. `subagentBackendReconciler` runs `reconcileAllBackends` at startup and on every change.

- [ ] **Step 1: Write the failing tests**

In `SubagentBackend.set.test.ts`, extend both settings doubles so the tests can provide the two new services. Add at the top:

```ts
import * as Layer from "effect/Layer";
import { layerTest as serverConfigLayerTest } from "../config.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";

const emptyRegistryLayer = Layer.succeed(
  ProviderAdapterRegistry,
  ProviderAdapterRegistry.of({
    listInstances: () => Effect.succeed([]),
    getByInstance: () => Effect.die("no instances in this test"),
    getInstanceInfo: () => Effect.die("no instances in this test"),
    subscribeChanges: Effect.die("unused"),
  }),
);
const supportLayer = Layer.mergeAll(
  emptyRegistryLayer,
  serverConfigLayerTest("/tmp", { prefix: "sbt-set-" }),
);
```

Then change every `Effect.provide(staticSettingsLayer(settings))` / `Effect.provide(refBackedSettingsLayer(ref))` in that file to `Effect.provide(Layer.mergeAll(staticSettingsLayer(settings), supportLayer))` (respectively `refBackedSettingsLayer(ref)`). Do the same in `SubagentBackend.reconciler.test.ts` for `serverSettingsLayerTest(...)`.

Add to the `setBackend` describe block in `SubagentBackend.set.test.ts`:

```ts
it.effect("refuses under master-off without touching the file", () =>
  Effect.gen(function* () {
    const before = yield* readBackendFile();
    const result = yield* setBackend({ backend: "cursor", instanceId: cursorId });
    expect(result.backend).toBe("default");
    expect(result.degraded).toContain("switched off");
    const after = yield* readBackendFile();
    expect(after.updatedAt).toBe(before.updatedAt);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        staticSettingsLayer({ ...settings, subagentBackendEnabled: false }),
        supportLayer,
      ),
    ),
  ),
);
```

(`readBackendFile` and `cursorId` already exist in that file; check the exact identifier for the enabled Cursor instance id constant and use it.)

Add to `SubagentBackend.thread.test.ts` inside the "thread flag files" block:

```ts
it.effect("setBackend fans the new global out to every live thread file", () =>
  Effect.gen(function* () {
    const { subagentThreadsDir } = yield* ServerConfig;
    yield* setBackend({ backend: "cursor", instanceId: ProviderInstanceId.make("cursor") });
    expect((yield* readThreadBackendFile(subagentThreadsDir, ThreadId.make("a"))).backend).toBe(
      "cursor",
    );
    yield* setBackend({ backend: "default" });
    expect((yield* readThreadBackendFile(subagentThreadsDir, ThreadId.make("a"))).backend).toBe(
      "default",
    );
  }).pipe(Effect.provide(withLayers({ cursor: ["a"] }, cursorSettings))),
);

it.effect("the reconciler subscriber writes thread files at startup", () =>
  Effect.gen(function* () {
    yield* writeBackendFile(CURSOR);
    const { subagentThreadsDir } = yield* ServerConfig;
    yield* subagentBackendReconciler;
    const a = yield* readThreadBackendFile(subagentThreadsDir, ThreadId.make("a"));
    expect(a.backend).toBe("cursor");
  }).pipe(Effect.provide(withLayers({ cursor: ["a"] }, cursorSettings))),
);
```

Import `setBackend` and `subagentBackendReconciler` from `./SubagentBackend.ts` in that test file.

- [ ] **Step 2: Run to verify they fail**

Run from `apps/server`: `vp test run src/subagentBackend/`
Expected: the master-off case FAILS (file is written); the fan-out case FAILS (thread file absent → `default` after the cursor set); the startup case FAILS.

- [ ] **Step 3: Collapse `setBackend` into one permit block with the master gate and fan-out**

Replace `setBackend` (from its doc comment through the closing `});`) with:

```ts
/**
 * Validates a subagent-backend selection, resolves the Cursor binary, persists it, and
 * fans the result out to every live thread's file — all under one permit, from one
 * settings read, so a disable or a master-off that lands mid-call is seen by every write
 * or by none. Refuses under master-off without writing: the file the user set last stays
 * as it was, and the returned `degraded` says why nothing changed.
 */
export const setBackend = Effect.fn("subagentBackend.set")(function* (
  input: SubagentBackendSetInput,
) {
  const serverSettings = yield* ServerSettingsService;
  return yield* backendWriteSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const settings = yield* serverSettings.getRawSettings;
      if (settings.subagentBackendEnabled === false) {
        const current = yield* readBackendFile();
        return { ...current, degraded: MASTER_OFF_REASON } satisfies PersistedBackend;
      }
      let next: PersistedBackend;
      if (input.backend !== SUBAGENT_BACKEND_CURSOR) {
        next = { ...OFF };
      } else {
        const validated = validateCursorInstance(settings, input.instanceId);
        next = validated.ok
          ? yield* resolveCursorTarget(validated, input.model ?? "auto")
          : { ...OFF, degraded: validated.reason };
      }
      yield* writeBackendFileBody(next);
      yield* reconcileThreadBackendsBody(settings, next);
      return next;
    }),
  );
});
```

- [ ] **Step 4: Point the reconciler subscriber at `reconcileAllBackends`**

In `subagentBackendReconciler`, replace:

```ts
const reconcileLogged = (settings: ServerSettings) =>
  reconcileBackend(settings).pipe(
    Effect.catchCause((cause) => Effect.logWarning("subagentBackend.reconcile failed", { cause })),
  );

yield *
  serverSettings.getRawSettings.pipe(
    Effect.flatMap(reconcileLogged),
    // A failed read must not stop the reconciler from moving on to the stream
    // below — the same failure tolerance `reconcileLogged` gives every later
    // reconcile.
    Effect.catchCause((cause) =>
      Effect.logWarning("subagentBackend.reconcile (startup) failed", { cause }),
    ),
  );
yield * changes.pipe(Stream.runForEach(reconcileLogged));
```

with:

```ts
// The stream payload is ignored on purpose: `reconcileAllBackends` re-reads settings
// inside the write permit, so the global file and every thread file come from one
// snapshot no concurrent settings write can split.
const reconcileLogged = reconcileAllBackends().pipe(
  Effect.catchCause((cause) => Effect.logWarning("subagentBackend.reconcile failed", { cause })),
);

yield * reconcileLogged;
yield * changes.pipe(Stream.runForEach(() => reconcileLogged));
```

- [ ] **Step 5: Write the thread file before both `startSession` sites**

In `apps/server/src/provider/Layers/ProviderService.ts`, add the import:

```ts
import { writeThreadBackendForSession } from "../../subagentBackend/SubagentBackend.ts";
```

At `:484` (recovery path), the line `yield* prepareMcpSession(input.binding.threadId, bindingInstanceId);` becomes:

```ts
yield * prepareMcpSession(input.binding.threadId, bindingInstanceId);
yield * writeThreadBackendForSession(input.binding.threadId);
```

At `:706` (start path), `yield* prepareMcpSession(threadId, resolvedInstanceId);` becomes:

```ts
yield * prepareMcpSession(threadId, resolvedInstanceId);
yield * writeThreadBackendForSession(threadId);
```

Both sites are inside effects that already yield `ServerConfig` and `ServerSettingsService` at layer scope (`:244`, `:254`), so no new requirement surfaces.

- [ ] **Step 6: Inject the env var at the Claude spawn**

In `apps/server/src/provider/Layers/ClaudeAdapter.ts`, add the import:

```ts
import { threadBackendFilePath } from "../../subagentBackend/ThreadBackendPath.ts";
```

At `:5024`, replace `env: claudeEnvironment,` with:

```ts
        // Points the `subagent-dispatch` wrapper at this thread's own flag file. The base
        // env is shared by reference across sessions (`makeClaudeEnvironment`), so the spread
        // here, not a mutation, is what keeps threads from seeing each other's path.
        env: {
          ...claudeEnvironment,
          SUBAGENT_BACKEND_STATE: threadBackendFilePath(serverConfig.subagentThreadsDir, input.threadId),
        },
```

`serverConfig` is yielded at `:2077` in the same closure; `input.threadId` is the `startSession` input already used at this site for `readMcpProviderSession`.

Add a test to `apps/server/src/provider/Layers/ClaudeAdapter.test.ts` directly after the one titled `runs Claude SDK sessions with the configured CLAUDE_CONFIG_DIR` (`:856-875`), copying its harness shape exactly:

```ts
it.effect("points each session's SUBAGENT_BACKEND_STATE at its own thread flag file", () => {
  const harness = makeHarness({});
  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;
    yield* adapter.startSession({
      threadId: THREAD_ID,
      provider: ProviderDriverKind.make("claudeAgent"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        SYNTHETIC_CLAUDE_CAPABLE_MODEL,
      ),
      runtimeMode: "full-access",
    });

    const createInput = harness.getLastCreateQueryInput();
    const statePath = createInput?.options.env?.SUBAGENT_BACKEND_STATE;
    assert.ok(statePath, "env must carry SUBAGENT_BACKEND_STATE");
    assert.match(statePath, /\/subagent-threads\/[A-Za-z0-9_-]+\.json$/);
    assert.equal(NodePath.basename(statePath), threadBackendFileName(THREAD_ID));
  }).pipe(
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );
});
```

Import `threadBackendFileName` from `../../subagentBackend/ThreadBackendPath.ts` in the test. If `makeHarness` requires an argument other than `{}`, use the same argument the neighbouring `runs Claude SDK sessions` tests pass minus `claudeConfig`.

- [ ] **Step 7: Run to verify it passes**

Run from `apps/server`: `vp test run src/subagentBackend/ src/provider/Layers/ClaudeAdapter.test.ts src/provider/Layers/ProviderService.test.ts` (drop any path that does not exist).
Expected: PASS.
Run from `apps/server`: `vp typecheck` — Expected: clean. If `ws.ts` reports a missing `ProviderAdapterRegistry`/`ServerConfig` requirement for the `subagentBackendSet` handler, the handler map's enclosing effect must yield nothing new — those services are in the server runtime layer — so the error means a `satisfies`/annotated handler type is too narrow; widen that annotation rather than providing the layer inside `ws.ts`.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/subagentBackend apps/server/src/provider/Layers/ProviderService.ts apps/server/src/provider/Layers/ClaudeAdapter.ts
git commit -m "feat(server): per-thread subagent offload with a master switch"
```

---

### Task 7: Web — master switch in Settings → General, searchable and capability-gated

**Files:**

- Modify: `apps/web/src/components/settings/SettingsPanels.tsx:1996-1997` (capability read) and `:2304` (insert row after provider-update-checks)
- Modify: `apps/web/src/components/settings/settingsSearch.ts:37-47` (flags) and `:205-210` (entry) and `:547-555` (filter)
- Modify: `apps/web/src/components/settings/useAvailableSettingsSearchItems.ts:44-45`
- Test: `apps/web/src/components/settings/settingsSearch.test.ts:133-170`

**Interfaces:**

- Consumes: `settings.subagentBackendEnabled` via `UnifiedSettings` (derived from `ServerSettings`, so it exists after Task 1); capability `subagentBackendThreadModes`.
- Produces: search item id `"subagent-offload"`, flag `requiresSubagentBackendThreadModes`, availability key `hasSubagentBackendThreadModes`.

- [ ] **Step 1: Write the failing search test**

In `settingsSearch.test.ts`, find the two `filterAvailableSettingsSearchItems({...})` calls (`:133`, `:161`). Add `hasSubagentBackendThreadModes: false` to the first and `true` to the second, then add a new test in the same describe:

```ts
it("hides the subagent offload switch on servers without the capability", () => {
  const without = filterAvailableSettingsSearchItems({
    hasCloudPublicConfig: false,
    hasPrimaryEnvironment: true,
    hasProviderSettingsEnvironment: true,
    canManageLocalBackend: false,
    isWslSettingsRowVisible: false,
    hasThreadAutoSettlement: true,
    hasSubagentBackendThreadModes: false,
  });
  const with_ = filterAvailableSettingsSearchItems({
    hasCloudPublicConfig: false,
    hasPrimaryEnvironment: true,
    hasProviderSettingsEnvironment: true,
    canManageLocalBackend: false,
    isWslSettingsRowVisible: false,
    hasThreadAutoSettlement: true,
    hasSubagentBackendThreadModes: true,
  });
  expect(without.some((item) => item.id === "subagent-offload")).toBe(false);
  expect(with_.some((item) => item.id === "subagent-offload")).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run from `apps/web`: `vp test run src/components/settings/settingsSearch.test.ts`
Expected: FAIL — typecheck error on the unknown availability key, or `with_` has no such item.

- [ ] **Step 3: Add the search item, flag, and filter**

In `settingsSearch.ts`, after `readonly requiresThreadAutoSettlement?: boolean;` (`:37`) add:

```ts
  readonly requiresSubagentBackendThreadModes?: boolean;
```

After `readonly hasThreadAutoSettlement: boolean;` (`:46`) add:

```ts
  readonly hasSubagentBackendThreadModes: boolean;
```

After the `provider-update-checks` entry (ends `:210`) add:

```ts
  {
    id: "subagent-offload",
    title: "Subagent offload",
    to: "/settings/general",
    searchTerms: ["cursor", "subagents", "offload", "dispatch", "master switch", "thread"],
    requiresSubagentBackendThreadModes: true,
  },
```

In `filterAvailableSettingsSearchItems`, change the last predicate line to:

```ts
      (!item.requiresThreadAutoSettlement || availability.hasThreadAutoSettlement) &&
      (!item.requiresSubagentBackendThreadModes || availability.hasSubagentBackendThreadModes),
```

In `useAvailableSettingsSearchItems.ts`, after the `hasThreadAutoSettlement:` pair (`:44-45`) add:

```ts
        hasSubagentBackendThreadModes:
          primaryServerConfig?.environment.capabilities.subagentBackendThreadModes === true,
```

- [ ] **Step 4: Add the row to the General panel**

In `SettingsPanels.tsx`, after `:1997` (`supportsAutoSettlement = ...`) add:

```tsx
const supportsSubagentOffload =
  useAtomValue(primaryServerConfigAtom)?.environment.capabilities.subagentBackendThreadModes ===
  true;
```

(If `useAtomValue(primaryServerConfigAtom)` is already bound to a local on `:1996`, read `.environment.capabilities.subagentBackendThreadModes === true` off that local instead of calling the hook twice.)

Directly after the provider-update-checks `<SettingsRow ... />` closes (`:2304`), add:

```tsx
{
  supportsSubagentOffload ? (
    <SettingsRow
      serverScoped
      {...searchableSetting("subagent-offload")}
      description="Let threads send their subagents to Cursor. Off stops every thread from offloading and hides the per-thread control in the sidebar."
      resetAction={
        settings.subagentBackendEnabled !== DEFAULT_UNIFIED_SETTINGS.subagentBackendEnabled ? (
          <SettingResetButton
            label="subagent offload"
            onClick={() =>
              updateSettings({
                subagentBackendEnabled: DEFAULT_UNIFIED_SETTINGS.subagentBackendEnabled,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.subagentBackendEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ subagentBackendEnabled: Boolean(checked) })
          }
          aria-label="Subagent offload"
        />
      }
    />
  ) : null;
}
```

`searchableSetting("subagent-offload")` supplies the row title from the search item, the same way the neighbouring rows do.

- [ ] **Step 5: Run to verify it passes**

Run from `apps/web`: `vp test run src/components/settings/settingsSearch.test.ts` — Expected: PASS.
Run from `apps/web`: `vp typecheck` — Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/settings/SettingsPanels.tsx apps/web/src/components/settings/settingsSearch.ts apps/web/src/components/settings/settingsSearch.test.ts apps/web/src/components/settings/useAvailableSettingsSearchItems.ts
git commit -m "feat(web): subagent offload master switch in Settings → General"
```

---

### Task 8: Web — per-thread control in the sidebar panel, master-off dimming

**Files:**

- Modify: `apps/web/src/components/sidebar/sidebarSubagentBackend.logic.ts` (append)
- Modify: `apps/web/src/components/sidebar/SidebarSubagentBackend.tsx`
- Test: `apps/web/src/components/sidebar/sidebarSubagentBackend.logic.test.ts`

**Interfaces:**

- Consumes: `useEnvironmentSettings(environmentId, selector)` (`useSettings.ts:322`), `useUpdateEnvironmentSettings(environmentId)` (`:496`), `useServerConfigs()` (`state/entities.ts:70`), `resolveThreadRouteTarget` (`threadRoutes.ts:68`), `useParams` from `@tanstack/react-router` (pattern at `Sidebar.tsx:1904`).
- Produces: `subagentThreadControlVisibility({ supported, masterEnabled, threadSelected }): "hidden" | "shown"`; `subagentThreadModeLabel(mode): string`.

- [ ] **Step 1: Write the failing logic tests**

Append to `sidebarSubagentBackend.logic.test.ts` (add `subagentThreadControlVisibility`, `subagentThreadModeLabel` to the import):

```ts
describe("subagentThreadControlVisibility", () => {
  it("is shown only with the capability, master on, and a server thread selected", () => {
    expect(
      subagentThreadControlVisibility({
        supported: true,
        masterEnabled: true,
        threadSelected: true,
      }),
    ).toBe("shown");
    expect(
      subagentThreadControlVisibility({
        supported: false,
        masterEnabled: true,
        threadSelected: true,
      }),
    ).toBe("hidden");
    expect(
      subagentThreadControlVisibility({
        supported: true,
        masterEnabled: false,
        threadSelected: true,
      }),
    ).toBe("hidden");
    expect(
      subagentThreadControlVisibility({
        supported: true,
        masterEnabled: true,
        threadSelected: false,
      }),
    ).toBe("hidden");
  });
});

describe("subagentThreadModeLabel", () => {
  it("names each mode for the row status", () => {
    expect(subagentThreadModeLabel("inherit")).toBe("Inherit");
    expect(subagentThreadModeLabel("on")).toBe("Cursor");
    expect(subagentThreadModeLabel("off")).toBe("Default");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run from `apps/web`: `vp test run src/components/sidebar/sidebarSubagentBackend.logic.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Add the logic**

Append to `sidebarSubagentBackend.logic.ts` (add `type SubagentBackendThreadMode` to its `@t3tools/contracts` import):

```ts
/** The per-thread segment renders only when every gate holds: a server that writes thread
 * files, the master switch on, and a server thread (not a local draft) in the route. */
export function subagentThreadControlVisibility(input: {
  readonly supported: boolean;
  readonly masterEnabled: boolean;
  readonly threadSelected: boolean;
}): "hidden" | "shown" {
  return input.supported && input.masterEnabled && input.threadSelected ? "shown" : "hidden";
}

export function subagentThreadModeLabel(mode: SubagentBackendThreadMode): string {
  switch (mode) {
    case "inherit":
      return "Inherit";
    case "on":
      return "Cursor";
    case "off":
      return "Default";
  }
}
```

- [ ] **Step 4: Render the thread control and dim under master-off**

In `SidebarSubagentBackend.tsx`:

Add imports:

```ts
import { useParams } from "@tanstack/react-router";
import {
  type SubagentBackendThreadMode,
  type ThreadId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { useServerConfigs } from "~/state/entities";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import {
  subagentThreadControlVisibility,
  subagentThreadModeLabel,
} from "./sidebarSubagentBackend.logic";
```

(`resolveThreadRouteTarget` lives at `apps/web/src/threadRoutes.ts:68`; `Sidebar.tsx:134` imports it from `"../threadRoutes"`, one directory shallower than this file.)

Add a new component above `SidebarSubagentBackend`:

```tsx
/**
 * Per-thread override segment. Reads and writes the thread's own environment, not the
 * primary: a thread on a remote environment must patch that environment's settings, or the
 * override lands on a server that never spawns the thread.
 */
function ThreadOffloadControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly disabled: boolean;
}) {
  const { environmentId, threadId, disabled } = props;
  const mode = useEnvironmentSettings(
    environmentId,
    (s) => s.subagentBackendThreadModes[threadId] ?? "inherit",
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  return (
    <div className="space-y-1">
      <div className="text-[11px] leading-snug text-muted-foreground">This thread</div>
      <ToggleGroup
        aria-label="This thread's subagent backend"
        variant="segmented"
        value={[mode]}
        onValueChange={(next) => {
          const value = next[0] as SubagentBackendThreadMode | undefined;
          if (!value) return;
          updateSettings({ subagentBackendThreadModes: { [threadId]: value } });
        }}
      >
        {(["inherit", "on", "off"] as const).map((value) => (
          <Toggle key={value} value={value} disabled={disabled}>
            {subagentThreadModeLabel(value)}
          </Toggle>
        ))}
      </ToggleGroup>
    </div>
  );
}
```

Inside `SidebarSubagentBackend`, after `const providers = useAtomValue(primaryServerProvidersAtom);` (`:75`) add:

```tsx
const masterEnabled = usePrimarySettings((s) => s.subagentBackendEnabled);
const routeTarget = useParams({
  strict: false,
  select: (params) => resolveThreadRouteTarget(params),
});
const threadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
const serverConfigs = useServerConfigs();
const threadSupported =
  threadRef !== null &&
  serverConfigs.get(threadRef.environmentId)?.environment.capabilities
    .subagentBackendThreadModes === true;
const threadControl = subagentThreadControlVisibility({
  supported: threadSupported,
  masterEnabled,
  threadSelected: threadRef !== null,
});
```

(`usePrimarySettings<T>(selector?)` at `useSettings.ts:332` accepts the selector.)

Change `const controlsDisabled = pending || state == null;` (`:96`) to:

```tsx
const controlsDisabled = pending || state == null || !masterEnabled;
```

Inside the open panel `<div id={PANEL_ID} ...>`, immediately before the closing `</div>` at `:253`, add:

```tsx
{
  !masterEnabled ? (
    <p className="text-[11px] leading-snug text-muted-foreground">
      Subagent offload is switched off in Settings → General.
    </p>
  ) : null;
}

{
  threadControl === "shown" && threadRef ? (
    <ThreadOffloadControl
      environmentId={threadRef.environmentId}
      threadId={threadRef.threadId}
      disabled={pending}
    />
  ) : null;
}
```

- [ ] **Step 5: Run to verify it passes**

Run from `apps/web`: `vp test run src/components/sidebar/sidebarSubagentBackend.logic.test.ts` — Expected: PASS.
Run from `apps/web`: `vp typecheck` — Expected: clean. (`useServerConfigs()` at `state/entities.ts:70` returns `ReadonlyMap<EnvironmentId, ServerConfig>`, so `.get` is correct.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/sidebar/SidebarSubagentBackend.tsx apps/web/src/components/sidebar/sidebarSubagentBackend.logic.ts apps/web/src/components/sidebar/sidebarSubagentBackend.logic.test.ts
git commit -m "feat(web): per-thread subagent offload control in the sidebar"
```

---

### Task 9: Live smoke against a worktree server (no browser)

**Files:** none modified. Uses the worktree's own `.t3` state (never `~/.t3/userdata`).

- [ ] **Step 1: Start the dev server against seeded worktree state**

From the repo root, seed per AGENTS.md "Test data" (VACUUM INTO), then run `vp run dev` in the background and note the `[dev-runner]` ports and the PID.

- [ ] **Step 2: Start one Claude thread and inspect its file**

Send a one-line turn to a Claude thread through the web client you are already logged into (or skip to Step 3 if no client is available). Then:

```bash
ls -la .t3/userdata/subagent-threads/
cat .t3/userdata/subagent-threads/*.json
```

Expected: one `.json` per live thread, mode 0600, directory 0700, contents matching the global file when no override is set.

- [ ] **Step 3: Flip master off via the settings RPC or by editing the worktree's `settings.json`, then re-read**

Expected: within one settings change every thread file reads `"backend": "default"` with `"degraded": "Subagent offload is switched off in Settings."`, and the global file is unchanged.

- [ ] **Step 4: Confirm the wrapper honours the thread file**

```bash
printf 'hi' > /tmp/p.txt
SUBAGENT_BACKEND_STATE=.t3/userdata/subagent-threads/<one>.json ~/bin/subagent-dispatch smoke /tmp/p.txt; echo rc=$?
```

Expected: `rc=3` while the file says `default`; with master on and the thread mode `on`, the wrapper execs Cursor (interrupt it with Ctrl-C; do not let it run).

- [ ] **Step 5: Stop the server by its tracked PID**

```bash
kill <pid>
```

Record the observed outcomes in the commit body of Task 10 (one line each).

---

### Task 10: Docs

**Files:**

- Modify: `docs/user/thread-sidebar.md` (new section before `## Panel motion` at `:45`)
- Modify: `docs/internals/glossary.md` (new entry)
- Modify: `apps/server/src/subagentBackend/SubagentBackend.ts:1-16` (module doc)

- [ ] **Step 1: User doc**

Insert before `## Panel motion` in `docs/user/thread-sidebar.md`:

```markdown
## Subagent offload

The Subagents row at the bottom of the sidebar decides where agents send their subagents. The top segment is the machine-wide default: Default keeps subagents on the same provider and model as the thread, Cursor sends them to the Cursor instance you pick.

With a thread open, a second segment appears for that thread alone. Inherit follows the machine-wide choice, Cursor offloads this thread even when the default is off, and Default keeps this thread's subagents local even when the default is on.

Settings → General has a Subagent offload switch. Turn it off to stop every thread from offloading; the per-thread segment disappears and the machine-wide segment is greyed out until you turn it back on. Only Claude Code threads offload today.
```

- [ ] **Step 2: Glossary entry**

Add to `docs/internals/glossary.md`, in alphabetical position:

```markdown
### Subagent offload

The per-machine and per-thread choice of where a coding agent dispatches its subagents. The server writes one machine-global flag file the `subagent-dispatch` wrapper reads, plus one file per live thread under `<stateDir>/subagent-threads/`, and points each Claude subprocess at its own file through `SUBAGENT_BACKEND_STATE`. Resolution: master switch (`subagentBackendEnabled`) → thread mode (`subagentBackendThreadModes`, `inherit | on | off`) → machine-global record. Files: `apps/server/src/subagentBackend/SubagentBackend.ts`, `ThreadBackendPath.ts`.
```

- [ ] **Step 3: Module doc**

In `SubagentBackend.ts:1-16`, after the paragraph ending `never looks.`, add a paragraph:

```ts
 *
 * Per-thread files DO live under T3 home (`ServerConfig.subagentThreadsDir`): the server
 * itself points each subprocess at its file via `SUBAGENT_BACKEND_STATE`, so the wrapper's
 * fixed default path is irrelevant for them. Every writer here resolves the same
 * `resolveThreadBackend` table and takes the same `backendWriteSemaphore` permit.
```

- [ ] **Step 4: Format and commit**

Run from the repo root: `vp fmt` on the changed files, then:

```bash
git add docs/user/thread-sidebar.md docs/internals/glossary.md apps/server/src/subagentBackend/SubagentBackend.ts
git commit -m "docs: per-thread subagent offload and master switch"
```

---

## Self-review

**Spec coverage.** Master switch (Task 1 field, Task 4 gate, Task 6 refusal, Task 7 row, Task 8 dimming). Per-thread modes with inherit default (Task 1, Task 4, Task 8). Per-thread file + env var (Tasks 2, 5, 6). Three writers under one permit from one settings read (Task 5 `reconcileAllBackends`/`writeThreadBackendForSession`, Task 6 `setBackend`). Per-adapter enumeration with `Effect.exit` (Task 5). Length cliff (Tasks 2, 5). Capability gate on every client control and the search entry (Tasks 1, 7, 8). Docs (Task 10). Spec follow-ups deliberately out of scope: ThreadId charset constraint, forward-compatible mode values, `--` in the wrapper, apiEndpoint redaction, mobile control.

**Type consistency.** `resolveThreadBackend({ settings, threadId, global })` is the same shape in Tasks 4, 5, 6. `writeThreadBackendFile(threadsDir, threadId, next)` positional in Tasks 5 and 6. `reconcileThreadBackendsBody(settings, global)` in Tasks 5 and 6. `MASTER_OFF_REASON` defined in Task 4, used in Task 6. `hasSubagentBackendThreadModes`/`requiresSubagentBackendThreadModes` consistent across Task 7.

**Verified against the tree while writing:** `parsePersistedBackend(contents: string)` (`SubagentBackend.ts:70`), `usePrimarySettings(selector?)` (`useSettings.ts:332`), `useServerConfigs(): ReadonlyMap` (`entities.ts:70`), `resolveThreadRouteTarget` at `threadRoutes.ts:68`, and the Claude harness `getLastCreateQueryInput().options.env` capture (`ClaudeAdapter.test.ts:870`). The one remaining executor judgment call is flagged inline: `makeHarness` arguments in Task 6 Step 6.
