import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironment } from "../state/environments";
import { cn } from "../lib/utils";
import {
  resolveThreadProviderInstanceId,
  resolveThreadProviderPresentation,
  type ThreadProviderSource,
} from "./threadProviderRail.logic";

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
  thread: ThreadProviderSource & { readonly environmentId: EnvironmentId };
  className?: string;
}) {
  const environment = useEnvironment(thread.environmentId);
  const instanceId = resolveThreadProviderInstanceId(thread);
  const presentation = resolveThreadProviderPresentation(
    instanceId,
    environment?.serverConfig?.providers ?? [],
  );

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
      data-provider-instance={instanceId}
    />
  );
}
