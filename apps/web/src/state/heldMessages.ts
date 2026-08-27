import { createHeldMessageEnvironmentAtoms } from "@t3tools/client-runtime/state/held-messages";

import { connectionAtomRuntime } from "../connection/runtime";

export const heldMessageEnvironment = createHeldMessageEnvironmentAtoms(connectionAtomRuntime);
