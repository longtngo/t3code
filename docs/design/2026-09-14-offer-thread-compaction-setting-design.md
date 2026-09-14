# Offer to compact threads setting - design

## 1. Goal and baseline

One switch, **Offer to compact threads** (default on). Off stops T3 Code from offering to compact
an old Claude thread. Manual `/compact` stays.

Stage 1b baseline (untouched tree, `dd6b3547b`):

```
setting-exists  rc=1  offerThreadCompaction in contracts/adapter/ChatView/SettingsPanels: 0 hits
                      (same grep shape reads 2 for allowSpendingCredits in contracts, so it can hit)
```

## 2. Scope

Two offer surfaces exist today, both Claude-only:

| Surface                                                                      | Where                                                                                                                                            | Reaches                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| A. Resume banner "Resume with less context"                                  | `ChatView.tsx` `resumeCompactionBannerItem`, gated by `shouldOfferResumeCompaction` (`provider === "claudeAgent"`, >=100k tokens, >=70 min idle) | web, desktop                                                |
| B. Claude CLI `resume_return` dialog, relayed as a "Resume session" question | `ClaudeAdapter.ts` `handleResumeDialog`                                                                                                          | web, desktop, mobile (it is an ordinary pending user input) |

Must have: both surfaces honour the switch; the switch is server-scoped so B (server) and A (every
client of that environment) agree; a Settings row and a search entry.

Knowingly left:

- Manual compaction (`/compact`, composer `compactContext`) - an action, not an offer.
- Other providers - no compaction offers exist for Codex, Cursor, Grok, OpenCode, Antigravity.
- Mobile Settings row - mobile exposes none of the fork's server switches
  (`subagentBackendEnabled`, `allowSpendingCredits` have no mobile row). Mobile still obeys the
  switch for surface B because the server suppresses the question.
- Claude's "Don't ask again" answer and the web's permanent dismissal - unchanged; the switch is an
  additional, reversible gate, not a rewrite of those.

## 3. Premises

| #   | Premise                                                                                                                     | Source                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Returning `{ behavior: "completed", result: "continue" }` from `onUserDialog` resumes without compaction and without asking | Already what "Keep full history" returns (`ClaudeAdapter.ts` `handleResumeDialog`); SDK `UserDialogResult` accepts `completed` + any result (`sdk.d.ts:8650`)                                                                                              |
| P2  | A `ServerSettings` field mirrored in `ServerSettingsPatch` persists and reaches clients with no other plumbing              | Precedent `allowSpendingCredits` (`settings.ts:1674,1958`), parity test in `settings.test.ts`                                                                                                                                                              |
| P3  | ChatView already holds per-environment unified settings                                                                     | `ChatView.tsx:1631` `useEnvironmentSettings(environmentId)`, same component as the banner (`ChatView` starts at 1460)                                                                                                                                      |
| P4  | The adapter can read live settings cheaply                                                                                  | `ClaudeDriver.ts:135` yields `ServerSettingsService`, so it is in the adapter's context; production `getRawSettings` is a cached read that `updateSettings` refreshes (`serverSettings.ts:202-221,1032`). `getSettings` does secret-store reads - not used |

## 4. Alternatives

- **Do nothing** - users who never want the offer keep dismissing it per thread (banner) or answer
  "Don't ask again" (dialog), which is irreversible from T3 Code and does not cover the banner.
- **Client-only setting** - hides A but not B; mobile and every other client still get the dialog.
  Rejected.
- **Drop `resume_return` from `supportedDialogKinds` when off** - fixed at session start, so a
  toggle does not reach live sessions until they restart. Rejected for a live read at dialog time.
- **Answer the dialog with `"never"` when off** - persists in Claude's own state, so turning the
  switch back on would not bring the offer back. Rejected; `"continue"` keeps it reversible.

## 5. Design

**Contracts** (`packages/contracts`)

- `ServerSettings.offerThreadCompaction: Boolean`, decoding default `true`, `catchDecoding` to
  `true` (same containment as `allowSpendingCredits`).
- `ServerSettingsPatch.offerThreadCompaction: optionalKey(Boolean)`.
- `ExecutionEnvironmentCapabilities.offerThreadCompaction: optionalKey(Boolean)`; the server
  advertises `true` in `ServerEnvironment.ts`.

**Server**

- `makeClaudeAdapter` yields `ServerSettingsService`. `handleResumeDialog`, after the `dialogKind`
  check:

  ```
  offer = getRawSettings.offerThreadCompaction, or true if the read fails
  if !offer: return { behavior: "completed", result: "continue" }
  ```

  No `user-input.requested` is emitted, so no client sees a question. No driver option: an optional
  option made the wiring deletable with every test green (review F1).

**Web**

- Banner: `shouldOfferResumeCompaction` (pure, tested) takes a required `offerEnabled`; ChatView
  passes `settings.offerThreadCompaction`.
- Settings -> General row "Offer to compact threads", `serverScoped`, shown only when every connected
  environment advertises the capability, beside "Allow to spend credits". Search entry with
  `requiresOfferThreadCompaction`, availability from `useAvailableSettingsSearchItems`.

**Docs** - `docs/user/composer.md` compaction paragraph gets the switch.

## 6. Invariants

| #   | Invariant                                                                     | Check that fails if broken                                   |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------ |
| I1  | Off -> the resume dialog completes `"continue"` and emits no user-input event | adapter test races the dialog against the event stream       |
| I2  | On / absent -> dialog unchanged                                               | existing adapter test "routes Claude resume compaction..."   |
| I3  | Missing or undecodable setting reads `true`                                   | contracts test: decode `{}` and `"false"`                    |
| I4  | Server advertises the capability, or the row is hidden everywhere             | `ServerEnvironment.test.ts` capability assertion             |
| I5  | Toggle reaches a live session without restart                                 | same test flips the real setting; second question is head    |
| I6  | Off -> banner not offered                                                     | `ContextWindowMeter.logic.test.ts`; tsc if ChatView drops it |

## 7. Failure behaviour

| Case                     | Behaviour                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------ |
| Settings read fails      | Treated as on (offer shown) - the pre-existing behaviour                             |
| Older server, new client | Row hidden (capability absent); banner reads the default `true`                      |
| New server, older client | Dialog suppressed server-side; older client's banner still shows (it has no setting) |

## 8. Peer scan

N/A: writes only the settings document through the existing `updateSettings` path.

## 9. Review exit note

Round 1: one subagent ran 6a and the Correctness, Simplicity and Compatibility lenses, building the
design in a scratch clone. CONDITIONAL GO. Applied: F1 (driver option -> adapter reads the service),
F2 (banner gate moved into the tested pure function, I6), F3 (`getRawSettings`), F4 (race-shaped
test), F5 (`// FORK:` markers, stale context-meter sentence in the user doc). Kept: capability gate,
search `some` vs row `every` (matches `allowSpendingCredits`). Mutations: removing the server guard
fails I1 in 24ms; removing the ChatView argument fails tsc. Under 300 LOC and round 1 changed a
component boundary only in the direction the reviewer built and ran, so no second round - all lenses
quiescent after round 1. Security, performance and observability lenses not triggered.
