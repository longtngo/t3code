import { lazy, Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";

const KeybindingsSettingsPanel = lazy(() =>
  import("../components/settings/KeybindingsSettings").then((m) => ({
    default: m.KeybindingsSettingsPanel,
  })),
);

export const Route = createFileRoute("/settings/keybindings")({
  component: () => (
    <Suspense fallback={null}>
      <KeybindingsSettingsPanel />
    </Suspense>
  ),
});
