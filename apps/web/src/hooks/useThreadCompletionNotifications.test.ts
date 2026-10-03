import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { collectThreadCompletions } from "./useThreadCompletionNotifications";

const shell = (environmentId: string, id: string, status: string): EnvironmentThreadShell =>
  ({
    environmentId,
    id,
    title: id,
    latestRun: { runId: `run-${id}`, status },
    pendingBackgroundTasks: [],
  }) as unknown as EnvironmentThreadShell;

const edge = (crewRoles: ReadonlyMap<string, string>) => {
  const previous = new Map<string, string | null>();
  const threads = (status: string) => [
    shell("primary", "plain", status),
    shell("primary", "crew-1", status),
    shell("primary", "bridge-1", status),
    // Same thread id on another environment: the primary's role map does not apply.
    shell("secondary", "crew-1", status),
  ];
  collectThreadCompletions({
    previous,
    threads: threads("running"),
    crewEnvironmentId: "primary",
    crewRoles,
  });
  return collectThreadCompletions({
    previous,
    threads: threads("completed"),
    crewEnvironmentId: "primary",
    crewRoles,
  }).map(({ environmentId, completion }) => `${environmentId}:${completion.threadId}`);
};

describe("collectThreadCompletions", () => {
  it("crew threads on the primary environment raise no completion notification", () => {
    expect(
      edge(
        new Map([
          ["crew-1", "crewmate-closed"],
          ["bridge-1", "bridge"],
        ]),
      ),
    ).toEqual(["primary:plain", "secondary:crew-1"]);
  });

  it("without crew roles every finished thread notifies", () => {
    expect(edge(new Map())).toEqual([
      "primary:plain",
      "primary:crew-1",
      "primary:bridge-1",
      "secondary:crew-1",
    ]);
  });
});
