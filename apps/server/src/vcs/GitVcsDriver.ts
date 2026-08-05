import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  GitCommandError,
  VcsProcessExitError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type VcsInitInput,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type VcsStatusInput,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import { makeTransientGitRetryPolicy, resolveGitRetryAttempts } from "./gitRetry.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

/**
 * Untracked files whose on-disk size is >= this are excluded from checkpoint capture (and
 * symmetrically from restore's `git clean`), so `git add -A` cannot spend the whole process
 * timeout hashing+deflating heavy regenerable artifacts (e.g. `.npy`/`.npz` matrices, model
 * weights, caches). 10 MiB sits well above normal source/config/small assets and below data
 * artifacts. The bound is untracked-only: tracked files are always captured.
 */
export const MAX_UNTRACKED_CHECKPOINT_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Retry policy for the whole `captureCheckpoint` operation. Capture uses a throwaway temp
 * index and writes only content-addressed objects + a last-write-wins checkpoint ref, so it is
 * idempotent and safe to retry. A transient git failure (timeout / spawn starvation) is almost
 * always a passing host-overload episode (measured: 608 captures succeed per 1 timeout), so a
 * bounded jittered-backoff retry converts it into a delayed success instead of a lost checkpoint.
 * Whole-operation (not per-command) retry bounds latency on the serial checkpoint worker to
 * attempts × timeout and re-seeds a clean temp index each attempt. Read at module load.
 */
const captureRetryPolicy = makeTransientGitRetryPolicy(resolveGitRetryAttempts());

// gitignore metacharacters that must be escaped so a `git clean -e` pattern matches ONE path
// literally. This is load-bearing: an unescaped `[`/`*`/`?` makes the pattern miss the file, and
// `git clean -fd` then removes the file's (untracked) parent directory WHOLESALE — data loss.
const GITIGNORE_META = /[\\*?[\]]/g;

/**
 * Build a repo-root-anchored gitignore pattern matching exactly `relPath`, for `git clean -e`.
 * Restore uses `-e` (ignore machinery) rather than a `:(exclude)` pathspec because ignore-aware
 * `clean` descends into an otherwise-untracked directory to preserve the excluded file while
 * still cleaning its small siblings — a file-level pathspec exclude cannot (clean removes the
 * whole untracked dir as a unit).
 */
export function checkpointCleanExcludePattern(relPath: string): string {
  const escaped = relPath.replace(GITIGNORE_META, (ch) => `\\${ch}`);
  // gitignore strips a single trailing space unless it is escaped.
  const normalized = escaped.endsWith(" ") ? `${escaped.slice(0, -1)}\\ ` : escaped;
  return `/${normalized}`;
}

export interface ExecuteGitInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly appendTruncationMarker?: boolean;
  readonly progress?: ExecuteGitProgress;
}

