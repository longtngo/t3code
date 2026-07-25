import { createHostMetricsEnvironmentAtoms } from "@t3tools/client-runtime/state/host-metrics";

import { connectionAtomRuntime } from "../connection/runtime";

export const hostMetricsEnvironment = createHostMetricsEnvironmentAtoms(connectionAtomRuntime);
