import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as GitHubRest from "./GitHubRest.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The folder's account is A; B is the other signed-in login. `uni/delivery-api` is B's alone. */
const SEES: Record<string, ReadonlyArray<string>> = {
  "uni/delivery-api": ["B"],
  "uni/visible": ["A", "B"],
};

const credentialOf = (host: string, login: string): GitHubCredentials.GitHubCredential => ({
  host,
  token: Redacted.make(login),
  source: "gh",
  fingerprint: `${host}:${login}`,
  account: login,
});

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly as: string;
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
}

const coreNode = (number: number) => ({
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/uni/delivery-api/pull/${number}`,
  body: "",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  reviewDecision: null,
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  mergedAt: null,
  closedAt: null,
  isCrossRepository: false,
  headRepositoryOwner: null,
  headRepository: null,
  headRef: null,
  author: null,
  autoMergeRequest: null,
  headRefName: "feature",
  baseRefName: "main",
  headRefOid: "abc123",
  state: "OPEN",
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-02T00:00:00Z",
  viewerCanUpdate: true,
  viewerDidAuthor: false,
  viewerCanUpdateBranch: true,
  baseRef: { compare: { behindBy: 0 } },
  reviewRequests: { nodes: [] },
  labels: { nodes: [] },
  commits: { nodes: [] },
});

const summaryNode = (number: number) => ({
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/uni/pull/${number}`,
  author: null,
  baseRefName: "main",
  headRefName: `feat/${number}`,
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: null,
  latestReviews: { nodes: [] },
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  updatedAt: "2026-08-24T12:34:56.000Z",
  mergedAt: null,
  closedAt: null,
  commits: { nodes: [] },
  stack: null,
  stackEntry: null,
});

/** The real API and REST transport over a fake GitHub that answers per token. */
function harness(options: { readonly missingPullRequests?: boolean } = {}) {
  const sent: Array<Sent> = [];
  const sees = (as: string, repository: string) => SEES[repository]?.includes(as) === true;
  const credentials = Layer.succeed(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.GitHubCredentials.of({
      get: (host) => Effect.succeed(credentialOf(host, "A")),
      account: (host, login) => Effect.succeed(credentialOf(host, login)),
      others: (host) => Effect.succeed([credentialOf(host, "B")]),
      invalidate: () => Effect.void,
    }),
  );
  const respond = (request: Parameters<Parameters<typeof HttpClient.make>[0]>[0], body: unknown) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body === null ? encodeJson({ message: "Not Found" }) : encodeJson(body), {
          status: body === null ? 404 : 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const { query = "", variables = {} } =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
              readonly query?: string;
              readonly variables?: Readonly<Record<string, unknown>>;
            })
          : {};
      const as = (request.headers.authorization ?? "").replace(/^Bearer /u, "");
      sent.push({ method: request.method, url: request.url, as, query, variables });
      if (new URL(request.url).pathname === "/user") {
        return respond(request, { id: as === "A" ? 1 : 2, login: as });
      }
      const rest = /\/repos\/([^/]+\/[^/]+)(\/.*)?$/u.exec(new URL(request.url).pathname);
      if (rest !== null) {
        return respond(request, sees(as, rest[1]!) ? {} : null);
      }
      if (query.startsWith("query PullRequestCore")) {
        const repository = `${String(variables["owner"])}/${String(variables["name"])}`;
        return respond(request, {
          data: {
            repository:
              sees(as, repository) && options.missingPullRequests !== true
                ? {
                    mergeCommitAllowed: true,
                    squashMergeAllowed: true,
                    rebaseMergeAllowed: true,
                    autoMergeAllowed: true,
                    viewerPermission: "WRITE",
                    pullRequest: coreNode(Number(variables["number"])),
                  }
                : null,
          },
        });
      }
      // A batched summary document: one `_<n>_repository` alias per pull request.
      const data = Object.fromEntries(
        Object.keys(variables).flatMap((key) => {
          const alias = /^(_\d+)_number$/u.exec(key)?.[1];
          if (alias === undefined) return [];
          const repository = `${String(variables[`${alias}_owner`])}/${String(variables[`${alias}_name`])}`;
          return [
            [
              `${alias}_repository`,
              sees(as, repository)
                ? { pullRequest: summaryNode(Number(variables[`${alias}_number`])) }
                : null,
            ],
          ];
        }),
      );
      return respond(request, { data });
    }),
  );
  const layer = GitHubPullRequestApi.layer.pipe(
    Layer.provideMerge(
      GitHubRest.layer.pipe(
        Layer.provide(credentials),
        Layer.provideMerge(GitHubQuota.layer),
        Layer.provideMerge(SourceControlRateLimit.layer),
        Layer.provideMerge(http),
      ),
    ),
    Layer.provide(TestSourceControlHost.layer()),
    Layer.provide(Layer.succeed(HostProcess.Environment, {})),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(NodeServices.layer),
  );
  return { layer, sent };
}

