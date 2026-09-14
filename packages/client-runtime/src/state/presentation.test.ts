import { EnvironmentId } from "@t3tools/contracts";
import type { ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { createEnvironmentPresentationAtoms } from "./presentation.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const OTHER_ENVIRONMENT_ID = EnvironmentId.make("environment-2");

function environmentEntry(environmentId: EnvironmentId, label: string) {
  return {
    target: new PrimaryConnectionTarget({
      environmentId,
      label,
      httpBaseUrl: `https://${environmentId}.example.test`,
      wsBaseUrl: `wss://${environmentId}.example.test`,
    }),
    profile: Option.none(),
    // Upstream #11478 added `enabled` to the catalog entry: a saved environment
    // can now be switched off rather than removed.
    enabled: true,
  };
}

function connectionState(overrides: Partial<SupervisorConnectionState>): SupervisorConnectionState {
  return { ...AVAILABLE_CONNECTION_STATE, ...overrides };
}

function makeHarness() {
  // The registry rebuilds the entries map but reuses each untouched entry object, so the
  // fixture must too - a fresh entry per rebuild would be a real change, not a spurious one.
  const entry = environmentEntry(ENVIRONMENT_ID, "Environment");
  const otherEntry = environmentEntry(OTHER_ENVIRONMENT_ID, "Other environment");
  const stateAtoms = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make(
      AsyncResult.success<SupervisorConnectionState, never>(
        connectionState({ desired: true, phase: "connecting", stage: "preparing", attempt: 1 }),
      ),
    ),
  );
  const configAtoms = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<ServerConfig | null>(null),
  );
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map([[ENVIRONMENT_ID, entry]]),
  });
  const atoms = createEnvironmentPresentationAtoms({
    catalogValueAtom,
    stateAtom: stateAtoms,
    serverConfigValueAtom: configAtoms,
  });

  const registry = AtomRegistry.make();
  let notifications = 0;
  const unsubscribe = registry.subscribe(atoms.presentationAtom(ENVIRONMENT_ID), () => {
    notifications += 1;
  });
  // Building the atom for the first time always notifies. Prime it and zero the counter so
  // each test counts only the notifications its own change produced.
  registry.get(atoms.presentationAtom(ENVIRONMENT_ID));
  notifications = 0;

  return {
    registry,
    entry,
    otherEntry,
    catalogValueAtom,
    stateAtom: stateAtoms,
    configAtom: configAtoms,
    presentationAtom: atoms.presentationAtom,
    presentationsAtom: atoms.presentationsAtom,
    notificationCount: () => notifications,
    unsubscribe,
  };
}

describe("environment presentation atoms", () => {
  it("does not notify when a connection-state change leaves the presentation identical", () => {
    const harness = makeHarness();
    const before = harness.registry.get(harness.presentationAtom(ENVIRONMENT_ID));

    // `stage` advances on every connect and is not part of the presentation, which
    // reads only phase, attempt, and lastFailure.
    harness.registry.set(
      harness.stateAtom(ENVIRONMENT_ID),
      AsyncResult.success(
        connectionState({
          desired: true,
          phase: "connecting",
          stage: "synchronizing",
          attempt: 1,
          generation: 4,
          retryAt: 1_000,
        }),
      ),
    );

    expect(harness.registry.get(harness.presentationAtom(ENVIRONMENT_ID))).toBe(before);
    expect(harness.notificationCount()).toBe(0);
    harness.unsubscribe();
  });

  it("still notifies when the presented connection phase changes", () => {
    const harness = makeHarness();
    const before = harness.registry.get(harness.presentationAtom(ENVIRONMENT_ID));

    harness.registry.set(
      harness.stateAtom(ENVIRONMENT_ID),
      AsyncResult.success(connectionState({ desired: true, phase: "connected" })),
    );

    const after = harness.registry.get(harness.presentationAtom(ENVIRONMENT_ID));
    expect(after).not.toBe(before);
    expect(after?.connection.phase).toBe("connected");
    expect(harness.notificationCount()).toBe(1);
    harness.unsubscribe();
  });

  it("still notifies when only the failure behind an unchanged phase changes", () => {
    const harness = makeHarness();
    harness.registry.set(
      harness.stateAtom(ENVIRONMENT_ID),
      AsyncResult.success(
        connectionState({
          desired: true,
          phase: "backoff",
          lastFailure: new ConnectionTransientError({
            reason: "network",
            detail: "Connection refused.",
            traceId: "trace-1",
          }),
        }),
      ),
    );
    const before = harness.registry.get(harness.presentationAtom(ENVIRONMENT_ID));
    expect(before?.connection).toEqual({
      phase: "reconnecting",
      error: "Connection refused.",
      traceId: "trace-1",
    });

    // Same phase, different failure. The banner a user reads lives only in `error` and
    // `traceId`, so an equality comparing phase alone would freeze the stale message. Vary
    // them one at a time - together, either comparison alone would look sufficient.
    harness.registry.set(
      harness.stateAtom(ENVIRONMENT_ID),
      AsyncResult.success(
        connectionState({
          desired: true,
          phase: "backoff",
          lastFailure: new ConnectionTransientError({
            reason: "timeout",
            detail: "Timed out.",
            traceId: "trace-1",
          }),
        }),
      ),
    );
    expect(harness.registry.get(harness.presentationAtom(ENVIRONMENT_ID))?.connection).toEqual({
      phase: "reconnecting",
      error: "Timed out.",
      traceId: "trace-1",
    });

    // A retry of the same failure carries the same message under a new trace id, which is
    // the identifier a user quotes when asking for help.
    harness.registry.set(
      harness.stateAtom(ENVIRONMENT_ID),
      AsyncResult.success(
        connectionState({
          desired: true,
          phase: "backoff",
          lastFailure: new ConnectionTransientError({
            reason: "timeout",
            detail: "Timed out.",
            traceId: "trace-2",
          }),
        }),
      ),
    );
    expect(harness.registry.get(harness.presentationAtom(ENVIRONMENT_ID))?.connection).toEqual({
      phase: "reconnecting",
      error: "Timed out.",
      traceId: "trace-2",
    });
    harness.unsubscribe();
  });

  it("still notifies when this environment's own entry or server config changes", () => {
    const harness = makeHarness();
    const relabelled = environmentEntry(ENVIRONMENT_ID, "Renamed environment");

    harness.registry.set(harness.catalogValueAtom, {
      isReady: true,
      entries: new Map([[ENVIRONMENT_ID, relabelled]]),
    });
    expect(harness.registry.get(harness.presentationAtom(ENVIRONMENT_ID))?.entry).toBe(relabelled);

    const config = { cwd: "/repo" } as ServerConfig;
    harness.registry.set(harness.configAtom(ENVIRONMENT_ID), config);
    expect(harness.registry.get(harness.presentationAtom(ENVIRONMENT_ID))?.serverConfig).toBe(
      config,
    );
    expect(harness.notificationCount()).toBe(2);
    harness.unsubscribe();
  });

  it("does not notify one environment when another is added to the catalog", () => {
    const harness = makeHarness();
    const before = harness.registry.get(harness.presentationAtom(ENVIRONMENT_ID));

    harness.registry.set(harness.catalogValueAtom, {
      isReady: true,
      entries: new Map([
        [ENVIRONMENT_ID, harness.entry],
        [OTHER_ENVIRONMENT_ID, harness.otherEntry],
      ]),
    });

    expect(harness.registry.get(harness.presentationAtom(ENVIRONMENT_ID))).toBe(before);
    expect(harness.notificationCount()).toBe(0);
    harness.unsubscribe();
  });
});
