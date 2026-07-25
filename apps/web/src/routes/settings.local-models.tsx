import { createFileRoute } from "@tanstack/react-router";

import { LocalLlmSettingsPanel } from "../components/settings/localLlm/LocalLlmSettings";

function SettingsLocalModelsRoute() {
  return <LocalLlmSettingsPanel />;
}

export const Route = createFileRoute("/settings/local-models")({
  component: SettingsLocalModelsRoute,
});