export interface ExecuteGitResult {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface GitStatusDetails {
  isRepo: boolean;
  sourceControlProvider?: VcsStatusResult["sourceControlProvider"];
  hasOriginRemote: boolean;
  isDefaultBranch: boolean;
  branch: string | null;
  upstreamRef: string | null;
  hasWorkingTreeChanges: boolean;
  workingTree: VcsStatusResult["workingTree"];
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  aheadOfDefaultCount: number;
}

export interface GitRemoteStatusDetails {
  isRepo: boolean;
  isDefaultBranch: boolean;
  branch: string | null;
  upstreamRef: string | null;
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  aheadOfDefaultCount: number;
}

export interface GitPreparedCommitContext {
  stagedSummary: string;
  stagedPatch: string;
}

export interface ExecuteGitProgress {
  readonly onStdoutLine?: (line: string) => Effect.Effect<void, never>;
  readonly onStderrLine?: (line: string) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface GitCommitProgress {
  readonly onOutputLine?: (input: {
    stream: "stdout" | "stderr";
    text: string;
  }) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface GitCommitOptions {
  readonly timeoutMs?: number;
  readonly progress?: GitCommitProgress;
}

export interface GitPushResult {
  status: "pushed" | "skipped_up_to_date";
  branch: string;
  upstreamBranch?: string | undefined;
  setUpstream?: boolean | undefined;
}

export interface GitRangeContext {
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
}

export interface GitRenameBranchInput {
  cwd: string;
  oldBranch: string;
  newBranch: string;
}

export interface GitRenameBranchResult {
  branch: string;
}

export interface GitFetchPullRequestBranchInput {
  cwd: string;
  prNumber: number;
  branch: string;
}

export interface GitEnsureRemoteInput {
  cwd: string;
  preferredName: string;
  url: string;
}

export interface GitFetchRemoteBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
  localBranch: string;
}

export interface GitFetchRemoteTrackingBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitFetchRemoteInput {
  cwd: string;
  remoteName: string;
}

export interface GitResolveRemoteTrackingCommitInput {
  cwd: string;
  refName: string;
  fallbackRemoteName: string;
}

export interface GitResolveRemoteTrackingCommitResult {
  commitSha: string;
  remoteRefName: string;
}

export interface GitSetBranchUpstreamInput {
  cwd: string;
  branch: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitRemoteStatusOptions {
  readonly refreshUpstream?: boolean;
}

export class GitVcsDriver extends Context.Service<
  GitVcsDriver,
  {
    readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;
    readonly status: (input: VcsStatusInput) => Effect.Effect<VcsStatusResult, GitCommandError>;
    readonly statusDetails: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
    readonly statusDetailsLocal: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
    readonly statusDetailsRemote: (
      cwd: string,
      options?: GitRemoteStatusOptions,
    ) => Effect.Effect<GitRemoteStatusDetails, GitCommandError>;
    readonly prepareCommitContext: (
      cwd: string,
      filePaths?: readonly string[],
    ) => Effect.Effect<GitPreparedCommitContext | null, GitCommandError>;
    readonly commit: (
      cwd: string,
      subject: string,
      body: string,
      options?: GitCommitOptions,
    ) => Effect.Effect<{ commitSha: string }, GitCommandError>;
    readonly pushCurrentBranch: (
      cwd: string,
      fallbackBranch: string | null,
      options?: { readonly remoteName?: string | null },
    ) => Effect.Effect<GitPushResult, GitCommandError>;
    readonly readRangeContext: (
      cwd: string,
      baseRef: string,
    ) => Effect.Effect<GitRangeContext, GitCommandError>;
    readonly getReviewDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, GitCommandError>;
    readonly readConfigValue: (
      cwd: string,
      key: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    /**
     * Whether any file git already tracks differs from HEAD. Deliberately
     * excludes untracked files, which say nothing about whether anything wrote
     * to this repository.
     */
    readonly hasTrackedChanges: (cwd: string) => Effect.Effect<boolean, GitCommandError>;
    /** The commit HEAD points at, or null when the repository has no commits. */
    readonly readHeadSha: (cwd: string) => Effect.Effect<string | null, GitCommandError>;
    readonly writeConfigValue: (
      cwd: string,
      key: string,
      value: string,
    ) => Effect.Effect<void, GitCommandError>;
    /**
     * A branch's raw reflog, empty when it has none. The reflog is local-only
     * and expires under `gc.reflogExpire`, so absence is ordinary rather than
     * an error.
     */
    readonly readBranchReflog: (
      cwd: string,
      branch: string,
    ) => Effect.Effect<string, GitCommandError>;
    /**
     * Deletes a local branch, refusing when it holds commits that are not
     * merged elsewhere. Used only to undo a branch this just created at HEAD,
     * where nothing can be lost.
     */
    readonly deleteRef: (cwd: string, refName: string) => Effect.Effect<void, GitCommandError>;
    /** Branch names, local and remote-tracking, whose tip is this commit. */
    readonly listBranchNamesPointingAt: (
      cwd: string,
      commit: string,
    ) => Effect.Effect<ReadonlyArray<string>, GitCommandError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly fetchPullRequestBranch: (
      input: GitFetchPullRequestBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly ensureRemote: (input: GitEnsureRemoteInput) => Effect.Effect<string, GitCommandError>;
    readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string, GitCommandError>;
    readonly fetchRemote: (input: GitFetchRemoteInput) => Effect.Effect<void, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (
      input: GitResolveRemoteTrackingCommitInput,
    ) => Effect.Effect<GitResolveRemoteTrackingCommitResult, GitCommandError>;
    readonly fetchRemoteBranch: (
      input: GitFetchRemoteBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly fetchRemoteTrackingBranch: (
      input: GitFetchRemoteTrackingBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly setBranchUpstream: (
      input: GitSetBranchUpstreamInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly renameBranch: (
      input: GitRenameBranchInput,
    ) => Effect.Effect<GitRenameBranchResult, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly initRepo: (input: VcsInitInput) => Effect.Effect<void, GitCommandError>;
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
  }
>()("t3/vcs/GitVcsDriver") {}

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;
const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;

const nowFreshness = Effect.fn("GitVcsDriver.nowFreshness")(function* () {
  const now = yield* DateTime.now;
  return {
    source: "live-local" as const,
    observedAt: now,
    expiresAt: Option.none(),
  };
});

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (parts.length === 0) return [];

  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }

  return parts.filter((value) => value.length > 0);
}

function chunkPathsForGitCheckIgnore(relativePaths: ReadonlyArray<string>): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (chunk.length > 0 && chunkBytes + relativePathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}

function parseGitRemoteVerboseOutput(
  output: string,
): Map<string, { url?: string; pushUrl?: string }> {
  const remotes = new Map<string, { url?: string; pushUrl?: string }>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const name = match[1];
    const url = match[2];
    const direction = match[3];
    if (!name || !url || !direction) {
      continue;
    }
    const remote = remotes.get(name) ?? {};
    if (direction === "fetch") {
      remote.url = url;
    } else {
      remote.pushUrl = url;
    }
    remotes.set(name, remote);
  }
  return remotes;
}

const gitCommand = (
  process: VcsProcess.VcsProcess["Service"],
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly stdin?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly allowNonZeroExit?: boolean;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly appendTruncationMarker?: boolean;
  },
) =>
  process.run({
    operation,
    command: "git",
    args: ["-C", cwd, ...args],
    cwd,
    spawnCwd: globalThis.process.cwd(),
    ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options?.env !== undefined ? { env: options.env } : {}),
    ...(options?.allowNonZeroExit !== undefined
      ? { allowNonZeroExit: options.allowNonZeroExit }
      : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options?.appendTruncationMarker !== undefined
      ? { appendTruncationMarker: options.appendTruncationMarker }
      : {}),
  });

export const makeVcsDriverShape = Effect.fn("makeGitVcsDriverShape")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const capabilities = {
    kind: "git" as const,
    supportsWorktrees: true,
    supportsBookmarks: false,
    supportsAtomicSnapshot: false,
    supportsPushDefaultRemote: true,
    ignoreClassifier: "native" as const,
  };

