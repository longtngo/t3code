# Crew Orchestration — Review Log

Ten review rounds produced this design. The spec states the invariants; this
file keeps the history, because an implementer needs the first and a reviewer
needs the second.

## 0. How this revision was written

Six rounds produced two lessons, and R7 applies both **as gates rather than as
intentions**.

**Lesson 1 — verify by executing.** Evidence ranks `[X: command → result]` >
`[V: file:line]` > `[U]`. A `[V]` on _"we can call X"_ must cite a **signature or
an existing call site**; R5's worst defects were true `[V]`s whose call site was
never checked.

**Lesson 2 — a fix must be walked through every section that consumes what it
changes.** R6's three headline fixes were each individually well-evidenced and each
created a worse defect than it retired, because nothing forced that walk. Round 6
named the gate: _enumerate the outputs of every precedence rule, the trigger of
every lifecycle edge, and the consumer of every terminal state, and reconcile all
three before writing prose._

**Lesson 3 — a gate that is not mutation-tested is a comment.** R7 shipped
`statecheck.py` and claimed it enforced the state machine. Reviewers seeded 6 and 12
defects into it; **5 and 11 survived**. It exempted every terminal state by its own
first line, and read an author-supplied `processMayBeLive` that defaulted to absent —
so it asserted back whatever the spec asserted. It also passed clean on R7's own
instance of the exact defect it was written for.

**R8's gates derive rather than accept, and prove it.** `statecheck.py` computes
liveness from the transition edges, checks that every cap-holding state can be
released _by an actor that exists in its own phase_, and rejects a precedence rule
that absorbs the one status the live renderings depend on. It carries a **10-mutation
suite (10/10 caught)**, it **still fails revision 7 with 13 findings** — including all
four of that round's criticals — and it passes this one. `gen.py` emits §5, §9 and
§13's tables so a hand-edit fails the build, and `docparse.py` reads the prose, which
is where `Discard` and `Halt` hid as actions with no edge. All three run from
`pnpm verify` `[X: verify:crew-spec → PASS]`.

**Tags:** `[X]` executed · `[V: path:line]` read · `[W]` **verified absence — must
be written** (the code is proven not to exist; this is scoped work, not an unknown)
· `[U]` genuinely unverified hypothesis. R6 filed four verified absences as `[U]`,
which inverted the vocabulary and inflated Phase 1's blocker count from one to four.
**A `[U]` or `[W]` under a §2 goal or a §8 gate row carries `BLOCKS PHASE N`, and
§13's roster is generated from those markers** — R6 hand-maintained it and it
disagreed with the markers in all three phases.

**Paths** are repo-relative from the workspace root. R6's rule ("relative to
`apps/server/src/`") named directories that do not exist and is withdrawn.

## 14. Revision history

| Rev | Score | Characteristic failure                                      |
| --- | ----- | ----------------------------------------------------------- |
| R1  | 2.25  | Asserted mechanisms that do not exist                       |
| R2  | 3.0   | Located mechanisms, over-credited their effect              |
| R3  | 3.5   | Same, in its most confident sections                        |
| R4  | 3.3   | Same, plus unverified _negatives_                           |
| R5  | 3.8   | Cited real mechanisms whose **call site** was never checked |
| R6  | 4.1   | Citations sound; **the sections built on them disagreed**   |
| R7  | 4.2   | Wrote the gate, **did not test the gate**                   |
| R8  | 3.2   | Tested the gate **with mutations written against the gate** |

R6: 75 NEW, **7 Critical**. R7: 73 NEW, **11 Critical**. R8: ~72 NEW, **11 Critical**.

R8's suite scored 10/10; an outside suite scored **6 of 22**. Both numbers are
real, and the gap is the whole lesson: every mutation R8 wrote targeted a check
R8 had already written, so the suite measured coverage of the implementation
rather than of the claims. R8 also _reported a regression it never ran_ — widening
the precedence schema made the revision-7 fixture unparseable, and because the
harness tested an exit code, a `ValueError` read as a catch. The cited "13
findings, all four criticals" could not have been produced by that code.

