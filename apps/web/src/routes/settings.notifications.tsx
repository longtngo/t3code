import { createFileRoute } from "@tanstack/react-router";

import { NotificationsSettingsPanel } from "../components/settings/NotificationsSettings";

export const Route = createFileRoute("/settings/notifications")({
  component: NotificationsSettingsPanel,
});
