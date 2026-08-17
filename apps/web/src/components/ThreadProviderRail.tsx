import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironment } from "../state/environments";
import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  resolveThreadProviderInstanceId,
  resolveThreadProviderPresentation,
  type ThreadProviderPresentation,
  type ThreadProviderSource,
} from "./threadProviderRail.logic";

type RowThread = ThreadProviderSource & { readonly environmentId: EnvironmentId };

/**
 * The provider a thread row should present, or `undefined` when it should present none.
 *
 * Subscribes to the thread's own environment, so a remote thread resolves against the provider
 * list of the machine actually running it rather than the primary environment's.
 */
function useThreadProvider(thread: RowThread): ThreadProviderPresentation | undefined {
  const environment = useEnvironment(thread.environmentId);
  return resolveThreadProviderPresentation(
    resolveThreadProviderInstanceId(thread),
    environment?.serverConfig?.providers ?? [],
  );
}

/**
 * Permanent per-thread provider indicator: a thin vertical bar pinned to the row's leading edge,
 * filled with the provider instance's accent colour.
 *
 * Absolutely positioned so it costs no horizontal space and no row content shifts to make room —
 * the row it sits in supplies the positioning context.
 *
 * The `inset-y-1.5` is load-bearing, not spacing taste: every row surface is `rounded-md` (a 6px
 * radius) and the v2 rows additionally clip with `overflow-hidden`, so a rail inset by less than
 * the radius gets its ends eaten by the corner curve. 6px is the smallest inset that clears it on
 * all three surfaces, which is why one value serves them all.
 *
 * Renders nothing when the provider has no usable accent — a neutral bar on those rows would be
 * visual weight carrying no information.
 */
export function ThreadProviderRail({
  thread,
  className,
}: {
  thread: RowThread;
  className?: string;
}) {
  const presentation = useThreadProvider(thread);
  if (!presentation) return null;

  return (
    <span
      // Purely presentational within the row's own click target: it must never swallow a click,
      // a drag, or a context menu aimed at the row.
      className={cn(
        "pointer-events-none absolute inset-y-1.5 left-0 w-[2.5px] rounded-full",
        className,
      )}
      style={{ backgroundColor: presentation.accentColor }}
      role="img"
      aria-label={`Provider: ${presentation.displayName}`}
      data-provider-instance={resolveThreadProviderInstanceId(thread)}
    />
  );
}

/**
 * Monogram shown beside the title *only* on rows whose provider accent is shared with another
 * configured instance — the rows where the rail's colour cannot decide on its own.
 *
 * Deliberately conditional: an always-present chip was rejected as too busy, and on a typical
 * configuration almost every accent is unique, so this renders on a small minority of rows.
 * The rail carries the identity everywhere; this only breaks ties.
 */
export function ThreadProviderChip({
  thread,
  className,
}: {
  thread: RowThread;
  className?: string;
}) {
  const presentation = useThreadProvider(thread);
  if (!presentation?.initials) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "shrink-0 rounded px-1 py-px text-[8.5px] font-bold tracking-wide tabular-nums",
              className,
            )}
            style={{
              // Tinted from the accent rather than filled with it: at this size a solid fill would
              // out-shout the rail it is only meant to annotate.
              backgroundColor: `${presentation.accentColor}26`,
              color: presentation.accentColor,
            }}
            aria-hidden="true"
          />
        }
      >
        {presentation.initials}
      </TooltipTrigger>
      <TooltipPopup>{presentation.displayName}</TooltipPopup>
    </Tooltip>
  );
}
