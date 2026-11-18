import type { StopRung } from "@t3tools/client-runtime/state/stop-ladder";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

/**
 * FORK Stop ladder: how a Stop button reads on each rung. The armed and
 * force-stopping rungs swap the square for an octagon (shape, not colour: the
 * button is already red) and say what the press does. No animation.
 */
export function stopRungPresentation(
  rung: StopRung,
  idleLabel: string,
  resolve: MessageResolver = m,
) {
  switch (rung) {
    case "armed":
      return {
        label: resolve(msg("Force stop the provider session")),
        icon: "xmark.octagon.fill",
      } as const;
    case "forceStopping":
      return {
        label: resolve(msg("Force-stopping the provider session")),
        icon: "xmark.octagon.fill",
      } as const;
    case "idle":
      return { label: idleLabel, icon: "stop.fill" } as const;
  }
}
