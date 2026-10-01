import { createFileRoute } from "@tanstack/react-router";

import { QueueSettingsPanel } from "../components/settings/QueueSettings";

export const Route = createFileRoute("/settings/queue")({
  component: QueueSettingsPanel,
});
