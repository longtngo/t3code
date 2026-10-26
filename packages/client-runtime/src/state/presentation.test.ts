import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import {
  createEnvironmentPresentationAtoms,
  createEnvironmentSummaryAtoms,
} from "./presentation.ts";
import type { EnvironmentCatalogState } from "./connections.ts";

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
    // A saved environment can be switched off (`enabled`) rather than removed.
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
    // Upstream strips `providers` into a fresh object, so this is equality, not identity.
    expect(harness.registry.get(harness.presentationAtom(ENVIRONMENT_ID))?.serverConfig).toEqual(
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

const FIRST = EnvironmentId.make("first");
const SECOND = EnvironmentId.make("second");
function entry(environmentId: EnvironmentId, label = environmentId as string) {
  return {
    target: new PrimaryConnectionTarget({
      environmentId,
      label,
      httpBaseUrl: "https://example.test",
      wsBaseUrl: "wss://example.test",
    }),
    enabled: true,
    profile: Option.none(),
  };
}
function config(pullRequests = false, cwd = "/workspace"): ServerConfig {
  return {
    cwd,
    environment: { capabilities: { pullRequests }, platform: { machine: "desktop" } },
  } as ServerConfig;
}
function harness() {
  const catalog = Atom.make<EnvironmentCatalogState>({
    isReady: true,
    entries: new Map([
      [FIRST, entry(FIRST)],
      [SECOND, entry(SECOND)],
    ]),
  });
  const configs = Atom.family((_id: EnvironmentId) => Atom.make<ServerConfig | null>(config()));
  const state = Atom.make(AsyncResult.success(AVAILABLE_CONNECTION_STATE));
  const full = createEnvironmentPresentationAtoms({
    catalogValueAtom: catalog,
    stateAtom: () => state,
    serverConfigValueAtom: configs,
  });
  const summaries = createEnvironmentSummaryAtoms({
    catalogValueAtom: catalog,
    presentationAtom: full.presentationAtom,
  });
  return { catalog, configs, state, full, ...summaries, registry: AtomRegistry.make() };
}

describe("environment summary subscriptions", () => {
  it("tracks capabilities across environments, config loss and removal", () => {
    const h = harness();
    const stop = h.registry.subscribe(h.pullRequestsSupportedAtom, () => {});
    try {
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(false);
      h.registry.set(h.configs(FIRST), config(true));
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(true);
      h.registry.set(h.configs(SECOND), config(true));
      h.registry.set(h.configs(FIRST), null);
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(true);
      h.registry.set(h.catalog, { isReady: true, entries: new Map([[FIRST, entry(FIRST)]]) });
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(false);
      expect(h.registry.get(h.environmentIdsAtom)).toEqual([FIRST]);
      expect(h.registry.get(h.identitiesAtom)).toEqual([{ environmentId: FIRST, label: "first" }]);
      h.registry.set(h.catalog, {
        isReady: true,
        entries: new Map([
          [SECOND, entry(SECOND)],
          [FIRST, entry(FIRST)],
        ]),
      });
      expect(h.registry.get(h.environmentIdsAtom)).toEqual([SECOND, FIRST]);
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(true);
      h.registry.set(h.configs(SECOND), config(false));
      expect(h.registry.get(h.pullRequestsSupportedAtom)).toBe(false);
      h.registry.set(h.catalog, { isReady: true, entries: new Map() });
      expect(h.registry.get(h.environmentIdsAtom)).toEqual([]);
      expect(h.registry.get(h.identitiesAtom)).toEqual([]);
      expect(h.registry.get(h.environmentsAtom)).toEqual([]);
    } finally {
      stop();
      h.registry.dispose();
    }
  });
});

describe("presentations with providers", () => {
  it("leaves out disabled connections until they are re-enabled", () => {
    const h = harness();
    const atom = h.full.presentationsWithProvidersAtom;
    const withSecond = (enabled: boolean): EnvironmentCatalogState => ({
      isReady: true,
      entries: new Map([
        [FIRST, entry(FIRST)],
        [SECOND, { ...entry(SECOND), enabled }],
      ]),
    });
    const stop = h.registry.subscribe(atom, () => {});
    try {
      h.registry.set(h.configs(SECOND), config(false, "/second"));
      h.registry.set(h.catalog, withSecond(false));
      expect([...h.registry.get(atom).keys()]).toEqual([FIRST]);
      expect(h.registry.get(h.full.presentationsAtom).has(SECOND)).toBe(true);
      h.registry.set(h.catalog, withSecond(true));
      expect([...h.registry.get(atom).keys()]).toEqual([FIRST, SECOND]);
      expect(h.registry.get(atom).get(SECOND)?.serverConfig?.cwd).toBe("/second");
    } finally {
      stop();
      h.registry.dispose();
    }
  });

  it("leaves out unsupported environments", () => {
    const h = harness();
    const atom = h.full.presentationsWithProvidersAtom;
    const stop = h.registry.subscribe(atom, () => {});
    try {
      h.registry.set(h.catalog, {
        isReady: true,
        entries: new Map<EnvironmentId, ConnectionCatalogEntry>([
          [FIRST, entry(FIRST)],
          [SECOND, { ...entry(SECOND), unsupportedReason: "Server is too old." }],
        ]),
      });
      expect([...h.registry.get(atom).keys()]).toEqual([FIRST]);
    } finally {
      stop();
      h.registry.dispose();
    }
  });
});
