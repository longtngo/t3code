import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { AVAILABLE_CONNECTION_STATE, type SupervisorConnectionState } from "../connection/model.ts";
import {
  presentEnvironmentConnection,
  type EnvironmentPresentation,
} from "../connection/presentation.ts";
import type { EnvironmentCatalogState } from "./connections.ts";

function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

/**
 * Whether two presentations are interchangeable to a consumer.
 *
 * This covers the value's whole shape rather than a chosen subset: `entry` and
 * `serverConfig` are rebuilt on change rather than mutated in place, so identity is the
 * right test for them, and `connection` is three primitives. Nothing a consumer can read
 * off a presentation is left out, so a suppressed notification cannot hide a change.
 */
function presentationsEqual(
  left: EnvironmentPresentation | null,
  right: EnvironmentPresentation | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.entry === right.entry &&
    left.serverConfig === right.serverConfig &&
    left.connection.phase === right.connection.phase &&
    left.connection.error === right.connection.error &&
    left.connection.traceId === right.connection.traceId
  );
}

export function createEnvironmentPresentationAtoms<E>(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly stateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<SupervisorConnectionState, E>>;
  /** Authoritative live server config, including streamed provider/settings updates. */
  readonly serverConfigValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
}) {
  const presentationAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const entry = get(input.catalogValueAtom).entries.get(environmentId);
      if (entry === undefined) {
        return null;
      }
      const state = Option.getOrElse(
        AsyncResult.value(get(input.stateAtom(environmentId))),
        () => AVAILABLE_CONNECTION_STATE,
      );
      return {
        entry,
        connection: presentEnvironmentConnection(state),
        serverConfig: get(input.serverConfigValueAtom(environmentId)),
      } satisfies EnvironmentPresentation;
    }).pipe(
      // An atom notifies on every rebuild unless it declares equality, and several rebuilds
      // here cannot change the value. The catalog map is replaced on every registration, so
      // one environment connecting recomputes every other environment's presentation; and
      // the supervisor state carries `stage`, `generation`, `retryAt`, `desired` and
      // `network`, none of which `presentConnectionState` reads - `stage` alone advances
      // twice per connect attempt. Each of those used to hand consumers a fresh object and
      // re-render them, and to defeat `presentationsAtom`'s identity check below.
      Atom.withEquality<EnvironmentPresentation | null>(presentationsEqual),
      Atom.withLabel(`environment-presentation:${environmentId}`),
    ),
  );

  let previous: ReadonlyMap<EnvironmentId, EnvironmentPresentation> = new Map();
  const presentationsAtom = Atom.make((get) => {
    const next = new Map<EnvironmentId, EnvironmentPresentation>();
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const presentation = get(presentationAtom(environmentId));
      if (presentation !== null) {
        next.set(environmentId, presentation);
      }
    }
    if (mapsEqual(previous, next)) {
      return previous;
    }
    previous = next;
    return previous;
  }).pipe(Atom.withLabel("environment-presentations"));

  return {
    presentationAtom,
    presentationsAtom,
  };
}
