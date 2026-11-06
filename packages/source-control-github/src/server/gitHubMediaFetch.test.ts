import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubMediaFetch from "./gitHubMediaFetch.ts";
import * as GitHubRest from "./GitHubRest.ts";

const PR_REPOSITORY = "enterprise/private";

/** An SSO organization: the upload URL answers with a sign-in page, a rendered signed URL with bytes. */
const makeSsoFixture = (uploadUrl: string) => {
  const state = { account: "account-a", expired: new Set<string>() };
  const rendered: Array<GitHubRest.GitHubRestInput> = [];
  const signedUrls: Array<string> = [];
  const requests: Array<{ url: string; authorization?: string; range?: string }> = [];
  const credential = (host: string) =>
    Effect.sync(() => ({
      host,
      token: Redacted.make(state.account),
      fingerprint: state.account,
      source: "gh" as const,
    }));
  const layer = Layer.mergeAll(
    Layer.mock(GitHubCredentials.GitHubCredentials)({ get: credential }),
    Layer.mock(GitHubRest.GitHubRest)({
      withDirectory: () => (effect) => effect,
      rest: (input) =>
        Effect.sync(() => {
          rendered.push(input);
          const signed = `https://private-user-images.githubusercontent.com/1/upload.mp4?jwt=${state.account}-${rendered.length}&x=1`;
          const inRepository =
            (input.body as { readonly context?: string } | undefined)?.context === PR_REPOSITORY;
          if (inRepository) signedUrls.push(signed);
          return {
            status: 200,
            headers: {},
            body: `<p><img src="${inRepository ? signed.replaceAll("&", "&amp;") : uploadUrl}" alt=""></p>`,
            truncated: false,
            invalidUtf8: false,
          };
        }),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push({
            url: request.url,
            ...(request.headers.authorization
              ? { authorization: request.headers.authorization }
              : {}),
            ...(request.headers.range ? { range: request.headers.range } : {}),
          });
          if (request.url === uploadUrl) {
            return HttpClientResponse.fromWeb(
              request,
              new Response("<html>Sign in with SSO</html>", {
                headers: { "content-type": "text/html; charset=utf-8" },
              }),
            );
          }
          expect(signedUrls).toContain(request.url);
          const status = state.expired.has(request.url) ? 403 : request.headers.range ? 206 : 200;
          return HttpClientResponse.fromWeb(
            request,
            new Response(null, { status, headers: { "content-type": "video/mp4" } }),
          );
        }),
      ),
    ),
  );
  return { layer, state, rendered, signedUrls, requests };
};

