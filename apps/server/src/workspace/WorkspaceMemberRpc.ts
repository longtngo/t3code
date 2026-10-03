/**
 * The workspace-member RPCs, kept out of `ws.ts` so their rules are testable.
 *
 * Every handler runs git in a directory it resolves from project state, never
 * from the caller: a client that could name a path could run git anywhere the
 * server can reach.
 */
import type {
  ProjectId,
  ThreadId,
  WorkspaceMember,
  WorkspaceMemberActionPrepareInput,
  WorkspaceMemberActionPrepareResult,
  WorkspaceMemberBranchesInput,
  WorkspaceMemberBranchesResult,
  WorkspaceMemberPrBaseWriteInput,
  WorkspaceMemberPrBaseWriteResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as WorkspaceMemberBranches from "./WorkspaceMemberBranches.ts";

export interface WorkspaceMemberRpcDependencies<ProjectReadError, ThreadReadError> {
  /** The project's member list; fails when the project cannot be read. */
  readonly readMembers: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<WorkspaceMember> | undefined, ProjectReadError>;
  /** The thread's project and title, or null when it does not exist. */
  readonly readThread: (
    threadId: ThreadId,
  ) => Effect.Effect<
    { readonly projectId: ProjectId; readonly title: string } | null,
    ThreadReadError
  >;
  readonly branches: WorkspaceMemberBranches.WorkspaceMemberBranches["Service"];
  /** Recompute a member's cached local status after its branch moved. Never fails. */
  readonly refreshLocalStatus: (cwd: string) => Effect.Effect<void>;
}

export function makeWorkspaceMemberRpc<ProjectReadError, ThreadReadError>(
  deps: WorkspaceMemberRpcDependencies<ProjectReadError, ThreadReadError>,
) {
  const resolveMember = Effect.fn("WorkspaceMemberRpc.resolveMember")(function* (
    projectId: ProjectId,
    memberId: string,
  ): Effect.fn.Return<
    | { readonly kind: "found"; readonly member: WorkspaceMember }
    | { readonly kind: "detached" }
    | { readonly kind: "unreadable" }
  > {
    // A project that could not be read is a different answer from a project
    // that no longer lists this repository, and saying the second when the
    // first happened is confidently wrong.
    const read = yield* deps.readMembers(projectId).pipe(
      Effect.map((members) => ({ ok: true as const, members })),
      Effect.orElseSucceed(() => ({ ok: false as const, members: undefined })),
    );
    if (!read.ok) return { kind: "unreadable" };
    const member = read.members?.find((entry) => entry.id === memberId);
    return member === undefined ? { kind: "detached" } : { kind: "found", member };
  });

  const branches = Effect.fn("WorkspaceMemberRpc.branches")(function* (
    input: WorkspaceMemberBranchesInput,
  ): Effect.fn.Return<WorkspaceMemberBranchesResult> {
    const members =
      (yield* deps.readMembers(input.projectId).pipe(Effect.orElseSucceed(() => undefined))) ?? [];
    // Inspecting a member is read-only and costs several git subprocesses, so
    // the members overlap rather than adding up into one long request.
    // `Effect.forEach` still answers in member order.
    const reports = yield* Effect.forEach(
      members,
      (member) =>
        deps.branches
          .inspect({
            cwd: member.path,
            integrationBranch: member.integrationBranch,
            threadId: input.threadId,
          })
          .pipe(Effect.map((report) => ({ ...report, memberId: member.id }))),
      { concurrency: WorkspaceMemberBranches.MEMBER_READ_CONCURRENCY },
    );
    return { reports };
  });

  const actionPrepare = Effect.fn("WorkspaceMemberRpc.actionPrepare")(function* (
    input: WorkspaceMemberActionPrepareInput,
  ): Effect.fn.Return<WorkspaceMemberActionPrepareResult> {
    const unavailable = (detail: string): WorkspaceMemberActionPrepareResult => ({
      report: {
        memberId: input.memberId,
        state: "unavailable",
        branch: null,
        ownerThreadId: null,
        detail,
      },
      prBase: null,
    });
    const resolved = yield* resolveMember(input.projectId, input.memberId);
    if (resolved.kind === "unreadable") return unavailable("This project could not be read.");
    if (resolved.kind === "detached") {
      return unavailable("This repository is no longer attached to the project.");
    }
    const member = resolved.member;
    const thread = yield* deps.readThread(input.threadId).pipe(Effect.orElseSucceed(() => null));
    // The branch this cuts records the thread as its owner, so a thread from
    // another project must not be able to claim a repository here by naming
    // someone else's project id.
    if (thread !== null && thread.projectId !== input.projectId) {
      return unavailable("This thread does not belong to that project.");
    }
    const report = yield* deps.branches.ensureFeatureBranch({
      cwd: member.path,
      integrationBranch: member.integrationBranch,
      threadId: input.threadId,
      threadTitle: thread?.title ?? null,
      // The user asked to act in this repository, so anything `git add -A`
      // would sweep up counts — untracked files included. The post-run sweep
      // deliberately uses the narrower rule; see `ensureFeatureBranch`.
      cutOn: "any",
    });
    // The status cache is keyed by directory and nothing else recomputes a
    // directory that is not some thread's own cwd, so a branch this just moved
    // would keep reporting the old one.
    yield* deps.refreshLocalStatus(member.path);
    // A member still on its integration branch has no branch to open a pull
    // request from, and comparing it against itself is meaningless.
    const prBase =
      report.branch === null || report.branch === member.integrationBranch
        ? null
        : yield* deps.branches.resolvePrBase({
            cwd: member.path,
            integrationBranch: member.integrationBranch,
          });
    return { report: { ...report, memberId: member.id }, prBase };
  });

  const prBaseWrite = Effect.fn("WorkspaceMemberRpc.prBaseWrite")(function* (
    input: WorkspaceMemberPrBaseWriteInput,
  ): Effect.fn.Return<WorkspaceMemberPrBaseWriteResult> {
    const resolved = yield* resolveMember(input.projectId, input.memberId);
    if (resolved.kind !== "found") return { written: false };
    // `git config` takes its arguments positionally with no `--`, and a branch
    // name cannot begin with `-` anyway, so anything option-shaped is rejected
    // rather than handed to git.
    if (input.base.startsWith("-") || input.branch.startsWith("-")) return { written: false };
    // The key is read back for whichever branch is checked out at pull-request
    // time. Writing it for a branch that has since moved leaves an orphan key
    // and the base silently falls back to inference — the failure the
    // confirmation exists to prevent.
    const current = yield* deps.branches
      .inspect({
        cwd: resolved.member.path,
        integrationBranch: resolved.member.integrationBranch,
        threadId: "",
      })
      .pipe(Effect.map((report) => report.branch));
    if (current !== input.branch) return { written: false };
    const written = yield* deps.branches.writePrBase({
      cwd: resolved.member.path,
      branch: input.branch,
      base: input.base,
    });
    return { written };
  });

  return { branches, actionPrepare, prBaseWrite };
}