  const isInsideWorkTree: VcsDriver.VcsDriver["Service"]["isInsideWorkTree"] = (cwd) =>
    gitCommand(
      vcsProcess,
      "GitVcsDriver.isInsideWorkTree",
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0 && result.stdout.trim() === "true"));

  const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) =>
    gitCommand(vcsProcess, input.operation, input.cwd, input.args, {
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      ...(input.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: input.appendTruncationMarker }
        : {}),
    });

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "detectRepository",
  )(function* (cwd) {
    if (!(yield* isInsideWorkTree(cwd))) {
      return null;
    }

    const root = yield* gitCommand(vcsProcess, "GitVcsDriver.detectRepository.root", cwd, [
      "rev-parse",
      "--show-toplevel",
    ]);
    const gitCommonDir = yield* gitCommand(
      vcsProcess,
      "GitVcsDriver.detectRepository.commonDir",
      cwd,
      ["rev-parse", "--git-common-dir"],
    ).pipe(Effect.orElseSucceed(() => null));

    return {
      kind: "git" as const,
      rootPath: root.stdout.trim(),
      metadataPath: gitCommonDir?.stdout.trim() || null,
      freshness: yield* nowFreshness(),
    };
  });

  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = (cwd) =>
    gitCommand(
      vcsProcess,
      "GitVcsDriver.listWorkspaceFiles",
      cwd,
      [
        ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      {
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    ).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.gen(function* () {
              const freshness = yield* nowFreshness();
              return {
                paths: splitNullSeparatedPaths(result.stdout, result.stdoutTruncated),
                truncated: result.stdoutTruncated,
                freshness,
              };
            })
          : Effect.fail(
              new VcsProcessExitError({
                operation: "GitVcsDriver.listWorkspaceFiles",
                command: "git ls-files",
                cwd,
                exitCode: result.exitCode,
                detail: result.stderr.trim() || "git ls-files failed",
              }),
            ),
      ),
    );

  const listRemotes: VcsDriver.VcsDriver["Service"]["listRemotes"] = Effect.fn("listRemotes")(
    function* (cwd) {
      const result = yield* gitCommand(
        vcsProcess,
        "GitVcsDriver.listRemotes",
        cwd,
        ["remote", "-v"],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 64 * 1024,
        },
      );

      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.listRemotes",
          command: "git remote -v",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git remote -v failed",
        });
      }

      const parsed = parseGitRemoteVerboseOutput(result.stdout);
      const remotes = Array.from(parsed.entries()).flatMap(([name, remote]) => {
        if (!remote.url) {
          return [];
        }
        return [
          {
            name,
            url: remote.url,
            pushUrl: remote.pushUrl ? Option.some(remote.pushUrl) : Option.none(),
            isPrimary: name === "origin",
          },
        ];
      });

      return {
        remotes,
        freshness: yield* nowFreshness(),
      };
    },
  );

  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = Effect.fn(
    "filterIgnoredPaths",
  )(function* (cwd, relativePaths) {
    if (relativePaths.length === 0) {
      return relativePaths;
    }

    const ignoredPaths = new Set<string>();
    const chunks = chunkPathsForGitCheckIgnore(relativePaths);

    for (const chunk of chunks) {
      const result = yield* gitCommand(
        vcsProcess,
        "GitVcsDriver.filterIgnoredPaths",
        cwd,
        [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "check-ignore", "--no-index", "-z", "--stdin"],
        {
          stdin: `${chunk.join("\0")}\0`,
          allowNonZeroExit: true,
          timeoutMs: 20_000,
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      );

      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.filterIgnoredPaths",
          command: "git check-ignore",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git check-ignore failed",
        });
      }

      for (const ignoredPath of splitNullSeparatedPaths(result.stdout, result.stdoutTruncated)) {
        ignoredPaths.add(ignoredPath);
      }
    }

    if (ignoredPaths.size === 0) {
      return relativePaths;
    }

    return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
  });

  const initRepository: VcsDriver.VcsDriver["Service"]["initRepository"] = (input) =>
    gitCommand(vcsProcess, "GitVcsDriver.initRepository", input.cwd, ["init"], {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    }).pipe(Effect.asVoid);

  const resolveHeadCommit = (cwd: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
    );

  const hasHeadCommit = (cwd: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.hasHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "HEAD"],
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.exitCode === 0));

  const resolveCheckpointCommit = (cwd: string, checkpointRef: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveCheckpointCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
    );

  const resolveGitCommonDir = (cwd: string) =>
    Effect.gen(function* () {
      const result = yield* execute({
        operation: "GitVcsDriver.checkpoints.resolveGitCommonDir",
        cwd,
        args: ["rev-parse", "--git-common-dir"],
      });
      const gitCommonDir = result.stdout.trim();
      return path.isAbsolute(gitCommonDir) ? gitCommonDir : path.resolve(cwd, gitCommonDir);
    });

  // The worktree-correct path to the real index. NOT `<gitCommonDir>/index`: a linked
  // worktree has its own index under `.git/worktrees/<name>/`, while the common dir's
  // index belongs to the main worktree.
  const resolveGitIndexPath = (cwd: string) =>
    Effect.gen(function* () {
      const result = yield* execute({
        operation: "GitVcsDriver.checkpoints.resolveGitIndexPath",
        cwd,
        args: ["rev-parse", "--git-path", "index"],
      });
      const indexPath = result.stdout.trim();
      return path.isAbsolute(indexPath) ? indexPath : path.resolve(cwd, indexPath);
    });

  // `git add -A` honours the skip-worktree / assume-unchanged index bits — it skips
  // those paths. Seeding the checkpoint index from a real index that carries them
  // would freeze those files at their stale index blob instead of their on-disk
  // content, so we fall back to the read-tree HEAD seed when any are present. In
  // `git ls-files -v` output, assume-unchanged shows a lowercase status letter and
  // skip-worktree shows `S`; a truncated listing is treated conservatively as "has
  // bits" so we never silently take the unsafe fast path.
  const realIndexHasSkipBits = (cwd: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.detectSkipWorktreeBits",
      cwd,
      args: ["ls-files", "-v"],
      maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
    }).pipe(
      Effect.map(
        (result) =>
          result.stdoutTruncated ||
          result.stdout.split("\n").some((line) => /^[a-zS]/.test(line)),
      ),
    );

  // Untracked, non-ignored files at or above MAX_UNTRACKED_CHECKPOINT_FILE_BYTES. Used by BOTH
  // capture (exclude from `git add`) and restore (exclude from `git clean`) via a single shared
  // predicate so the two ends can never drift — the symmetry is the correctness invariant.
  // MUST run with the plain process env: `git ls-files --others` is relative to the REAL index,
  // never the checkpoint temp index (commitEnv). `execute` uses process.env when no env is given.
  const enumerateOversizedUntracked = (cwd: string) =>
    Effect.gen(function* () {
      const listing = yield* execute({
        operation: "GitVcsDriver.checkpoints.enumerateUntracked",
        cwd,
        args: ["ls-files", "--others", "--exclude-standard", "-z"],
        // A pathologically huge untracked listing is truncated → skip the bound and fall back to
        // plain add/clean (old behavior) rather than acting on a partial set.
        maxOutputBytes: 16 * 1024 * 1024,
      });
      if (listing.stdoutTruncated) {
        return [] as ReadonlyArray<{ readonly path: string; readonly size: number }>;
      }
      const relPaths = listing.stdout.split("\0").filter((value) => value.length > 0);
      const entries = yield* Effect.forEach(
        relPaths,
        (relPath) =>
          Effect.gen(function* () {
            const absolute = path.isAbsolute(relPath) ? relPath : path.resolve(cwd, relPath);
            // stat (not lstat) — a file deleted between listing and stat, or a broken symlink,
            // resolves to null and is simply not treated as oversized.
            const info = yield* fileSystem.stat(absolute).pipe(Effect.orElseSucceed(() => null));
            if (
              info &&
              info.type === "File" &&
              Number(info.size) >= MAX_UNTRACKED_CHECKPOINT_FILE_BYTES
            ) {
              return { path: relPath, size: Number(info.size) };
            }
            return null;
          }),
        { concurrency: 16 },
      );
      return entries.filter(
        (entry): entry is { readonly path: string; readonly size: number } => entry !== null,
      );
    });

  const checkpoints: VcsDriver.VcsCheckpointOps = {
    captureCheckpoint: Effect.fn("GitVcsDriver.checkpoints.captureCheckpoint")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.captureCheckpoint";
      // Retry the pre-flight `git rev-parse --git-common-dir` on a transient failure too: it
      // runs OUTSIDE the retried operation body (the temp-index path derives from it), yet a
      // zero-work `rev-parse` is the command that most often times out under host overload — so
      // without this it would fail the whole capture unprotected, defeating the fix for its most
      // likely trigger.
      const gitCommonDir = yield* resolveGitCommonDir(input.cwd).pipe(
        Effect.retry(captureRetryPolicy),
      );
      const tempIndexPath = path.join(
        gitCommonDir,
        `t3-checkpoint-index-${NodeCrypto.randomUUID()}`,
      );
      const commitEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_INDEX_FILE: tempIndexPath,
        GIT_AUTHOR_NAME: "T3 Code",
        GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
        GIT_COMMITTER_NAME: "T3 Code",
        GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
      };

      const cleanupTempIndex = fileSystem
        .remove(tempIndexPath, { force: true })
        .pipe(Effect.ignore);

      yield* Effect.gen(function* () {
        // Heavy untracked artifacts (regenerable `.npy`/`.npz` matrices, model weights, caches)
        // would make `git add -A` deflate+write hundreds of MB of new blobs and blow the process
        // timeout. Exclude any untracked file >= the size threshold from capture (and mirror it
        // in restore's clean). Runs with the plain env (real index) — see the helper.
        const oversizedUntracked = yield* enumerateOversizedUntracked(input.cwd);

        // Seed the throwaway index so `git add -A` can use git's stat cache and skip
        // re-hashing unchanged files; otherwise every capture re-reads the entire
        // working tree and can exceed the process timeout on large repos. Copying the
        // real index inherits its warm stat cache. These queries read the REAL index,
        // so they must run with the plain process env — never `commitEnv`, which
        // points GIT_INDEX_FILE at the throwaway temp index.
        const realIndexPath = yield* resolveGitIndexPath(input.cwd);
        const realIndexExists = yield* fileSystem
          .exists(realIndexPath)
          .pipe(Effect.orElseSucceed(() => false));
        const canSeedFromRealIndex =
          realIndexExists && !(yield* realIndexHasSkipBits(input.cwd));

        // The copy can fail (disk, permissions); on any failure fall back to the
        // read-tree HEAD seed, which still produces a correct (just slower) checkpoint.
        let seededFromRealIndex = false;
        if (canSeedFromRealIndex) {
          seededFromRealIndex = yield* fileSystem
            .copyFile(realIndexPath, tempIndexPath)
            .pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
        }

        if (!seededFromRealIndex) {
          // A failed copy can leave a partial temp index on disk. Discard it so the
          // fallback seeds a clean index: `read-tree HEAD` would overwrite it, but a
          // repo with no HEAD would otherwise run `git add -A` on corrupt bytes and
          // fail the whole capture.
          yield* fileSystem.remove(tempIndexPath, { force: true }).pipe(Effect.ignore);
          const headExists = yield* hasHeadCommit(input.cwd);
          if (headExists) {
            yield* execute({
              operation,
              cwd: input.cwd,
              args: ["read-tree", "HEAD"],
              env: commitEnv,
            });
          }
        }

        // `:(exclude,literal)` pathspecs drop the oversized untracked files from `-A`. `git add`
        // is per-file, so a literal-path exclude works even for a file in a fully-untracked
        // subtree. Empty set → exactly `git add -A -- .` as before (zero behavior change).
        const addExcludePathspecs = oversizedUntracked.map(
          (entry) => `:(exclude,literal)${entry.path}`,
        );
        yield* execute({
          operation,
          cwd: input.cwd,
          args: ["add", "-A", "--", ".", ...addExcludePathspecs],
          env: commitEnv,
        });
        if (oversizedUntracked.length > 0) {
          const skippedBytes = oversizedUntracked.reduce((sum, entry) => sum + entry.size, 0);
          yield* Effect.logInfo("checkpoint: skipped oversized untracked files from capture").pipe(
            Effect.annotateLogs({
              cwd: input.cwd,
              skippedFiles: oversizedUntracked.length,
              skippedBytes,
              thresholdBytes: MAX_UNTRACKED_CHECKPOINT_FILE_BYTES,
            }),
          );
        }

        const writeTreeResult = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["write-tree"],
          env: commitEnv,
        });
        const treeOid = writeTreeResult.stdout.trim();
        if (treeOid.length === 0) {
          return yield* new VcsProcessExitError({
            operation,
            command: "git write-tree",
            cwd: input.cwd,
            exitCode: 0,
            detail: "git write-tree returned an empty tree oid.",
          });
        }

        const message = `t3 checkpoint ref=${input.checkpointRef}`;
        const commitTreeResult = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["commit-tree", treeOid, "-m", message],
          env: commitEnv,
        });
        const commitOid = commitTreeResult.stdout.trim();
        if (commitOid.length === 0) {
          return yield* new VcsProcessExitError({
            operation,
            command: "git commit-tree",
            cwd: input.cwd,
            exitCode: 0,
            detail: "git commit-tree returned an empty commit oid.",
          });
        }

        yield* execute({
          operation,
          cwd: input.cwd,
          args: ["update-ref", input.checkpointRef, commitOid],
        });
      }).pipe(
        // Retry the whole capture on a transient VCS failure (host-overload timeout / spawn
        // starvation) — never on a real git exit or a decode/detection error. Retry is INSIDE
        // `ensuring` so the temp index is cleaned up exactly once after all attempts settle;
        // each attempt re-seeds it afresh. `isTransientVcsError` matches only the transient
        // tags in the operation's error union.
        Effect.retry(captureRetryPolicy),
        Effect.ensuring(cleanupTempIndex),
      );
    }),

    hasCheckpointRef: (input) =>
      resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
        Effect.map((commit) => commit !== null),
      ),

    restoreCheckpoint: Effect.fn("GitVcsDriver.checkpoints.restoreCheckpoint")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.restoreCheckpoint";

      let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);

      if (!commitOid && input.fallbackToHead === true) {
        commitOid = yield* resolveHeadCommit(input.cwd);
      }

      if (!commitOid) {
        return false;
      }

      yield* execute({
        operation,
        cwd: input.cwd,
        args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", "."],
      });
      // Symmetric to capture: oversized untracked artifacts were never captured, so they must not
      // be deleted here. `git restore --worktree` leaves untracked files on disk, so recompute the
      // set and pass each as a `git clean -e` exclude — this preserves the heavy file while still
      // cleaning its small untracked siblings (a file-level pathspec exclude would fail, because
      // `git clean -fd` removes a fully-untracked directory wholesale). Empty set → plain clean.
      const oversizedUntracked = yield* enumerateOversizedUntracked(input.cwd);
      const cleanExcludes = oversizedUntracked.flatMap((entry) => [
        "-e",
        checkpointCleanExcludePattern(entry.path),
      ]);
      yield* execute({
        operation,
        cwd: input.cwd,
        args: ["clean", "-fd", ...cleanExcludes, "--", "."],
      });

      const headExists = yield* hasHeadCommit(input.cwd);
      if (headExists) {
        yield* execute({
          operation,
          cwd: input.cwd,
          args: ["reset", "--quiet", "--", "."],
        });
      }

      return true;
    }),

    diffCheckpoints: Effect.fn("GitVcsDriver.checkpoints.diffCheckpoints")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.diffCheckpoints";
      yield* Effect.annotateCurrentSpan({
        "checkpoint.cwd": input.cwd,
        "checkpoint.from_ref": input.fromCheckpointRef,
        "checkpoint.to_ref": input.toCheckpointRef,
        "checkpoint.ignore_whitespace": input.ignoreWhitespace,
        "checkpoint.fallback_from_to_head": input.fallbackFromToHead,
      });

      let fromRevision: string = input.fromCheckpointRef;
      if (input.fallbackFromToHead === true) {
        const resolvedFromCommit = yield* resolveCheckpointCommit(
          input.cwd,
          input.fromCheckpointRef,
        );
        if (resolvedFromCommit) {
          fromRevision = resolvedFromCommit;
        } else {
          const headCommit = yield* resolveHeadCommit(input.cwd);
          if (!headCommit) {
            return yield* new VcsProcessExitError({
              operation,
              command: "git diff",
              cwd: input.cwd,
              exitCode: 1,
              detail: "Checkpoint ref is unavailable for diff operation.",
            });
          }
          fromRevision = headCommit;
        }
      }

      const result = yield* execute({
        operation,
        cwd: input.cwd,
        args: [
          "diff",
          "--patch",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          `${fromRevision}^{commit}`,
          `${input.toCheckpointRef}^{commit}`,
        ],
        allowNonZeroExit: true,
        maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      });

      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "Checkpoint ref is unavailable for diff operation.",
        });
      }

      return result.stdout;
    }),

    deleteCheckpointRefs: Effect.fn("GitVcsDriver.checkpoints.deleteCheckpointRefs")(
      function* (input) {
        yield* Effect.forEach(
          input.checkpointRefs,
          (checkpointRef) =>
            execute({
              operation: "GitVcsDriver.checkpoints.deleteCheckpointRefs",
              cwd: input.cwd,
              args: ["update-ref", "-d", checkpointRef],
              allowNonZeroExit: true,
            }),
          { discard: true },
        );
      },
    ),
  };

  return {
    capabilities,
    execute,
    checkpoints,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
  };
});

export const makeVcsDriver = Effect.gen(function* () {
  const driver = yield* makeVcsDriverShape();
  return VcsDriver.VcsDriver.of(driver);
});

export const make = Effect.gen(function* () {
  const git = yield* makeGitVcsDriverCore();
  return GitVcsDriver.of(git);
});

export const vcsLayer = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver);
export const layer = Layer.effect(GitVcsDriver, make);
