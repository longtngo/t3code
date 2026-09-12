import { createThreadPlanHistoryEnvironmentAtoms } from "@t3tools/client-runtime/state/thread-plan-history";

import { connectionAtomRuntime } from "../connection/runtime";

export const threadPlanHistoryEnvironment =
  createThreadPlanHistoryEnvironmentAtoms(connectionAtomRuntime);
