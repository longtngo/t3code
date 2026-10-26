/**
 * A process-unique id minted at startup: the boot fence for background-task recovery. A
 * `pending_background_tasks` row with a different `bootId` belongs to a dead process. An
 * explicit id avoids the clock-skew and ordering races of comparing timestamps.
 */
import * as Context from "effect/Context";

export interface RuntimeBootIdShape {
  readonly bootId: string;
}

export class RuntimeBootId extends Context.Service<RuntimeBootId, RuntimeBootIdShape>()(
  "t3/environment/Services/RuntimeBootId",
) {}
