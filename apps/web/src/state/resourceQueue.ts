import { createResourceQueueEnvironmentAtoms } from "@t3tools/client-runtime/state/resource-queue";

import { connectionAtomRuntime } from "../connection/runtime";

export const resourceQueueEnvironment =
  createResourceQueueEnvironmentAtoms(connectionAtomRuntime);