**R9's rule: a mutation names the sentence it breaks, and every gate asserts a
count.** Nothing in the spec now declares a phase, a liveness, a reachability or a
render order — the graph derives all four, so the four author-supplied fields that
let reviewers re-arm prior criticals with two-line edits no longer exist.

Falsified premises worth not re-inventing:

| Believed                                             | Actually                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| Per-thread MCP toolkit scoping                       | One global tool array                                          |
| `bootstrap` reusable                                 | Private closure; decider rejects it                            |
| **A wake primitive: none**                           | **One exists; only _coalescing_ is missing**                   |
| `starting` redundant given the sentinel              | Session relaunch has no sentinel                               |
| `git worktree prune` is per-worktree                 | Repo-global, unrecoverable                                     |
| `git branch -d` means merged-to-default              | Checks HEAD or upstream                                        |
| A capability gate is ~2 lines                        | Circular; unbootable                                           |
| Log names feed `topSpansByCount`                     | It counts spans, truncated at 10                               |
| `du` measures reclaimable disk                       | Overstates node_modules ~60×, understates a checkout 24%       |
| `readRangeContext` answers "has commits"             | Free-text blobs for PR-body generation                         |
| A force-kill is callable                             | Needs `startTimeMs`; never fails; descendants only             |
| `messageId` identifies a turn                        | Separate brands                                                |
| **`OrchestrationLatestTurn` has no message linkage** | **`assistantMessageId` exists; no _initiating-user_ link**     |
| **`routed.isActive` is observable**                  | **`stopSession` returns `void`**                               |
| **Terminal ⇒ free the cap slot**                     | **Only a confirmed-dead process frees it**                     |
| Two threat actors                                    | One actor, two channels                                        |
| **A written gate is enforcement**                    | **5 of 6 and 11 of 12 seeded defects passed it**               |
| **Rule 0.5 makes `derive()` total**                  | **It made it constant — six renderings unreachable**           |
| **Terminal states have a dead process**              | **`crew_report` left the session running**                     |
| **"Confirmed dead" is observable**                   | **Nothing observed it; now defined via `listSessions()`**      |
| **`attempts` counts failed wakes**                   | **It counted sweep ticks — punishing slow turns**              |
| **`Discard`/`Halt` were specified**                  | **Prose only; neither owned an edge**                          |
| **§12's gate runs in CI**                            | **Zero hits repo-wide until R8 wired it**                      |
| **Four sections are generated**                      | **No generator existed for three revisions**                   |
| **The ws.ts port is ~100 lines**                     | **214 (`ws.ts:862-1075`), one call site — wrong 3× before**    |
| **A mutation suite proves a gate**                   | **Only if the mutations come from the claims, not the code**   |
| **`stopsProcess` derives liveness**                  | **It relocated the assertion from state to edge**              |
| **A regression fixture proves history**              | **A schema change made it crash, and a crash read as a catch** |
| **`crew_report` should stop the session**            | **It kills the crewmate with its own tool call**               |
| **Absence from `listSessions()` ⇒ dead**             | **Absence precedes death on every ordinary stop**              |
| **Purge compares against the default ref**           | **`origin/HEAD` is `main`; work lands on `personal`**          |

**The rule:** verify by executing; run every fix through the gate that checks the
sections consuming what it changed; and **mutation-test the gate itself**, because an
ungated gate is the most expensive kind of comment — it buys the confidence of
enforcement at the price of the attention that would have caught the defect.

## Round 11 — 2026-09-01, six reviewers, rebased onto `01c68bb03`

Ten rounds were reviewed by reading. Round 11 dispatched six reviewers who were
told to **build it and run it**, against a tree 496 commits newer than the one
revision 10 cited. It produced ~70 findings and a rewrite.

