import type { ActiveTurnComposerAction } from "@t3tools/client-runtime/state/composer-dispatch";

export type FollowUpBehavior = Extract<ActiveTurnComposerAction, "queue" | "steer">;

// FORK-ONLY: queue by default, not upstream's "steer" (fork registry invariant 5).
export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = "queue";
