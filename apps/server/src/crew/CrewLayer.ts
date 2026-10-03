/**
 * Crew's runtime services, composed once: the repository and log every crew service shares,
 * the caller-scoped `CrewService` the MCP tools use, the operator-scoped `CrewDirectory` the
 * panel uses, and the delivery sweep `ServerRuntimeStartup` starts.
 *
 * One composition so the MCP toolkit, the RPCs and the sweep see one repository over one
 * database and one log sink. `crewWiring.test.ts` asserts that production composes it and
 * starts the sweep, because a unit test that provides a layer passes whether or not the
 * server does.
 *
 * @module crew/CrewLayer
 */
import * as Layer from "effect/Layer";

import { CrewDirectoryLive } from "./CrewDirectory.ts";
import { CrewLogLive } from "./CrewLog.ts";
import { CrewRepositoryLive } from "./CrewRepository.ts";
import { CrewRolesLive } from "./CrewRoles.ts";
import { CrewServiceLive } from "./CrewService.ts";
import { CrewSweepLive } from "./CrewSweep.ts";

export const CrewLayerLive = Layer.mergeAll(
  CrewServiceLive(),
  CrewDirectoryLive,
  CrewSweepLive,
  CrewRolesLive,
).pipe(Layer.provideMerge(Layer.mergeAll(CrewRepositoryLive, CrewLogLive)));
