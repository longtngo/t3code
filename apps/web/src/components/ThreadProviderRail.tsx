import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentProviders } from "../state/environments";
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
  const providersByEnvironment = useEnvironmentProviders();
  return resolveThreadProviderPresentation(
    resolveThreadProviderInstanceId(thread),
    providersByEnvironment.get(thread.environmentId) ?? [],
  );
}

/**
 * Permanent per-thread provider bar on the row's leading edge in the instance's accent colour,
 * absolutely positioned so nothing shifts. `inset-y-1.5` is load-bearing: rows are `rounded-md`
 * (6px) and v2 rows clip, so a smaller inset loses the bar's ends to the corner. Renders
 * nothing without a usable accent.
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
 * Monogram beside the title only on rows whose accent is shared with another configured
 * instance, where the rail's colour cannot decide alone. Always-on was rejected as too busy.
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
              "shrink-0 rounded px-1 py-px text-3xs font-bold tracking-wide tabular-nums",
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