**Lesson 4 — a design's evidence expires, and two of its claims never held.**
Roughly twenty `[V:]` line numbers had moved and two pointed at unrelated code.
Worse, two load-bearing claims were false the day they were written: _"two
sentinels can coexist, newest wins"_ (the only writer is delete-then-insert in
one transaction, identical at revision 10's own base commit) and _"the gate fails
any rule that absorbs `liveRendered`"_ (neither token appears in the gate). An
unexecuted premise does not decay — it can be born wrong and read true for four
revisions.

**Lesson 5 — the fix that changes a flag and leaves the condition is the same
defect.** R9 fixed the purge guard's _ref_ and left its _axis_. R10 fixed the
_flag_ (`--force`) and left _the condition that re-authorises it_: step 1
unlocked unconditionally, step 2's correct refusal left the tree unlocked, and
`git worktree unlock` returns 128 on an unlocked tree — so the next 60s sweep
read its own earlier refusal as the "failed unlock" that authorises `-f -f`, and
force-deleted the tree the guard had just protected. Reproduced end to end, no
operator, no crash. Three consecutive rounds put a destructive defect in the same
83 lines; revision 11 deletes the 83 lines.

**Lesson 6 — "the axis fix is deleting one word" was measurably false.** `git
worktree remove` without `--force` gates on `git status --porcelain`, which
excludes ignored paths, so on an otherwise-clean tree it returns rc=0 and deletes
`.env`, `dist/` and `node_modules/`. The design's claim that this "covers the
Bash-descendant case" was exactly inverted: a `--watch` build writes only to
ignored paths.

**Lesson 7 — a cut must be walked through every section, same as a fix.** Round
10 cut four phases and a state, in §4 only. Nine edges in §8 still fired into
`halted`/`landing`/`landed`, and §10 shipped a **Phase-1 UI button** pointing at a
deleted state. Lesson 2, one revision later, on the author's own scope cut.

**Lesson 8 — the gate scored 9/9 on its own suite and 1/12 and 3/10 on outside
ones.** Exactly the ratio R8 recorded and R10 declared fixed. It read §4's three
tables and nothing else, which is why the nine broken edges sat under a `PASS`.
Revision 11 deletes it and writes vitest tests the repo's own gate runs.

**What the round changed.** Revision 11 is a rewrite: 7 states → 3, 13
transitions → 4, 22 columns → 11, 4 env knobs → 1, and §7's retention/purge
subsystem deleted outright. The largest single win came from a primitive that
post-dates revision 10 — `appendSessionNote` delivers text into a live session
without starting a turn — which deletes the sentinel, the attribution predicate,
the clobber race and the `attempts` counter, and with them roughly a third of the
round's findings.

## Round 12 — 2026-09-01, six reviewers on revision 11

Revision 11 was written to fix round 11's ~70 findings. Round 12 found ~55 more
in it, nearly all in the three moves revision 11 made. Every one of the criticals
was a defect the rewrite _introduced_.

**Lesson 9 — a primitive's return value answers its own question, not yours.**
`appendSessionNote` returns `false` on binding/adapter/provider failure and
nothing else — no `archivedAt`, no session status. Revision 11 made that return
value the sole gate on whether to fall back to a wake turn, so an idle-but-live
bridge got `true`, the note sat unread, `deliveredAt` was stamped, and the panel
showed the report delivered. The function answers _"can I place text"_; the design
needed _"should this thread be woken"_. Measured: the fallback was unreachable in
**87.5%** of the states it existed for, and permanently unreachable after any
restart, because `BootTurnReconciler` rewrites every session to `stopped` at boot.
The in-repo precedent had this right and revision 11 inverted its ordering while
claiming to mirror it.

**Lesson 10 — the test you write from a wrong design asserts the defect.**
Revision 11's §11 specified _"a busy guard leaves `deliveredAt` NULL and
retries"_. That is the bug, written as an acceptance criterion. Its §12 acceptance
passed too, because a lab harness has a live `ready` session. Two gates, both
green, both blind — and the gate that would have caught it (the deleted Python
tool) was deleted for good reasons that remain good.

