import { createThreadBackgroundTasksEnvironmentAtoms } from "@t3tools/client-runtime/state/thread-background-tasks";

import { connectionAtomRuntime } from "../connection/runtime";

export const threadBackgroundTasksEnvironment =
  createThreadBackgroundTasksEnvironmentAtoms(connectionAtomRuntime);
