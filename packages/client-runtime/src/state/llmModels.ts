import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * `samples` subscribes to `subscribeLlmModels` (like host metrics): the server probes only while
 * subscribed, and `idleTtlMs: 0` stops it promptly on unmount or tab-hide. `load`/`unload` are
 * one-shot commands that spawn or kill the managed process for a model config id.
 */
export function createLlmModelsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    samples: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:llm-models:samples",
      tag: WS_METHODS.subscribeLlmModels,
      idleTtlMs: 0,
    }),
    load: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:llm-models:load",
      tag: WS_METHODS.llmServeLoad,
    }),
    unload: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:llm-models:unload",
      tag: WS_METHODS.llmServeUnload,
    }),
  };
}
