import { lazy, Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";

const SourceControlSettingsPanel = lazy(() =>
  import("../components/settings/SourceControlSettings").then((m) => ({
    default: m.SourceControlSettingsPanel,
  })),
);

export const Route = createFileRoute("/settings/source-control")({
  component: () => (
    <Suspense fallback={null}>
      <SourceControlSettingsPanel />
    </Suspense>
  ),
});