**Lesson 11 — deleting a subsystem does not delete its hazard if callers
survive.** Revision 11 removed retention and wrote _"crew never deletes
anything"_ while keeping two `git worktree remove` callers and one `git branch
-D`. `createWorktree` derives its path from a **sanitized** branch name, so
`feature/x` and `feature-x` are the same directory — and revision 11 wrote
`worktreePath` before knowing whether crew created it. A reviewer destroyed an
operator's worktree with `.env` and `node_modules` intact-then-gone: rc=0, no
`--force`, no crash. The rule revision 12 adopts is one sentence: **crew deletes
only what crew created in that same operation**, tracked by a flag, never
inferred from a path.

**Lesson 12 — "terminal" is a claim about the whole system, not your table.**
Revision 11 archived the crewmate thread to close it out. `thread.turn.start` is
the **one** lifecycle command with no archived guard — proven against the real
decider with a passing `thread.snooze` control — so an archived crewmate still
takes turns and `startSession` re-mints its credential. A `closed` row with a
live `bypassPermissions` agent and no slot held. The refusal that holds is a row
lookup, not a state.

**Lesson 13 — a sidecar has no sequence, and every choice breaks something.**
Reusing the shell stream means carrying `sequence`, which the client reads before
its switch and uses as a cursor. Omitting it fails to compile; a crew-local
counter below the domain head is dropped and above it poisons the cursor,
silently dropping real thread events and forcing a full snapshot on every
resubscribe. The answer is to carry the domain sequence for framing and forbid
the crew branch from advancing the cursor — which had to be said, not assumed.

**What round 12 confirmed as sound**, so it is not re-litigated: the `crewTasks`
client opt-in (4 decode arms, both directions); migration id 51 and the id-34
silent-skip trap; deleting `pendingMessageId`; `derive()`'s totality at 192/192;
both sidebar mounts and the `file:`-protocol reason for a plain-text renderer;
and that the round-11 self-arming force-delete is dead with nothing able to
re-arm it.

## Round 13 — the fixes are the defect source

**Lesson 14 — a predicate written twice drifts, and the second copy is the bug.**
Every critical in round 3 was one value stated in two sections. §5 selected on
`notedAt IS NULL` while step 2 set `notedAt`, so no deferred report ever
re-selected. §4 said `crewThreadId` is written at reservation and, fifteen lines
later, that it is nullable until spawn — and rendering rule 6 was written against
the second one, making the whole `runSetupProgram()` window unreachable. Neither
half was wrong in isolation. Revision 13's structural change is not a mechanism:
it is that §5 owns every delivery predicate, §4 owns the schema, §7 owns the
destruction rule, and nothing restates them.

**Lesson 15 — a return value that answers a different question is not a gate.**
`appendSessionNote` returns _"could I place text"_. Revision 11 made it the sole
gate on whether to wake, and the fallback became unreachable in 87.5% of states.
Revision 12 fixed the wake and then read the same value to decide `deliveredAt`,
attributing a read to a turn that had started before the note existed. The rule
that holds across both: the wake decision comes from the report's `state`, and
delivery is a **temporal** claim — `latestTurn.requestedAt > notedAt` and
`completedAt !== null` — never an echo of an I/O result.

**Lesson 16 — the transaction I warned about twice, I then wrote.** §1 recorded
the single DB permit and §4 recorded that `getShellSnapshot` runs inside
`sql.withTransaction`; §5 then spanned `appendSessionNote` — a subprocess call —
with a transaction opened around a projection read. Writing a hazard down does
not make you check your own text against it. Revision 13 splits it into a short
claim, provider I/O outside, and a short `changes() == 1` stamp.

**Lesson 17 — three of round 3's criticals were covered by a test I wrote that
passes on the defect.** "A busy bridge defers", "`derive()` is total", "a crew
frame leaves `snapshotSequence` unchanged" — each asserts something true of the
broken design. Totality passed with rule 6 dead; the cursor assertion is also
satisfied by a frame that was dropped. §11 now requires every test to ship with
an inverted fixture it has been seen to go red on, and to assert **reachability
and delivery**, not totality and invariance.

**Lesson 18 — a citation must name something a caller can reach.** Revision 12
justified branch-name collision handling with `resolveAvailableBranchName`, a
private closure with one internal caller and zero references on the driver's
returned shape. The control (`listLocalBranchNames`, present) is what turned a
plausible name into a measurement. `[V]` now requires an exported signature, and
crew simply uses `crew/<taskId>`, unique by construction.

**What round 13 carries forward unchanged:** the two-state model and the
three-timestamp table (**score withdrawn in round 14 as unreproducible — see design §4**);
the readdir gate replacing `git status --ignored`; teardown never latching; the
`nested` computation over rows of every status; and the four stated costs, now
including the bridge's context window.

## Round 14 — four mechanisms deleted, not fixed

Round 4 ran four build-and-run reviewers: correctness, simplicity,
falsifiability, integration. Four criticals and about fourteen majors. What makes
this round different from 11-13 is that its biggest findings were **deletions**,
and two reviewers reached the same ones from opposite directions — one asking
"is this the smallest model", the other asking "does this attach to the code".

**Lesson 19 — a guard whose refusal arm is the only reachable one is not a
guard.** Revision 13's destruction surface had six mechanisms: created-flags, a
`git config --worktree` identity stamp, a readdir gate, a symlink refusal, a
no-`--force` rule and a path assertion. Measured: the boot reap only ever sees
trees that have run `runSetupProgram()`, and the readdir gate refuses every one
of them (`OFFENDERS: ["node_modules"] → REFUSE` on the real worktree, with an
allow-arm control on a pre-setup tree). Dispatch compensation is live only in the
seconds before setup's first write, on a bare checkout worth nothing. And two of
the six could not be implemented at all: `git config --worktree` returns rc=128
on any repo with more than one working tree — which crew guarantees, by
construction — and the `git worktree list` probe compares a resolved path to a
stored one, false under any symlinked prefix. Section 7 had already written _"both
sites are inert on a repo whose setup installs dependencies"_ and did not notice
that this retired the mechanism introduced three paragraphs later. Revision 14
deletes the deletion.

**Lesson 20 — check for a shipped precedent before designing a transport.** The
shell-stream wire path was ~10× the surface of `useResourceQueue`, which this
fork already ships: a unary RPC on a visibility-gated poll, 60s idle / 5s open,
23 lines of client-runtime, two lines in `ws.ts`, and a generic factory a second
feature had already copied. It also did not work — three independent defects,
each reproduced. The reducer reorder revision 13 prescribed is **inert**, because
the guard that drops the frame is in `shell.ts`, before the reducer is called;
real clients always subscribe with `afterSequence`, whose branch sends no
snapshot, so nothing replays a sidecar's state on resubscribe; and the HTTP
snapshot route has no `payload` and no `urlParams`, so the "opt-in" had no
channel and mobile decodes that snapshot anyway. Lesson 13's entire hazard class —
"a sidecar has no sequence, and every choice breaks something" — existed only
because of the transport choice. Picking the precedent deletes the lesson.

**Lesson 21 — one column doing two jobs will have a case where the jobs
disagree.** `deliveredAt` was the sweep's "still needs work" predicate and the
panel's "the model has not read it" signal. On the design's own headline case — a
`progress` report noted on a live Claude bridge — nothing could ever stamp it, so
the row re-selected every 60s forever and the panel showed it permanently unread.
The correctness reviewer spent three findings making the stamp correct (its
`completedAt` conjunct marked 4 of 5 real turn outcomes as read; its `requestedAt`
conjunct compared a **client** clock to a server one; and its position in the
sequence was unstated, with the natural reading livelocking at a turn a minute
forever) and I added a `notedTurnId` column to fix it. The simplicity reviewer
then showed a two-column variant that ties on every case either of us could
construct. The fix and its column both went.

**Lesson 22 — the reviewer's mechanism can be right and their fix still wrong.**
The correctness reviewer's remedy for the client-clock defect was to compare
`latestTurn.startedAt` instead of `requestedAt`. Reading the projector, `startedAt`
is assigned `pendingTurnStart.requestedAt` whenever a pending row exists — the
same client value. Taking the fix on trust would have shipped the defect with a
citation attached.

**Lesson 23 — a number in a bracket is a claim, and this one was invented.** §4
carried `[X: 8/8 against §12's acceptance; the two-timestamp variants score 5/8
and 7/8]`. §12 has thirteen clauses; none names a timestamp; only three can be
decided by the timestamp choice; there are three ways to collapse three columns
to two and the note scored two, calling them "both". No artifact anywhere
produced the denominator. Withdrawn rather than restated.

**Lesson 24 — reading the diff myself found what no reviewer was pointed at.**
Cross-checking every value stated in two sections turned up the `stopped`
rendering critical (rule 5 named two of seven statuses, so the whole fleet
renders `unknown` after any restart) before the reviewers reported, and the UI's
worktree actions being unsafe on an open task. Two reviewers later found the
`stopped` defect independently, by different methods — which is the corroboration,
not the redundancy.

**What round 14 leaves standing:** the two-state machine; §5's step order with
the turn guard ahead of the append; the per-sweep woken set; teardown's
close-first, never-latch shape and its one ordering constraint; the notification
predicate being server-side; and §11's parameterised defect arms, which are the
only thing here that makes a test's own failure observable to the gate.

## Round 15 — six criticals, all in text written one round earlier

Four build-and-run reviewers again: correctness, deletion-damage, falsifiability,
integration. Round 4 returned four criticals; round 5 returned six. The rate is
flat, but the location moved: **every critical this round was in text revision 14
had just written**, and none was in the parts that survived from revision 12.

**Lesson 25 — deleting an inert mechanism can still break something, if it was
also doing a second job nobody wrote down.** `deliveredAt` was deleted because its
two jobs contradicted each other. One of those jobs turned out to be load-bearing:
`ProviderSessionReaper` stops an idle session after 30 minutes and its skip guards
cannot see a queued session note, so a `progress` note appended with no wake dies
with the session. Under revision 13 the panel showed that as unread; under 14 it
showed zero, because `notedAt` already read "handled". This was measured, not
argued: **133 reaper stops across 46 threads in 10 days** on the developer's own
machine. The fix is a boolean, not the timestamp back — no clock, no turn
identity, no second predicate.

**Lesson 26 — a conjunct added to a shared predicate acquires every caller.** The
per-sweep "already woken" conjunct was written to stop two crew reports racing for
one bridge. Revision 14 moved the turn guard ahead of the append, which put that
conjunct in front of the append too, so the second, third and fourth report of a
sweep were deferred _without being appended_: four `done` reports became four
turns over four minutes instead of one turn carrying all four. §11's "two reports
for one bridge in one sweep start one turn" is green on it.

**Lesson 27 — the file's own doc comment is the cheapest falsifier, and I did not
read it twice.** Two §1 rows were false, each contradicted by a comment in the
file it cited, one of them ten lines above the cited line. "MCP credentials are
refreshed only by a provider turn" — the module says _"refreshed both by MCP
traffic and by `touch`"_, and §5 had traded away the only expiry bound on a
`bypassPermissions` credential to solve a problem that does not exist.
"`stopSession` fails in three persisted cases" — two; the directory promotes a
null instance id as the row leaves persistence, and §11 had a test arm for a state
the system cannot produce.

**Lesson 28 — `Effect<A>` with `never` in the error channel does not mean it
cannot fail.** `listSessions` carries no error type and dies three ways, and a
defect is not rescued by an error-channel catch. One unguarded call inside a
60s loop stops the loop for the rest of the boot — every report undelivered,
silently, with §12's log-line clause already satisfied by the first tick. The
signature is what made this invisible on the page.

**Lesson 29 — a reviewer's mechanism can be right and its remedy wrong, twice
running.** Round 4's correctness reviewer proposed `startedAt` for the client-clock
defect; `startedAt` inherits the same client value. Round 5's reviewers disagreed
with each other about `stopSession`'s failure-mode count, and the answer was in a
third file neither had opened. Both were settled by reading the code, not by
counting reviewers.

**Lesson 30 — the review is approaching what paper can settle.** Several round-5
findings say so outright: _"filed as design-internal, not as a code claim"_,
_"I could not run this because §5 is unimplemented"_. The findings have shifted
from "this mechanism is wrong" to "this column is missing" and "this select needs
an ORDER BY". Recorded here so the decision to keep looping is a decision, not a
default.

## Round 16 — the additions were the defects, again

Round 6, four reviewers. Four criticals from correctness, four from
falsifiability, two from simplicity — and **every one of them was in text
revision 15 had written**. That is three consecutive rounds with the same
signature. Revision 16 responds the way revision 14 did: by deleting, not fixing.

**Lesson 31 — an `[X]` can rot, and this one had been load-bearing for three
revisions.** §5 justified a per-sweep "already woken" `Set` with "no projection
read can close this race, the projection has not moved within one sweep `[X]`".
The projection moves _inside the append transaction_:
`projectionPipeline.projectEvent` runs serially in the commit loop and
`thread.turn-start-requested` writes the pending row right there. So
`getPendingTurnStartByThreadId` — a conjunct crew's own guard already had — closes
the race, and the `Set` was redundant from the day it was written. Worse, revision
15's "fix" of moving that conjunct out of the append path was inert, because the
other three conjuncts block identically. A measurement recorded once and cited
thereafter is a claim with an expiry date.

**Lesson 32 — displaying a loss is not a substitute for preventing one, and the
prevention was one predicate away.** Four revisions of machinery — `deliveredAt`,
then `notedWithoutTurn`, then a companion turn id, then a sixth sweep step — all
existed to make a reaped `progress` note _visible_. None worked: turn identity
cannot distinguish "the bridge drained the queue" from "the session died and a new
session took a turn", so the final version reported a **false read** on the one
path it was built for. Meanwhile `ProviderSessionReaper` is a flat chain of four
`continue` guards on a thread shell it has already fetched, and it is **74% of all
session stops** (125 of 169 in ten days, 135 of 290 all-time, measured on the live
event log). One more `continue` fixes the loss instead of narrating it. The
residual — archive, settle, restart — becomes §2's fifth stated cost.

**Lesson 33 — "coalesce into one payload" is unbounded or lossy, never neither.**
With §5's 1 KiB note bound and §11's 40-byte prefix, one line is 1064 bytes, so a
coalesced payload drops every report past the first _and stamps them handled_.
Removing the bound puts 0.81 MiB — 213k tokens, the whole overnight budget — in a
single prompt. The shape already in the document was the answer: a bare nudge
naming the `reportId`s, with `crew_status` to read them.

**Lesson 34 — a second call site for a loop is a second place to get it wrong.**
Teardown's drain step was added so a report filed just before close still lands.
It was inert on the modal path (a bridge calling `crew_teardown` is inside its own
turn, so every non-`progress` report deferred), it never covered a task closed by
the boot reap, and after §5's steps were renumbered it delivered without stamping.
Deleting one conjunct from §5's select — `task.status = 'open'` — does the whole
job, covers the reap case for free, and costs an index seek the query already
follows with a sort.

**Lesson 35 — the same argument applies to answers.** A separate `answerText`
column and a second select produced a critical of its own: no terminal state, so a
torn-down crewmate left the row matching 60 times an hour forever. An answer is a
report row travelling the other way — `state = 'answer'`, `replyTo` — and takes
the existing select, loop and closing rules unchanged.

**Lesson 36 — the document is now 32% §1 table and ~113 lines of "revision N was
wrong" prose, which is a second copy of this log.** Recorded here as the next
thing to cut; the facts belong in one place and this is that place.

**What round 6 confirmed sound:** §5's `ORDER BY (state='progress'), createdAt`
against real SQL; the payload-channel rule (text on exactly one channel across
{Claude, non-Claude} × {ready, stopped} × {progress, non-progress}); and the
inverted teardown step-2 clause, which is the one §11 clause a reviewer set out to
break and could not.
