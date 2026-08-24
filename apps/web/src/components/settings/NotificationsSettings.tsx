import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useState } from "react";

import { DEFAULT_UNIFIED_SETTINGS, NOTIFICATION_CATEGORIES } from "@t3tools/contracts";

import { isElectron } from "../../env";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { ensureWebNotificationPermission } from "../../lib/notifier";
import {
  hasValidPushSubscription,
  isWebPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
} from "../../lib/webPush";
import { primaryServerConfigAtom, serverEnvironment } from "../../state/server";
import { usePrimaryEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
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
 * Owns every notification control: the two delivery switches (a per-browser
 * foreground toggle and a per-device Web Push toggle) and the per-category
 * switches that gate what either of them is allowed to raise.
 *
 * The category rows deliberately render regardless of `pushAvailable`. That gate
 * exists because the Web Push master switch is meaningless without a service
 * worker and a VAPID key, but the categories also gate the foreground notifier —
 * which is exactly the desktop path — so hiding them there would leave desktop
 * with no control at all.
 */
export function NotificationsSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  // Per-device Web Push toggle. Push works only in the deployed web PWA (a service
  // worker + secure context) — never Electron or dev — and needs a server VAPID key.
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const vapidPublicKey = serverConfig?.webPushVapidPublicKey ?? null;
  const pushAvailable =
    !isElectron && import.meta.env.PROD && isWebPushSupported() && vapidPublicKey !== null;
  const pushRegister = useAtomCommand(serverEnvironment.pushSubscriptionsRegister, {
    reportFailure: false,
  });

  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => {
    if (!pushAvailable || !vapidPublicKey) {
      return;
    }
    let cancelled = false;
    void hasValidPushSubscription(vapidPublicKey).then((enabled) => {
      if (!cancelled) {
        setPushEnabled(enabled);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pushAvailable, vapidPublicKey]);

  const handlePushEnabledChange = useCallback(
    async (checked: boolean) => {
      if (pushBusy || !vapidPublicKey) {
        return;
      }
      setPushBusy(true);
      try {
        if (!checked) {
          await unsubscribeFromPush();
          setPushEnabled(false);
          return;
        }
        const permission = await ensureWebNotificationPermission();
        if (permission !== "granted") {
          setPushEnabled(false);
          return;
        }
        const subscription = await subscribeToPush(vapidPublicKey);
        if (!subscription || !primaryEnvironmentId) {
          setPushEnabled(false);
          return;
        }
        const result = await pushRegister({
          environmentId: primaryEnvironmentId,
          input: { subscription },
        });
        if (result._tag === "Failure") {
          setPushEnabled(false);
          return;
        }
        setPushEnabled(result.value.ok === true);
      } catch {
        setPushEnabled(false);
      } finally {
        setPushBusy(false);
      }
    },
    [pushBusy, vapidPublicKey, primaryEnvironmentId, pushRegister],
  );

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

        {pushAvailable ? (
          <SettingsRow
            {...searchableSetting("background-notifications")}
            description="Get a notification when a task finishes or needs your input, even with the app closed or the screen off. Works on this device only."
            control={
              <Switch
                checked={pushEnabled}
                disabled={pushBusy}
                onCheckedChange={(checked) => {
                  void handlePushEnabledChange(Boolean(checked));
                }}
                aria-label="Enable background notifications on this device"
              />
            }
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title="What to notify me about">
        <p className="px-3 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
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
