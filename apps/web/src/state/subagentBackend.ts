import { createSubagentBackendEnvironmentAtoms } from "@t3tools/client-runtime/state/subagent-backend";

import { connectionAtomRuntime } from "../connection/runtime";

export const subagentBackendEnvironment =
  createSubagentBackendEnvironmentAtoms(connectionAtomRuntime);
