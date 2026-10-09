import {
  ACTIVE_SLOTS_HINT,
  ActiveSlotsField,
  NO_PROVIDERS,
  PER_PROVIDER_HINT,
  ProviderSlotsField,
  useQueueSlots,
} from "../QueueSlotsControl";
import { useSetQueueSlots } from "../../queueSlotSettings";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const ACTIVE_SLOTS_ANCHOR = searchableSetting("queue-slots").id;

/**
 * The queue's slot settings. Rows deliberately set neither `serverScoped` nor `settingKeys`: the
 * control must keep working with no primary environment, where the store holds the value locally.
 * The rows gate on the primary's `settings:write` grant themselves, because `serverScoped` checks
 * the settings scope's environments, not the primary. They also stay editable while the primary
 * has no queue value yet (see `useQueueSlotsAccess`).
 */
export function QueueSettingsView(props: ReturnType<typeof useQueueSlots>) {
  const { slots, perProvider, providerSlots, instances, writable, notice } = props;
  const setQueueSlots = useSetQueueSlots();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Queue">
        {perProvider ? null : (
          <SettingsRow
            {...searchableSetting("queue-slots")}
            description={ACTIVE_SLOTS_HINT}
            control={<ActiveSlotsField value={slots} disabled={!writable} />}
          />
        )}
        <SettingsRow
          {...searchableSetting("queue-per-provider")}
          status={notice ?? undefined}
          description={
            perProvider
              ? PER_PROVIDER_HINT
              : "Give each provider its own number. 0 holds that provider's queued threads."
          }
          control={
            <Switch
              checked={perProvider}
              onCheckedChange={(value) => void setQueueSlots({ perProvider: value })}
              aria-label="Per provider"
              disabled={!writable}
            />
          }
        />
        {/* In per-provider mode the provider counts are the active slots, so the Active slots
            search result lands on the first of them. */}
        {perProvider && instances.length === 0 ? (
          <SettingsRow id={ACTIVE_SLOTS_ANCHOR} title={NO_PROVIDERS} />
        ) : null}
        {perProvider
          ? instances.map((i, index) => (
              <SettingsRow
                key={i.instanceId}
                id={index === 0 ? ACTIVE_SLOTS_ANCHOR : undefined}
                title={i.label}
                control={
                  <ProviderSlotsField
                    label={i.label}
                    instanceId={i.instanceId}
                    providerSlots={providerSlots}
                    disabled={!writable}
                  />
                }
              />
            ))
          : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function QueueSettingsPanel() {
  return <QueueSettingsView {...useQueueSlots()} />;
}
