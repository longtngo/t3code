import { lazy, Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";

const DiagnosticsSettingsPanel = lazy(() =>
  import("../components/settings/DiagnosticsSettings").then((m) => ({
    default: m.DiagnosticsSettingsPanel,
  })),
);

export const Route = createFileRoute("/settings/diagnostics")({
  component: () => (
    <Suspense fallback={null}>
      <DiagnosticsSettingsPanel />
    </Suspense>
  ),
});
