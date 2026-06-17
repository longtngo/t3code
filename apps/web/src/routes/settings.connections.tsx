import { lazy, Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";

const ConnectionsSettings = lazy(() =>
  import("../components/settings/ConnectionsSettings").then((m) => ({
    default: m.ConnectionsSettings,
  })),
);

export const Route = createFileRoute("/settings/connections")({
  component: () => (
    <Suspense fallback={null}>
      <ConnectionsSettings />
    </Suspense>
  ),
});
