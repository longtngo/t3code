# Work-log tool detail views — 2026-07-15

## Goal

The work-log detail modal (`WorkEntryDetailDialog`) currently renders every entry the same way:
changed-files list + a pretty-printed JSON dump (or plain text) of the raw payload. For three
common Claude tool calls this is unreadable. Give each a purpose-built body:

1. **AskUserQuestion** (`data.toolName === "AskUserQuestion"`, itemType `dynamic_tool_call`) —
   display each question with its header, options, and the answer the user chose.
2. **Bash** (`data.toolName === "Bash"`, itemType `command_execution`) — display the command and
   its result (stdout/stderr), error-styled when the tool result is an error.
3. **Edit** (`data.toolName === "Edit"`, itemType `file_change`) — display the change as a diff,
   rendered with the app's existing git-diff component.

Everything else keeps the current JSON/text/empty fallback. No server change — the client already
receives what it needs.

## Load-bearing premises (validated against the live system, Hard Rule 8)

- **The client entry carries the raw tool payload.** `session-logic.ts:602` sets
  `entry.detailPayload = payload` (the full raw activity payload, held by reference). The merge
  path (`mergeDerivedWorkLogEntries`, `{...previous, ...next}`) keeps the latest activity's
  `detailPayload`, i.e. the *completed* one that includes `result`. ✓ (read source)
- **The payload shape is `data: { toolName, input, result }`, passed through raw.**
  `ClaudeAdapter.ts:2177` emits `toolData = { toolName: tool.toolName, input: tool.input, result:
  toolResult.block }` on item completion; `input` and `result` are not stripped or reshaped.
  `result` is the raw tool-result block `{ type: "tool_result", content, tool_use_id, is_error? }`.
  ✓ (read emission path) — and the three example payloads in the task args are live captures that
  match this exactly (direct measurement of the live system).
- **`getRenderablePatch(patchString)` → `FileDiff` is the git-diff component.** `lib/diffRendering.ts`
  parses a **unified-diff patch string** into `FileDiffMetadata[]`; `DiffPanel.tsx` renders each with
  `@pierre/diffs/react`'s `FileDiff`. Reusing it gives visual parity with the app's diff panel —
  which is what "the git diff component" asks for. ✓ (read source)
- **`FileDiff` renders WITHOUT a WorkerPool context** (Stage-6 simplicity review corrected an
  earlier wrong premise). `useFileDiffInstance` reads the pool via `useContext` and passes
  `undefined` when there is no provider, so `FileDiff` renders fine poolless — it just skips
  worker-backed intra-line syntax highlighting. **Proof by precedent in the same file:**
  `UserMessageReviewCommentCard` (`MessagesTimeline.tsx:1086-1102`) already renders `<FileDiff>`
  via `getRenderablePatch` with **no** `DiffWorkerPoolProvider` in its ancestry, in the exact same
  component tree as the work-log modal. And `FileDiff` is imported *eagerly* at
  `MessagesTimeline.tsx:20` (already in the main chat chunk). So the Edit body renders `<FileDiff>`
  **inline and poolless**, cloning that pattern — no new file, no `React.lazy`, no scoped provider.
  ✓ (read source + installed package)
- **A unified-diff generator is available with no new fetch.** `diff@8.0.3` (jsdiff, exposes
  `createPatch`) is already resolved in the pnpm store as a transitive dep. Adding it as an
  explicit `apps/web` dependency links the cached copy. ✓ (`node_modules/.pnpm/diff@8.0.3`)
- **AskUserQuestion answers exist only in `result.content` as a formatted string** — there is no
  structured answers field. Format:
  `Your questions have been answered: "Q1"="A1", "Q2"="A2". You can now continue with these
  answers in mind.` Answers can contain commas, periods, and quotes, so naive splitting fails;
  the exact question texts (from `input.questions[].question`) are used as anchors to slice each
  answer deterministically. ✓ (live captured payload)

## Approach

### Where the change lives

Only the **detail modal** gains richer rendering — the inline work-log row already shows a good
one-line summary and is out of scope. Two files change plus one new lazy component:

