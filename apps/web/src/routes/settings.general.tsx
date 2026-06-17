import { lazy, Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";

const GeneralSettingsPanel = lazy(() =>
  import("../components/settings/SettingsPanels").then((m) => ({ default: m.GeneralSettingsPanel })),
);

export const Route = createFileRoute("/settings/general")({
  component: () => (
    <Suspense fallback={null}>
      <GeneralSettingsPanel />
    </Suspense>
  ),
});
