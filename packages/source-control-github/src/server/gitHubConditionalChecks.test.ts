import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import { makeChecksRevalidator } from "./gitHubConditionalChecks.ts";

it.effect("revalidates checks as the account of the folder the pull request is read for", () => {
  const folders: Array<string | null> = [];
  return Effect.gen(function* () {
    const revalidate = yield* makeChecksRevalidator;
    const read = Effect.succeed({ state: "open" as const, checks: [], headSha: "abc" });
    yield* revalidate(
      { cwd: "/folder", host: "github.com", repository: "acme/web", number: 7 },
      read,
    ).pipe(
      Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
        host: "github.com",
        token: Redacted.make("token"),
        source: "folder",
        credentialFingerprint: "github.com:alice",
      }),
    );
    expect(folders).toEqual(["/folder"]);
  }).pipe(
    Effect.provide(
      Layer.mock(GitHubRest.GitHubRest)({
        rest: (input) => {
          folders.push(input.cwd);
          return Effect.fail(
            new GitHubRequestPolicy.GitHubApiNotFoundError({
              host: input.host,
              operation: input.operation,
            }),
          );
        },
        withDirectory: () => (effect) => effect,
      }),
    ),
  );
});
