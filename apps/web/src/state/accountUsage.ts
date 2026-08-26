import { createAccountUsageEnvironmentAtoms } from "@t3tools/client-runtime/state/account-usage";

import { connectionAtomRuntime } from "../connection/runtime";

export const accountUsageEnvironment = createAccountUsageEnvironmentAtoms(connectionAtomRuntime);