- `apps/web/src/components/chat/workEntryDetail.logic.ts` — pure parsing/normalization. Extend the
  `WorkEntryDetailBody` union; add specialized parsers keyed off `data.toolName`. No React.
- `apps/web/src/components/chat/WorkEntryDetailDialog.tsx` — switch on `body.kind` and render the
  matching sub-view (including the inline `FileDiff` edit diff); unchanged for JSON/text/empty.

### `WorkEntryDetailBody` (extended union)

```ts
type WorkEntryDetailBody =
  | { kind: "questions"; questions: ReadonlyArray<{
        header?: string; question: string;
        options: ReadonlyArray<{ label: string; description?: string }>;
        answer: string | null;  // null when not parseable from result.content
      }> }
  | { kind: "command"; command: string; output: string | null; isError: boolean }
  | { kind: "edit"; filePath: string; patch: string }   // patch = unified diff string
  | { kind: "json"; json: string }                       // existing
  | { kind: "text"; text: string }                       // existing
  | { kind: "empty" };                                   // existing
```

### `formatWorkEntryDetail` dispatch order

1. Read the tool payload: `const tool = readToolPayload(entry)` → `{ toolName, input, result } | null`
   from `entry.detailPayload.data` (guarded, all-unknown-typed).
2. If `tool` present, switch on `tool.toolName`:
   - `"AskUserQuestion"` → `parseAskUserQuestionBody(input, result)` — returns `questions` body, or
     `null` to fall through if `input.questions` is missing/malformed.
   - `"Bash"` → `parseBashBody(input, result)` — returns `command` body, or `null` if no command.
   - `"Edit"` → `buildEditBody(input)` — returns `edit` body when `file_path` +
     `old_string`/`new_string` are strings (patch built with jsdiff `createPatch`), else `null`.
   - Any `null` (unparseable) → fall through to the existing JSON/text logic (never worse than today).
3. Otherwise the existing JSON → text → empty logic, unchanged.

### AskUserQuestion answer extraction (anchor-based, defensive)

**First normalize `result.content` to a string** via the shared `normalizeToolResultContent`
(below) — Stage-6 correctness Finding 1: server-side the result block's `content` is frequently an
**array** of `{ type: "text", text }` blocks, not a string, and feeding an array to the anchor
parser would `indexOf`-search array elements → `-1` for every anchor → *every* answer silently
blanks out. Normalizing first closes that gap and makes the parser robust to both shapes.

`extractAskUserQuestionAnswers(content: string, questionTexts): (string | null)[]`:
- For each question text `Ti`, find the anchor `"${Ti}"="` via `indexOf` starting after the
  previous match (left-to-right, sequential).
- Answer `i` runs from just after its anchor to just before the next question's anchor (trimming
  the `", ` + closing quote that separates them); the last answer runs to the `". You can now
  continue` suffix, or the final `"` if that suffix is absent.
- Any question whose anchor isn't found → its answer is `null` (rendered as "no recorded answer");
  the questions/options still render. Extraction never throws.
- The view highlights the option whose `label` equals the parsed `answer` (computed at render time
  from `answer`, not stored in the union — Stage-6 simplicity trim). Free-text answers match no
  option and are shown as the answer text.

### Shared result-content normalization

`normalizeToolResultContent(content): string | null` (shared by Bash and AskUserQuestion):
- `string` → as-is.
- array → concat, for each element, `element.text` **only when** `element.type === "text"` and
  `typeof element.text === "string"` (Stage-6 correctness Finding 4 — a non-text block, e.g. an
  image or nested `tool_result`, must not yield `"undefined"`/`"[object Object]"`); joined by `\n`.
  An empty array → `""` (empty output, still shown); no text parts → `""`.
- anything else (e.g. `undefined`) → `null` (no output).

Bash body: `command = input.command` (string); `output = normalizeToolResultContent(result.content)`;
`isError = result.is_error === true`. (`input.description` dropped — the ask is literally command +
result; Stage-6 simplicity trim.)

### Edit diff

