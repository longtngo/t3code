# Folder paths written in prose become chips — 2026-08-31

## Goal

A folder path a model simply _writes_ in a chat message — `/Users/me/reports/runbooks`,
`~/.claude-personal/skills` — should be clickable and open that folder's listing, the same as it
already does when the same path is written inside backticks or as a markdown link.

This is the follow-up the 2026-08-26 directory-chip design recorded verbatim: _"Prose mentions of
bare directory names do not chip at all."_

Non-goal: relative folder names (`src/components`, `docs/`). Explained under Bounds.

## Baseline @ 881e95e5d (2026-08-31)

Measured with a throwaway probe in `apps/web` over the real pure functions (deleted after the run),
and reproduced independently by two reviewers against copied repo sources:

```
prose  findChatFilePathMentions("see /Users/longngo/.claude-personal/skills here")   -> 0 mentions
prose  findChatFilePathMentions("see /Users/longngo/.claude-personal/skills/ here")  -> 0 mentions
prose  findChatFilePathMentions("see ~/.claude-personal/skills here")                -> 0 mentions

inline code   resolveInlineCodeFileLinkMeta("/Users/longngo/.claude-personal/skills") -> chips
markdown link resolveMarkdownFileLinkTarget("/Users/longngo/.claude-personal/skills") -> chips

classifyFileViewerKind("/Users/longngo/.claude-personal/skills")                     -> null

regression floor: pnpm verify @ 881e95e5d -> exit 0, 14 suite blocks,
  11,234 passed / 20 skipped / 0 failed
```

So the surface is exactly one gate wide: prose is the only one of the three writings that drops
folders. Confirmed by running the scanner in isolation — `extractTerminalLinks` **does** emit the
token (`[["path","/Users/longngo/.claude-personal/skills"]]`); `chatFilePathLinks.ts:152` drops it.
The fix is therefore not inert.

## Mechanism (source-pinned)

`resolveChatFilePathMention` (`apps/web/src/chatFilePathLinks.ts:145`) rejects any path the curated
extension allow-list does not recognise:

```ts
if (classifyFileViewerKind(path) === null) return null;
```

A folder has no extension, so `classifyFileViewerKind` answers `null` and the path stays plain text.
The gate is not a mistake — it is what stops prose tokens like `example.com` and `v1.2` becoming
chips, and the comment above it says so. The task is to widen it without paying that cost back.

Note what is **not** broken: once a folder does get a chip, it already opens from any location.
`filesystem.browse` resolves an absolute path directly with no root allow-list
(`WorkspaceEntries.ts:159-161`), and both viewer surfaces already fall back to a directory listing
when the file read fails (`TrustedFileView.tsx:130-141`, `FilePreviewPanel.tsx:841-852`). This
design adds no listing capability; it only makes the chip appear.

## Approach

**Widen the prose gate by exactly the shapes that cannot be prose: an absolute path under a known
filesystem root, a Windows drive path, and a `~/` path.**

```
admit when  classifyFileViewerKind(path) !== null          (today's rule, unchanged)
        or  path starts with a POSIX_FILE_ROOT_PREFIXES entry
        or  path is a Windows drive path (C:\… / C:/…)
        or  path starts with "~/"
```

`POSIX_FILE_ROOT_PREFIXES` already exists in `markdown-links.ts:20-43` and already deliberately
excludes app-route-ish prefixes (`/app/`, `/chat/`) so SPA routes never read as files. Reusing it
means prose and markdown links stop disagreeing about what a path is, which is the actual defect
the user hit — the same folder chipped in backticks and not in prose. Verified by running both
arms: `/chat/thread-123`, `/api/v1.2` and `origin/main` all stay unchipped after the widening.

One correction applied after measurement over the real corpus:

