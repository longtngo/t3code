import { useCallback } from "react";

import { DEFAULT_UNIFIED_SETTINGS, NOTIFICATION_CATEGORIES } from "@t3tools/contracts";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { ensureWebNotificationPermission } from "../../lib/notifier";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Settings → Notifications.
 *
 * Owns every notification control: the per-browser foreground delivery switch
 * and the per-category switches that gate what it is allowed to raise. The
 * per-device Web Push switch returns with the web push port (U9).
 */
export function NotificationsSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  // Enabling requires a gesture-bound OS permission prompt; only persist the
  // preference once permission is granted so the toggle reflects reality.
  const handleNotifyOnThreadCompletionChange = useCallback(
    async (checked: boolean) => {
      if (!checked) {
        updateSettings({ notifyOnThreadCompletion: false });
        return;
      }
      const permission = await ensureWebNotificationPermission();
      updateSettings({ notifyOnThreadCompletion: permission === "granted" });
    },
    [updateSettings],
  );

  const categories = settings.notificationCategories;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Delivery">
        <SettingsRow
          {...searchableSetting("task-completion-notifications")}
          description="Show a system notification when a task finishes and you're not viewing it."
          resetAction={
            settings.notifyOnThreadCompletion !==
            DEFAULT_UNIFIED_SETTINGS.notifyOnThreadCompletion ? (
              <SettingResetButton
                label="task completion notifications"
                onClick={() =>
                  updateSettings({
                    notifyOnThreadCompletion: DEFAULT_UNIFIED_SETTINGS.notifyOnThreadCompletion,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.notifyOnThreadCompletion}
              onCheckedChange={(checked) => {
                void handleNotifyOnThreadCompletionChange(Boolean(checked));
              }}
              aria-label="Notify when a task finishes"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="What to notify me about">
        <p className="px-3 text-xs leading-normal text-muted-foreground/80 sm:px-4">
          These apply to every device connected to this environment. The switches above are
          per-device: they control whether this browser receives anything at all.
        </p>
        {NOTIFICATION_CATEGORIES.map((category) => (
          <SettingsRow
            key={category.key}
            {...searchableSetting(`notify-${category.key}`)}
            description={category.description}
            control={
              <Switch
                checked={categories[category.key]}
                onCheckedChange={(checked) =>
                  updateSettings({
                    notificationCategories: { [category.key]: Boolean(checked) },
                  })
                }
                aria-label={category.label}
              />
            }
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
