import { lazy, Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";

// The route path stays /settings/local-models (stable URL); the tab is now "Local LLM".
const LocalLlmSettingsPanel = lazy(() =>
  import("../components/settings/localLlm/LocalLlmSettings").then((m) => ({
    default: m.LocalLlmSettingsPanel,
  })),
);

export const Route = createFileRoute("/settings/local-models")({
  component: () => (
    <Suspense fallback={null}>
      <LocalLlmSettingsPanel />
    </Suspense>
  ),
});
