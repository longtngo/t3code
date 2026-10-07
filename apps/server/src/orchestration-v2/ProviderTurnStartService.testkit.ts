import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { CreditSpendGuard } from "../provider/Services/CreditSpendGuard.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";

/** `resumeCheck` for a gate mock whose answers are always conclusive. */
export const conclusiveResumeCheck =
  (refusalFor: (instanceId: ProviderInstanceId) => Effect.Effect<string | null>) =>
  (instanceId: ProviderInstanceId) =>
    refusalFor(instanceId).pipe(Effect.map((refusal) => ({ refusal, inconclusive: false })));

/** The credit gate with spending allowed, for harnesses that do not test it. */
export const creditSpendGuardAllowAll = Layer.succeed(
  CreditSpendGuard,
  CreditSpendGuard.of({
    refusalFor: () => Effect.succeed(null),
    cachedRefusalFor: () => Effect.succeed(null),
    resumeCheck: () => Effect.succeed({ refusal: null, inconclusive: false }),
  }),
);

/** The client intake's credit gate with spending allowed and no prior receipts. */
export const creditSpendIntakeAllowAll = Layer.merge(
  creditSpendGuardAllowAll,
  Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
    getByCommandId: () => Effect.succeedNone,
  }),
);

/** Turn-start dependencies a harness does not exercise: worktree repair and the credit gate. */
export const layer = Layer.mergeAll(
  Layer.mock(GitWorkflow.GitWorkflowService)({
    pruneWorktrees: () => Effect.void,
    createWorktree: () => Effect.succeed({} as never),
  }),
  Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeedNone,
  }),
  creditSpendGuardAllowAll,
);