`buildEditBody(input)`: `patch = createPatch(file_path, old_string ?? "", new_string ?? "")` (jsdiff).
The dialog runs `getRenderablePatch(patch, "worklog-edit:<theme>")`; on `kind:"files"` renders
`<FileDiff options={{ diffStyle: "unified", theme: resolveDiffThemeName(resolvedTheme) }}>`
**inline and poolless** (cloning `UserMessageReviewCommentCard`); on `kind:"raw"`/parse failure shows
the raw patch in a `<pre>`. Theme comes from `useTheme()`. No worker pool, no lazy boundary.

Verified end-to-end at the parse layer: jsdiff `createPatch` output (`Index:`/`---`/`+++`/`@@`
header) parses through `@pierre/diffs` `parsePatchFiles` for change / new-file / delete /
no-trailing-newline, each → one file, one hunk, correct name.

## Alternatives considered

- **A lazy `WorkEntryEditDiff.tsx` + its own scoped `DiffWorkerPoolProvider`** (the original draft).
  Rejected after the Stage-6 review disproved its premise: `FileDiff` renders poolless, is already
  eagerly in the chat chunk, and the same file already renders it poolless for review-comment diffs.
  The lazy component + provider were pure overhead (an extra file, a Suspense boundary, and a
  worker-pool lifecycle on every modal-open) — inline poolless render is both smaller and lighter.
- **Hand-rolled `diffLines`-into-colored-`<pre>` (no `@pierre/diffs` at all).** Rejected: diverges
  visually from the app's diff panel — the exact thing "the git diff component" asks us to match —
  for no benefit now that poolless `FileDiff` is free.
- **Change the inline work-log row too.** Out of scope — the row's one-line summary is already good;
  the ask is about the detail view. Kept minimal.
- **Split answers on `", "`.** Rejected — answers contain commas/quotes; only question-text anchors
  are robust.
- **Hand-roll a unified-diff generator instead of jsdiff.** Rejected per the minimal-code ladder:
  a correct line diff (Myers) is non-trivial; jsdiff is already in the store.

## Files/modules touched

- `apps/web/src/components/chat/workEntryDetail.logic.ts` (+ `.test.ts`) — parsers + union.
- `apps/web/src/components/chat/WorkEntryDetailDialog.tsx` — body dispatch + question / command /
  inline edit-diff views.
- `apps/web/package.json` — add `diff` (jsdiff) dependency (already a direct dep of `apps/mobile`).

## Tradeoffs / known limitations

- The Edit diff shows only `old_string` → `new_string` (the fragment the tool changed), not the
  file's surrounding context — that is all the payload carries, and it is exactly what the tool did.
- Only `Edit` gets the diff view; `Write`/`MultiEdit` fall back to JSON (documented follow-up).
- The inline `FileDiff` renders poolless, so it has no worker-backed intra-line syntax highlighting
  (the full `DiffPanel` does). This matches the sibling review-comment diff in the same component,
  so it is the established norm here, not a regression. Adding a provider later is a trivial,
  deliberate follow-up if highlighting is ever wanted.
- AskUserQuestion answer extraction depends on the Claude **SDK's** result-string wording
  (`… "Q"="A", … . You can now continue …`), produced by the SDK (gated to SDK ≥ 2.1.121), not by
  this repo — a minor SDK bump could change it (Stage-6 correctness Finding 2). It degrades
  gracefully to "no recorded answer" (never throws; questions/options still render).
- Residual anchor edge (Stage-6 correctness Finding 3): if an answer literally contains the exact
  `"<nextQuestionText>"="` sequence, its boundary truncates early → wrong/partial text for that pair
  (never a throw). Vanishingly unlikely in real answers; accepted.
- jsdiff patches from a fragment always parse as `type: "change"` (the new/deleted badge needs
  file objects `getRenderablePatch` doesn't supply). Irrelevant for `Edit` (always a real change);
  a note for the deferred `Write` follow-up (Stage-6 correctness Finding 5).

## Follow-ups deferred

- Extend the diff view to `Write` (new file) and `MultiEdit` (multiple hunks).
- Consider a "show raw JSON" toggle inside the specialized views for power users.