- **The UNC clause is dropped.** `path.startsWith("\\\\")` was inherited from `isLikelyPathCandidate`,
  where an author wrote an explicit markdown link. In prose it fires on ordinary escaped text —
  `\\.e2e\\.spec\\.ts$`, `\\n` — for **4 measured post-parse false positives and 0 true positives**.
  The "shapes that cannot be prose" claim was measurably false for this one clause. Markdown itself
  collapses `\\`→`\` before the plugin runs, so a correctly-written UNC path could never have
  reached the clause anyway; an extension-bearing UNC path still chips via the unchanged extension
  branch. The drive-letter half is kept — see Bounds for what the corpus can and cannot say about it.

`~/` earns its own clause because it is not absolute by `isAbsoluteFilePath`, and it is the exact
spelling the reported case used. The claim "no English prose contains `~/`" looked like the weakest
in the design and turned out to be the best supported: **zero** English-prose false positives across
the corpus, all 182 hits real paths.

### A trailing `*` / `_` trim was designed, measured, and cut

An earlier draft added one, on the theory that bolding a path (`**~/reports/x.md**`) leaves the
`**` glued to the target. **That was measured wrong and the trim is deleted.** The markdown parser
consumes `**` into `<strong>` before the rehype plugin ever sees a text node, so there is nothing
to trim:

```
MD    The report is at **~/reports/2026-08-31-design.md** now.
HTML  …<strong><a href="/Users/longngo/reports/2026-08-31-design.md">~/reports/2026-08-31-design.md</a></strong>…
```

Corpus-wide the trim changed **nothing** (4,367 mentions with and without; zero differing rows), and
tokens ending in `*` or `_` among admitted mentions are **0** post-parse. The `_` half is worse than
useless: markdown already consumes `_`-delimited emphasis, so any trailing `_` reaching a text node
is a literal filename character, and trimming it would manufacture a target guaranteed not to
exist — the exact failure the trim was meant to prevent.

The "12 hits" that motivated it were counted on **raw text with markdown syntax stripped by regex**,
which is not the same as running the parser. Recorded here because the same shortcut will
mis-measure any future change to this gate.

## Measured effect

Real `findChatFilePathMentions` vs the widened gate over the full message corpus from a read-only
`VACUUM INTO` snapshot of `~/.t3/userdata/state.sqlite`. The authoritative numbers are the
**post-parse** ones — a real `remark-parse → remark-gfm → remark-rehype` pass, walking text nodes
with the plugin's own `SKIPPED_TAGS`, which is what actually runs in the app:

```
messages scanned  : 82,872
baseline mentions : 1,388
widened mentions  : 4,367   (+2,979)

new mentions by root: /private/ 2159   /Users/ 441   /tmp/ 221
```

An earlier pre-parse pass (regex-stripped syntax rather than a real parse) gave 1,322 / 4,331 /
+3,009 and a per-class breakdown; its shape held but its emphasis-related counts did not survive
parsing. Class proportions from that pass, kept because the classes are real even where the counts
shifted:

```
87.3%  legitimate absolute path        <- the goal
 6.0%  legitimate ~/ path              <- the goal
 5.6%  device node / executable        <- chips, opens an error
 0.6%  \\ UNC clause                   <- dropped by this design
 0.1%  secrets path (.env, .ssh, .secrets)
```

Cost is free within noise — the widened gate is a cheap early return that fires _later_, not more
work:

```
BASE  median=499.9ms  perMessage=6.04us     p95=1  p99=3  max=323 chips
WIDE  median=480.4ms  perMessage=5.80us     p95=1  p99=4  max=328 chips
streaming re-scan, longest message (41,258 chars), 1032 deltas:
  BASE 0.19ms/delta   WIDE 0.19ms/delta
