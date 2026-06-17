import { lazy, Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";

const ArchivedThreadsPanel = lazy(() =>
  import("../components/settings/SettingsPanels").then((m) => ({ default: m.ArchivedThreadsPanel })),
);

export const Route = createFileRoute("/settings/archived")({
  component: () => (
    <Suspense fallback={null}>
      <ArchivedThreadsPanel />
    </Suspense>
  ),
});