describe("GitHubMediaFetch", () => {
  it.effect("loads private media immediately after login with the GitHub credential", () => {
    const cwds: Array<string | null> = [];
    const authorizations: Array<string | undefined> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      const request = {
        url: "https://raw.githubusercontent.com/owner/repo/main/shot.png",
        cwd: "/projects/app",
        headers: {},
      };
      expect((yield* fetchMedia(request))?.status).toBe(404);
      expect((yield* fetchMedia(request))?.status).toBe(200);
      expect((yield* fetchMedia(request))?.status).toBe(200);
      expect(cwds).toEqual(["/projects/app", "/projects/app", "/projects/app"]);
      expect(authorizations).toEqual([undefined, "Bearer signed-in", "Bearer signed-in"]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(GitHubRest.GitHubRest)({ withDirectory: () => (effect) => effect }),
          Layer.mock(GitHubCredentials.GitHubCredentials)({
            get: (host, cwd) => {
              cwds.push(cwd);
              return cwds.length === 1
                ? Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host }))
                : Effect.succeed({
                    host,
                    token: Redacted.make("signed-in"),
                    source: "gh" as const,
                    fingerprint: "fingerprint",
                  });
            },
          }),
        ),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          authorizations.push(request.headers.authorization);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, {
                status: request.headers.authorization ? 200 : 404,
                headers: { "content-type": "image/png" },
              }),
            ),
          );
        }),
      ),
      Effect.scoped,
    );
  });

  it.effect("fetches each asset with the account its signed folder names", () => {
    const authorizations: Array<string | undefined> = [];
    const accountByFolder: Record<string, string> = { "/x": "token-A", "/y": "token-B" };
    return Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      for (const cwd of ["/x", "/y"]) {
        const response = yield* fetchMedia({
          url: "https://raw.githubusercontent.com/owner/repo/main/shot.png",
          cwd,
          headers: {},
        });
        expect(response?.status).toBe(200);
      }
      expect(authorizations).toEqual(["Bearer token-A", "Bearer token-B"]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(GitHubRest.GitHubRest)({ withDirectory: () => (effect) => effect }),
          Layer.mock(GitHubCredentials.GitHubCredentials)({
            get: (host, cwd) =>
              Effect.succeed({
                host,
                token: Redacted.make(accountByFolder[cwd ?? ""] ?? "token-active"),
                source: "folder" as const,
                fingerprint: cwd ?? "active",
              }),
          }),
        ),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          authorizations.push(request.headers.authorization);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: 200, headers: { "content-type": "image/png" } }),
            ),
          );
        }),
      ),
      Effect.scoped,
    );
  });

  it.effect("keeps the credential off the object store a redirect hands the media to", () => {
    const authorizations: Array<[string, string | undefined]> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      const response = yield* fetchMedia({
        url: "https://github.com/user-attachments/assets/1a1842fb",
        cwd: "/projects/app",
        headers: { range: "bytes=0-1" },
      });
      expect(response?.status).toBe(200);
      expect(authorizations).toEqual([
        ["github.com", "Bearer signed-in"],
        ["objects.example.com", undefined],
      ]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(GitHubRest.GitHubRest)({ withDirectory: () => (effect) => effect }),
          Layer.mock(GitHubCredentials.GitHubCredentials)({
            get: (host) =>
              Effect.succeed({
                host,
                token: Redacted.make("signed-in"),
                source: "gh" as const,
                fingerprint: "fingerprint",
              }),
          }),
        ),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const url = new URL(request.url);
          authorizations.push([url.hostname, request.headers.authorization]);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              url.hostname === "github.com"
                ? new Response(null, {
                    status: 302,
                    headers: { location: "https://objects.example.com/signed" },
                  })
                : new Response(null, { status: 200 }),
            ),
          );
        }),
      ),
      Effect.scoped,
    );
  });
  describe("when the folder's account cannot see the media", () => {
    const credential = (token: string, account?: string) => ({
      host: "github.com",
      token: Redacted.make(token),
      source: "gh" as const,
      fingerprint: token,
      ...(account === undefined ? {} : { account }),
    });
    const run = (input: {
      readonly url: string;
      readonly visibleTo: ReadonlySet<string>;
      readonly folderStatus?: number;
      readonly failing?: ReadonlyMap<string, number | "network">;
      readonly others: Effect.Effect<
        ReadonlyArray<GitHubCredentials.GitHubCredential>,
        GitHubCredentials.GitHubCredentialUnavailableError
      >;
    }) => {
      const requests: Array<[string, string | undefined]> = [];
      let othersCalls = 0;
      return Effect.gen(function* () {
        const fetchMedia = yield* GitHubMediaFetch.make;
        const response = yield* fetchMedia({ url: input.url, cwd: "/reports", headers: {} });
        return { status: response?.status, requests, othersCalls };
      }).pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(GitHubRest.GitHubRest)({ withDirectory: () => (effect) => effect }),
            Layer.mock(GitHubCredentials.GitHubCredentials)({
              get: () => Effect.succeed(credential("folder")),
              others: () => {
                othersCalls += 1;
                return input.others;
              },
            }),
          ),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const url = new URL(request.url);
            const authorization = request.headers.authorization;
            requests.push([url.hostname, authorization]);
            const token = authorization?.replace("Bearer ", "") ?? "";
            const failure = input.failing?.get(token);
            if (failure === "network") {
              return Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({ request }),
                }),
              );
            }
            const status =
              url.hostname === "objects.example.com"
                ? 200
                : failure !== undefined
                  ? failure
                  : token === "folder" && input.folderStatus !== undefined
                    ? input.folderStatus
                    : input.visibleTo.has(token)
                      ? 302
                      : 404;
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(null, {
                  status,
                  headers: status === 302 ? { location: "https://objects.example.com/signed" } : {},
                }),
              ),
            );
          }),
        ),
        Effect.scoped,
      );
    };
    const attachment = "https://github.com/user-attachments/assets/52c908e0";

    it.effect("loads it as the first other signed-in login that can, stopping there", () =>
      Effect.gen(function* () {
        const result = yield* run({
          url: attachment,
          visibleTo: new Set(["uni"]),
          others: Effect.succeed([
            credential("personal", "a"),
            credential("uni", "b"),
            credential("third", "c"),
          ]),
        });
        expect(result.status).toBe(200);
        expect(result.requests).toEqual([
          ["github.com", "Bearer folder"],
          ["github.com", "Bearer personal"],
          ["github.com", "Bearer uni"],
          ["objects.example.com", undefined],
        ]);
      }),
    );

    it.effect("skips a login that errors and keeps looking", () =>
      Effect.gen(function* () {
        const result = yield* run({
          url: attachment,
          visibleTo: new Set(["uni"]),
          failing: new Map<string, number | "network">([
            ["limited", 429],
            ["broken", "network"],
          ]),
          others: Effect.succeed([
            credential("limited", "a"),
            credential("broken", "b"),
            credential("uni", "c"),
          ]),
        });
        expect(result.status).toBe(200);
        const unseen = yield* run({
          url: attachment,
          visibleTo: new Set(),
          failing: new Map<string, number | "network">([["broken", "network"]]),
          others: Effect.succeed([credential("broken", "b")]),
        });
        expect(unseen.status).toBe(404);
      }),
    );

    it.effect("never asks for other logins when the folder's account can see it", () =>
      Effect.gen(function* () {
        const result = yield* run({
          url: attachment,
          visibleTo: new Set(["folder"]),
          others: Effect.succeed([credential("uni", "b")]),
        });
        expect(result.status).toBe(200);
        expect(result.othersCalls).toBe(0);
      }),
    );

    it.effect("only a not-found answer tries other logins", () =>
      Effect.gen(function* () {
        const result = yield* run({
          url: attachment,
          visibleTo: new Set(["uni"]),
          folderStatus: 403,
          others: Effect.succeed([credential("uni", "b")]),
        });
        expect(result.status).toBe(403);
        expect(result.requests).toHaveLength(1);
      }),
    );

    it.effect("keeps the folder's answer when the other logins can't be listed or see it", () =>
      Effect.gen(function* () {
        const failed = yield* run({
          url: attachment,
          visibleTo: new Set(),
          others: Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host: "github.com" })),
        });
        expect(failed.status).toBe(404);
        expect(failed.requests).toHaveLength(1);
        const unseen = yield* run({
          url: attachment,
          visibleTo: new Set(),
          others: Effect.succeed([credential("personal", "a")]),
        });
        expect(unseen.status).toBe(404);
        expect(unseen.requests).toHaveLength(2);
      }),
    );

    it.effect("asks no other login about media GitHub does not serve", () =>
      Effect.gen(function* () {
        const result = yield* run({
          url: "https://images.example.com/shot.png",
          visibleTo: new Set(["uni"]),
          others: Effect.succeed([credential("uni", "b")]),
        });
        expect(result.status).toBe(404);
        expect(result.othersCalls).toBe(0);
      }),
    );
  });

  it.effect(
    "renders SSO uploads in the PR repository and reuses the signed URL for a range",
    () => {
      const url = "https://github.com/user-attachments/assets/explicit-pr-context";
      const fixture = makeSsoFixture(url);
      return Effect.gen(function* () {
        const fetchMedia = yield* GitHubMediaFetch.make;
        const request = { url, cwd: "/repo", headers: {}, repository: PR_REPOSITORY };
        expect((yield* fetchMedia(request))?.status).toBe(200);
        expect((yield* fetchMedia({ ...request, headers: { range: "bytes=2-5" } }))?.status).toBe(
          206,
        );
        expect(fixture.rendered).toHaveLength(1);
        expect(fixture.rendered[0]).toMatchObject({
          host: "github.com",
          // Rendered as the same folder account the upload was requested as.
          cwd: "/repo",
          method: "POST",
          path: "markdown",
          accept: "text/html",
          body: { text: `![](${url})`, mode: "gfm", context: PR_REPOSITORY },
        });
        expect(fixture.requests).toEqual([
          { url, authorization: "Bearer account-a" },
          { url: fixture.signedUrls[0] },
          { url: fixture.signedUrls[0], range: "bytes=2-5" },
        ]);
      }).pipe(Effect.provide(fixture.layer), Effect.scoped);
    },
  );

  it.effect("renders a legacy upload in the repository its path names", () => {
    const url = `https://github.com/${PR_REPOSITORY}/assets/123/legacy`;
    const fixture = makeSsoFixture(url);
    return Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      const response = yield* fetchMedia({
        url,
        cwd: "/repo",
        headers: {},
        repository: "personal/unrelated",
      });
      expect(response?.status).toBe(200);
      expect(fixture.rendered.map((input) => input.body)).toEqual([
        { text: `![](${url})`, mode: "gfm", context: PR_REPOSITORY },
      ]);
    }).pipe(Effect.provide(fixture.layer), Effect.scoped);
  });

  it.effect("renders a fresh signed URL after an account switch, early expiry, or its TTL", () => {
    const url = "https://github.com/user-attachments/assets/cache-lifecycle";
    const fixture = makeSsoFixture(url);
    const request = { url, cwd: "/repo", headers: {}, repository: PR_REPOSITORY };
    return Effect.gen(function* () {
      const fetchMedia = yield* GitHubMediaFetch.make;
      yield* fetchMedia(request);
      fixture.state.account = "account-b";
      yield* fetchMedia(request);
      expect(fixture.rendered).toHaveLength(2);

      fixture.state.expired.add(fixture.signedUrls.at(-1)!);
      expect((yield* fetchMedia(request))?.status).toBe(200);
      expect(fixture.rendered).toHaveLength(3);

      yield* TestClock.adjust("6 minutes");
      yield* fetchMedia(request);
      expect(fixture.rendered).toHaveLength(4);
      expect(fixture.requests.at(-1)?.url).toBe(fixture.signedUrls.at(-1));
    }).pipe(Effect.provide(fixture.layer), Effect.scoped);
  });
});
