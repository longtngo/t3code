import { lazy, Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";

const LocalModelsSettingsPanel = lazy(() =>
  import("../components/settings/LocalModelsSettings").then((m) => ({
    default: m.LocalModelsSettingsPanel,
  })),
);

export const Route = createFileRoute("/settings/local-models")({
  component: () => (
    <Suspense fallback={null}>
      <LocalModelsSettingsPanel />
    </Suspense>
  ),
});