```

## Alternatives rejected

- **Admit any path-shaped token with a separator.** What the existing comment says was tried and
  rejected. It chips `origin/main`, `and/or`, `feat/x`, `example.com`.
- **Reuse `isLikelyPathCandidate` from `markdown-links` wholesale.** Tempting, since it is the
  markdown-link gate. Rejected on measurement: its non-absolute branch admits
  `RELATIVE_FILE_PATH_PATTERN`, verified to match `origin/main`, `and/or`, `feat/x` and
  `src/components`. An explicit markdown link is an author stating intent; prose is not, so the two
  need different budgets on the _relative_ branch. Sharing is scoped to the absolute branch.
- **Admit any absolute path, including outside the known roots.** Rejected: that re-admits
  `/api/v1.2` and `/chat/thread.new`, exactly what the root allow-list exists to keep out.
- **Route on `inferEntryKindFromPath`** to decide "this is a folder" up front. Rejected for the same
  reason the 2026-08-26 design rejected it: it calls `Makefile`, `LICENSE` and `.env` directories.
  The gate here is "is this a filesystem path", never "is this a folder" — the read failure answers
  that server-side, as it already does.
- **Trailing-slash relative paths** (`src/components/`). A trailing slash is good evidence, but the
  path still resolves against the thread `cwd`, and a wrong `cwd` produces a chip that opens an
  error. Deferred.
- **Dropping `/dev/`, `/proc/`, `/sys/` from the prose branch.** Considered for the 5.6% class
  below. Rejected as premature: it forks the prefix list into two budgets to remove chips that fail
  visibly and harmlessly, and `/dev/null` is by far the bulk of it. Revisit if the noise is felt.

## Bounds and tradeoffs

- **5.6% of new chips cannot open.** Device nodes and executables now chip and then show an error:
  `/dev/null` alone is 140 occurrences (it is the idiom `2>/dev/null`, not a file anyone wants),
  plus `/bin/sh`, `.venv/bin/python`, `~/bin/t3-rebuild`. Each click costs a failed text read plus a
  `browse` that returns ENOTDIR, then an error notice. Stated rather than hidden: this is the price
  of a shape-based gate that never stats.
- **Many new chips point at paths that no longer exist.** Measured on current disk state, 73.9% of
  new mentions are missing — but the bulk are `/private/tmp/claude-*/…/tasks/*.output`, agent
  scratch that existed when the message was written. A chip that worked then and 404s in scrollback
  later is the same staleness today's `.md` report chips already have; it is not a new class.
- **The widening re-admits dotfiles the extension list deliberately excluded.** `TEXT_FILE_EXTENSIONS`
  documents excluding `.env` and extension-less files partly for "secrets"; the `~/` and known-root
  clauses put `~/.secrets`, `~/.ssh/id_rsa` and `.env` back (3 measured hits). This exposes nothing
  new — the trusted read has no sandbox and the address bar already accepts any path — but the
  reused gate's stated purpose is being widened past, so it is recorded here rather than left silent.
- **`~/` chips can carry a literal unexpanded `~`.** When `cwd` yields no inferable home
  (`inferHomeFromCwd` returns `undefined`, e.g. `cwd=/opt/project`), the target stays `~/…`.
  Pre-existing, but newly frequent now that `~/` chips go from rare to 182.
- **The "one failed read is bounded" claim is withdrawn.** The 1 MiB read cap, the 2-permit listing
  semaphore and the 10,000-entry cap are all real, but none of them bounds a blocking `open()`:
  `readFile` opens before its `stat().isFile()` check, and a FIFO hangs (measured: >6s, event loop
  blocked). The widened roots include `/tmp/`, `/var/`, `/run/`. This is **pre-existing and not
  introduced** — every such path already chips today via inline code and markdown links, verified —
  and it is already a recorded follow-up. It is simply not true that the click cost is bounded.
- **Markdown can split a path before the plugin sees it, and the widening then chips the fragment.**
  Two measured classes, both new:

  ```
  "Search ~/src/uni/**/*warehouse* for it."   -> chips  /Users/longngo/src/uni/**   (basename "**")
  "Open /Users/longngo/reports/__init__ now." -> chips  /Users/longngo/reports/     (the PARENT dir)
  ```

  The first is a glob, not a path. The second is worse in kind: `__init__` is eaten as `<strong>`,
  so the chip silently points at a _different, existing_ directory rather than failing visibly.
  Extension-bearing spellings (`…/pkg/__init__.py`) survive intact and are unaffected. Accepted as
  rare; recorded because the second one cannot be spotted from the rendered chip.

- **The Windows drive clause is unvalidated by this corpus.** It scores 1 false positive (`s:\s+(.*)$`,
  from a regex in prose) and 0 true positives here — the same shape of evidence used to drop the UNC
  clause. It is kept anyway because the corpus is a single macOS user, so 0 true positives is the
  expected reading either way; the honest statement is "untested", not "safe".

- **Relative folder names never chip.** Stated limitation, not an oversight.
- **A path that does not exist still errors.** This design makes folders reachable; it does not make
  a missing path open. (The originally reported path, `~/.claude-personal/subagent-backend`, is a
  design-doc path that was never created — the shipped state file is
  `~/.local/state/subagent-dispatch/backend.json`. That error was truthful.)
- **Same gate as the video design, and they compose — with one collision.** Both widen
  `classifyFileViewerKind(path) === null` in `resolveChatFilePathMention`, but in different files
  and functions, so they do not textually conflict. Measured: `diff(widened, widened+video)` is
  empty, i.e. once this design lands the video change adds **0** further prose chips (standalone it
  adds exactly 1 — the reported `…-download-center-demo.mp4`). The real collision is a test:
  `chatFilePathLinks.test.ts:88` (`clip.mp4`) goes red under _either_ design independently, so
  whichever lands second must expect that line already rewritten.

## Files touched

- `apps/web/src/markdown-links.ts` — export the known-root predicate
- `apps/web/src/chatFilePathLinks.ts` — the widened gate
- `apps/web/src/chatFilePathLinks.test.ts` — **three existing assertions invert.** `it("only links
file kinds the viewer can render")` currently asserts `/etc/hosts` (`:82`), `.env` (`:86`) and
  `clip.mp4` (`:88`) all resolve to `null`. The first two flip under this design, the third under
  the video design, and the test's stated contract is the one being replaced. It is rewritten to
  express the new contract, not deleted.

`terminal-links.ts` is deliberately **not** touched. Its `trimClosingDelimiters` also feeds terminal
hyperlink detection, a different blast radius — and per the cut trim above, there is nothing there
worth changing anyway.

- `apps/web/src/chatFilePathLinks.test.ts` — the four measured false-positive classes as tests:
  `\\n` escapes, `**bolded/path**`, `/dev/null`, and a `PATH`-style `a:b:c` value; plus the
  positive cases for each admitted clause

## Review exit note

6a pillar sweep: **CONDITIONAL GO**, all four must-fixes applied. 6b round 1: Correctness+Simplicity
and Security+Performance, both **CONDITIONAL GO**. Round 2 re-ran Correctness only, over the two
dimensions round 1 had changed (the new trim, the dropped UNC clause); Security and Performance did
not re-run because neither dimension was edited — the perf finding was "no objection, measured free"
and the security finding was "no new capability", and nothing in round 2's edits touches either.

Round 2 **falsified the round-1 fix**: the trailing `*`/`_` trim was a measured no-op, because
round 1's corpus scan stripped markdown with regex instead of parsing it. The trim is deleted, and
the mis-measurement is recorded in the Approach section so the next change to this gate does not
repeat it. Round 2 also found two genuinely new false-positive classes (`**` globs, `__init__`
segments) now in Bounds, and the `chatFilePathLinks.test.ts` collision with the video design.

Exiting the loop: the remaining unreviewed surface is a two-file boolean widening whose entire
measured effect has been enumerated on the real corpus twice, post-parse the second time.

## Follow-ups deferred

- Relative and trailing-slash folder names in prose.
- FIFO `open()` hangs the RPC and can wedge the libuv pool (pre-existing, reachable today).
- Mobile prose chips: mobile has its own markdown link resolver
  (`apps/mobile/modules/t3-markdown-text/src/markdownLinks.ts`) and no absolute-path viewer, so a
  folder chip there would have nothing to open. Unchanged by this design.
