import { createCrewEnvironmentAtoms } from "@t3tools/client-runtime/state/crew";

import { connectionAtomRuntime } from "../connection/runtime";

export const crewEnvironment = createCrewEnvironmentAtoms(connectionAtomRuntime);
