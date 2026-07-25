import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Environment atoms for the local-model manager. `samples` is a subscription-atom
 * family over the `subscribeLlmModels` stream (mirrors host-metrics): the atom holds
 * the latest probe sample and the server probes only while a subscriber is attached,
 * so mounting the atom starts probing and disposing it stops it. `idleTtlMs: 0`
 * disposes promptly on unmount / tab-hide. `load`/`unload` are one-shot command RPCs
 * that spawn / kill the managed process for a model config id.
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
