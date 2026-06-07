/**
 * RuntimeBootId - a process-unique identifier minted once at server startup.
 *
 * Used as the boot fence for background-task recovery: a persisted
 * `pending_background_tasks` row is stamped with the `bootId` of the process
 * that observed the task. After a restart the new process has a fresh `bootId`,
 * so any row whose `bootId` differs is owned by a now-dead process and is
 * therefore an orphaned task to recover. Using an explicit per-boot id (rather
 * than comparing timestamps to a captured boot time) avoids clock-skew and
 * startup-ordering races.
 */
import * as Context from "effect/Context";

export interface RuntimeBootIdShape {
  readonly bootId: string;
}

export class RuntimeBootId extends Context.Service<RuntimeBootId, RuntimeBootIdShape>()(
  "t3/environment/Services/RuntimeBootId",
) {}