const detailOf = (repository: string) => ({
  cwd: "/work",
  repository,
  host: "github.com",
  number: 7,
});

describe("repository account route", () => {
  it.effect(
    "detail read for a repo the folder account cannot see goes out as the account that can",
    () => {
      const { layer, sent } = harness();
      return Effect.gen(function* () {
        const api = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const detail = yield* api.getPullRequestDetail(detailOf("uni/delivery-api"));
        expect(detail.number).toBe(7);
        const graphql = sent.filter((request) => request.query !== "");
        expect(graphql.map((request) => request.as)).toEqual(["B"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("missing PR in visible repo does not fan out", () => {
    const { layer, sent } = harness({ missingPullRequests: true });
    return Effect.gen(function* () {
      const api = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const error = yield* Effect.flip(api.getPullRequestDetail(detailOf("uni/visible")));
      expect(error._tag).toBe("GitHubApiNotFoundError");
      expect(sent.filter((request) => request.as === "B")).toEqual([]);
      expect(sent.map((request) => request.as)).toEqual(["A", "A"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("setLabels runs once as the remembered login", () => {
    const { layer, sent } = harness();
    return Effect.gen(function* () {
      const api = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      yield* api.getPullRequestDetail(detailOf("uni/delivery-api"));
      sent.length = 0;
      yield* api.setLabels({ ...detailOf("uni/delivery-api"), labels: ["a", "b"], applied: false });
      expect(
        sent.map((request) => [request.method, new URL(request.url).pathname, request.as]),
      ).toEqual([
        ["DELETE", "/repos/uni/delivery-api/issues/7/labels/a", "B"],
        ["DELETE", "/repos/uni/delivery-api/issues/7/labels/b", "B"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("summary batch splits by account", () => {
    const { layer, sent } = harness();
    return Effect.gen(function* () {
      const api = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const reads = yield* Effect.forEach(
        ["uni/visible", "uni/delivery-api"],
        (repository) => api.getPullRequestSummary(detailOf(repository)),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 millis");
      const summaries = yield* Fiber.join(reads);
      expect(summaries.map((summary) => summary.number)).toEqual([7, 7]);
      const documents = sent
        .filter((request) => request.query !== "")
        .map((request) => [request.as, request.variables["_0_owner"], request.variables["_0_name"]])
        .toSorted();
      expect(documents).toEqual([
        ["A", "uni", "visible"],
        ["B", "uni", "delivery-api"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    { named: "uni/delivery-api", identity: "B" },
    { named: undefined, identity: "A" },
  ])(
    "a verified credential naming $named verifies $identity and sends as $identity",
    ({ named, identity }) => {
      const { layer, sent } = harness();
      return Effect.gen(function* () {
        const api = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const target = { cwd: "/work", host: "github.com" };
        const verified = yield* api.withVerifiedCredential(
          named === undefined ? target : { ...target, repository: named },
          (seen) =>
            api
              .getPullRequestDetail(detailOf("uni/delivery-api"))
              .pipe(Effect.exit, Effect.as(seen)),
        );
        expect(verified.viewer).toBe(identity);
        const work = sent.filter((request) => !/^\/repos\//u.test(new URL(request.url).pathname));
        expect(work.map((request) => [new URL(request.url).pathname, request.as])).toEqual([
          ["/user", identity],
          ["/graphql", identity],
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect.each([
    { named: "uni/delivery-api", identity: "B", accountId: "2" },
    { named: undefined, identity: "A", accountId: "1" },
  ])("the routing identity naming $named is $identity's", ({ named, identity, accountId }) => {
    const { layer } = harness();
    return Effect.gen(function* () {
      const api = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const target = { cwd: "/work", host: "github.com" };
      expect(
        yield* api.getRoutingIdentity(
          named === undefined ? target : { ...target, repository: named },
        ),
      ).toEqual({ accountId, viewer: identity });
    }).pipe(Effect.provide(layer));
  });

  type Api = GitHubPullRequestApi.GitHubPullRequestApi["Service"];
  const pr = detailOf("uni/delivery-api");
  const calls: ReadonlyArray<
    readonly [
      string,
      (api: Api) => Effect.Effect<unknown, GitHubPullRequestApi.GitHubPullRequestApiError>,
    ]
  > = [
    ["getPullRequestSummary", (api) => api.getPullRequestSummary(pr)],
    ["getPullRequestWatchFingerprint", (api) => api.getPullRequestWatchFingerprint(pr)],
    ["getPullRequestDetail", (api) => api.getPullRequestDetail(pr)],
    ["getPullRequestPreview", (api) => api.getPullRequestPreview(pr)],
    [
      "listWorkflowRunsRequiringApproval",
      (api) =>
        api.listWorkflowRunsRequiringApproval({
          ...pr,
          headSha: "abc123",
          headBranch: "feature",
          headRepositoryOwner: "fork",
          isCrossRepository: true,
        }),
    ],
    ["getPullRequestStack", (api) => api.getPullRequestStack({ ...pr, includeDetails: false })],
    ["getPullRequestActivity", (api) => api.getPullRequestActivity(pr)],
    ["getPullRequestDiff", (api) => api.getPullRequestDiff(pr)],
    [
      "getPullRequestDiffFileContents",
      (api) =>
        api.getPullRequestDiffFileContents({
          ...pr,
          changeType: "change",
          oldPath: "a.ts",
          newPath: "a.ts",
        }),
    ],
    [
      "getReviewThreadComments",
      (api) => api.getReviewThreadComments({ ...pr, threadId: "T", cursor: "c" }),
    ],
    ["listReviewThreadComments", (api) => api.listReviewThreadComments(pr)],
    ["getViewerAccess", (api) => api.getViewerAccess(pr)],
    ["listReviewerCandidates", (api) => api.listReviewerCandidates(pr)],
    [
      "setReviewerRequest",
      (api) =>
        api.setReviewerRequest({ ...pr, reviewers: [{ id: "U", kind: "user" }], requested: true }),
    ],
    ["listLabelCandidates", (api) => api.listLabelCandidates(pr)],
    ["listRepositoryLabels", (api) => api.listRepositoryLabels(pr)],
    ["searchRepositoryAuthors", (api) => api.searchRepositoryAuthors({ ...pr, query: "x" })],
    ["setLabels", (api) => api.setLabels({ ...pr, labels: ["a"], applied: true })],
    ["runPullRequestAction", (api) => api.runPullRequestAction({ ...pr, action: "close" })],
    ["commentOnPullRequest", (api) => api.commentOnPullRequest({ ...pr, body: "b" })],
    [
      "submitReview",
      (api) => api.submitReview({ ...pr, verdict: "comment", body: "b", comments: [] }),
    ],
    ["replyToReviewThread", (api) => api.replyToReviewThread({ ...pr, threadId: "T", body: "b" })],
    ["getPullRequestFilesViewed", (api) => api.getPullRequestFilesViewed(pr)],
    ["getPullRequestFileStats", (api) => api.getPullRequestFileStats(pr)],
    [
      "setPullRequestFilesViewed",
      (api) => api.setPullRequestFilesViewed({ ...pr, files: [{ path: "a.ts", viewed: true }] }),
    ],
    [
      "setReviewThreadResolution",
      (api) => api.setReviewThreadResolution({ ...pr, threadId: "T", resolved: true }),
    ],
    ["setReaction", (api) => api.setReaction({ ...pr, content: "thumbs-up", reacted: true })],
    ["updatePullRequest", (api) => api.updatePullRequest({ ...pr, title: "t" })],
    [
      "updateComment",
      (api) => api.updateComment({ ...pr, commentId: "C", kind: "issue-comment", body: "b" }),
    ],
    // Only a pinned credential revalidates; an unrouted call would send nothing.
    ["revalidateChecks", (api) => api.revalidateChecks(pr, Effect.die("read sends nothing"))],
  ];

  it.effect.each(calls)("%s goes out as the account that can see the repository", ([, call]) => {
    const { layer, sent } = harness();
    return Effect.gen(function* () {
      const api = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      // Batched reads wait out their window; whether the fake's answer decodes is not the point.
      const fiber = yield* Effect.forkChild(Effect.exit(call(api)));
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(fiber);
      const probe = /^\/repos\/[^/]+\/[^/]+$/u;
      const work = sent.filter((request) => !probe.test(new URL(request.url).pathname));
      expect(work.length).toBeGreaterThan(0);
      expect([...new Set(work.map((request) => request.as))]).toEqual(["B"]);
    }).pipe(Effect.provide(layer));
  });
});
