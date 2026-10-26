import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubMediaFetch from "./gitHubMediaFetch.ts";

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
          Layer.mock(GitHubCredentials.GitHubCredentials)({
            get: () => Effect.succeed(credential("folder")),
            others: () => {
              othersCalls += 1;
              return input.others;
            },
          }),
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
});
