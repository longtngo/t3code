import { lazy, Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";

const ProviderSettingsPanel = lazy(() =>
  import("../components/settings/SettingsPanels").then((m) => ({ default: m.ProviderSettingsPanel })),
);

export const Route = createFileRoute("/settings/providers")({
  component: () => (
    <Suspense fallback={null}>
      <ProviderSettingsPanel />
    </Suspense>
  ),
});
