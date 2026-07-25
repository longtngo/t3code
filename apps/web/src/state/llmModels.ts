import { createLlmModelsEnvironmentAtoms } from "@t3tools/client-runtime/state/llm-models";

import { connectionAtomRuntime } from "../connection/runtime";

export const llmModelsEnvironment = createLlmModelsEnvironmentAtoms(connectionAtomRuntime);
