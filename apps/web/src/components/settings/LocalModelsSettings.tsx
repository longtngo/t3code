import { useMemo, useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import type { LlmModelsSample, LocalModelsSettings as LocalModels } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { cn } from "~/lib/utils";
import { formatBytes } from "~/lib/hostMetrics";
import { type LlmModel, modelStatus, sortByStatus } from "~/lib/llmModels";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useLlmModels } from "~/hooks/useLlmModels";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { ModelMeta, ModelStatusDot } from "../llm/modelPresentation";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  addArg,
  bytesToGb,
  gbToBytes,
  type PerModel,
  removeArgAt,
  removePerModel,
  renamePerModelKey,
  setPerModelArgs,
} from "./LocalModelsSettings.logic";

const DEF = DEFAULT_UNIFIED_SETTINGS.localModels;
const sameArgs = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Removable launch-arg chips + an inline add field. One token = one argv element. */
function ArgsChipEditor(props: {
  args: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean | undefined;
  ariaLabel: string;
}) {
  const { args, onChange, disabled, ariaLabel } = props;
  const [draft, setDraft] = useState("");
  const commitDraft = () => {
    if (draft.trim() === "") return;
    onChange(addArg(args, draft));
    setDraft("");
  };
  // Value-derived keys (disambiguated by occurrence) so duplicate tokens stay unique
  // without keying on the array index.
  const seen = new Map<string, number>();
  const keyedArgs = args.map((arg) => {
    const n = (seen.get(arg) ?? 0) + 1;
    seen.set(arg, n);
    return { arg, key: `${arg}#${n}` };
  });
  return (
    <div
      className={cn(
        "flex min-w-[260px] max-w-[320px] flex-wrap items-center gap-1.5 rounded-lg border border-border bg-input/40 p-1.5",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      {keyedArgs.map(({ arg, key }, i) => (
        <span
          key={key}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]"
        >
          {arg}
          <button
            type="button"
            aria-label={`Remove ${arg}`}
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onChange(removeArgAt(args, i))}
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
      <Input
        aria-label={ariaLabel}
        value={draft}
        disabled={disabled ?? false}
        placeholder="add arg…"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitDraft();
          }
        }}
        className="h-6 w-24 flex-1 border-0 bg-transparent px-1 font-mono text-[11px] shadow-none focus-visible:ring-0"
      />
    </div>
  );
}

/** RAM budget number input, in GB, mapping to/from bytes. `0` = auto (80% of system memory). */
function GbBudgetInput(props: { bytes: number; onCommit: (bytes: number) => void }) {
  return (
    <DraftInput
      type="number"
      min={0}
      step={1}
      inputMode="numeric"
      aria-label="RAM budget in GB"
      className="w-24 text-right tabular-nums"
      value={String(bytesToGb(props.bytes))}
      onCommit={(next) => props.onCommit(gbToBytes(Number(next)))}
    />
  );
}

/** Read-only mirror of the models discovered on disk for one engine. */
function DiscoveredModelsList(props: { engineId: "mlx-serve" | "ds4"; sample: LlmModelsSample | null }) {
  const models = useMemo(() => {
    const provider = props.sample?.providers.find((p) => p.name === props.engineId);
    return provider ? sortByStatus(provider.models) : [];
  }, [props.sample, props.engineId]);
  if (models.length === 0) return null;
  return (
    <div className="space-y-1">
      {models.map((m: LlmModel) => (
        <div key={m.modelId ?? m.id} className="flex items-center gap-2">
          <ModelStatusDot status={modelStatus(m)} />
          <span className="truncate font-mono text-[11px] text-foreground">{m.modelId ?? m.id}</span>
          {m.port != null && modelStatus(m) === "online" ? (
            <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">
              :{m.port}
            </span>
          ) : null}
          <ModelMeta model={m} showEngine={false} />
        </div>
      ))}
    </div>
  );
}

/** Advanced per-model launch-arg overrides for one engine. */
function PerModelOverrides(props: {
  perModel: PerModel;
  onChange: (next: PerModel) => void;
  disabled?: boolean | undefined;
}) {
  const { perModel, onChange, disabled } = props;
  const [newKey, setNewKey] = useState("");
  const entries = Object.entries(perModel);
  const addOverride = () => {
    const key = newKey.trim();
    if (key === "" || perModel[key]) return;
    onChange(setPerModelArgs(perModel, key, []));
    setNewKey("");
  };
  return (
    <details className="group border-t border-border/60">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-3 text-xs text-muted-foreground">
        <span className="transition-transform group-open:rotate-90">▸</span>
        Per-model launch args
        <span className="rounded-full border border-border px-1.5 text-[10px]">advanced</span>
      </summary>
      <div className="space-y-2 pb-3">
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-center gap-2">
            <DraftInput
              aria-label={`Model id for ${key}`}
              value={key}
              disabled={disabled ?? false}
              className="w-44 font-mono text-[11px]"
              onCommit={(next) => {
                const trimmed = next.trim();
                // Ignore blank, unchanged, or collision (renaming onto an existing key
                // would merge and lose an override).
                if (trimmed === "" || trimmed === key || perModel[trimmed]) return;
                onChange(renamePerModelKey(perModel, key, trimmed));
              }}
            />
            <ArgsChipEditor
              ariaLabel={`Args for ${key}`}
              args={value.args ?? []}
              disabled={disabled}
              onChange={(next) => onChange(setPerModelArgs(perModel, key, next))}
            />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove override for ${key}`}
              onClick={() => onChange(removePerModel(perModel, key))}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Input
            aria-label="New per-model override id"
            value={newKey}
            disabled={disabled ?? false}
            placeholder="model id (dir name or *.gguf)…"
            className="w-44 font-mono text-[11px]"
            onChange={(e) => setNewKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addOverride();
              }
            }}
          />
          <Button variant="outline" size="sm" disabled={disabled ?? false} onClick={addOverride}>
            <PlusIcon className="size-3.5" /> Add override
          </Button>
        </div>
      </div>
    </details>
  );
}

export function LocalModelsSettingsPanel() {
  const lm = useSettings((s) => s.localModels);
  const { updateSettings } = useUpdateSettings();
  const environmentId = usePrimaryEnvironmentId();
  const { sample } = useLlmModels(environmentId ?? ("" as never), environmentId != null);

  const patchLm = (next: Partial<LocalModels>) => updateSettings({ localModels: { ...lm, ...next } });
  const patchDs4 = (next: Partial<LocalModels["ds4"]>) =>
    updateSettings({ localModels: { ...lm, ds4: { ...lm.ds4, ...next } } });

  const ds4Disabled = !lm.ds4.enabled;
  const ramUsed = sample?.ramUsedBytes;
  const ramBudget = sample?.ramBudgetBytes;

  return (
    <SettingsPageContainer>
      <div className="px-1">
        <h1 className="text-xl font-semibold tracking-[-0.01em]">Local Models</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Configure the on-device model engines the sidebar’s “Local models” section can load and
          unload. Changes save automatically.
        </p>
      </div>

      {/* Memory budget */}
      <SettingsSection title="Memory budget">
        <SettingsRow
          title="RAM budget"
          description="A model load is refused when it would push total resident memory past this. Shared across all engines."
          status={
            ramBudget ? (
              <>
                Using <b>{formatBytes(ramUsed ?? 0)}</b> of a <b>{formatBytes(ramBudget)}</b> budget.
              </>
            ) : null
          }
          resetAction={
            lm.ramBudgetBytes !== DEF.ramBudgetBytes ? (
              <SettingResetButton
                label="RAM budget"
                onClick={() => patchLm({ ramBudgetBytes: DEF.ramBudgetBytes })}
              />
            ) : null
          }
          control={
            <div className="flex items-center gap-2">
              <GbBudgetInput
                bytes={lm.ramBudgetBytes}
                onCommit={(bytes) => patchLm({ ramBudgetBytes: bytes })}
              />
              <span className="text-xs text-muted-foreground">
                GB · <b>0 = auto</b>
              </span>
            </div>
          }
        />
      </SettingsSection>

      {/* mlx-serve engine */}
      <SettingsSection title="mlx-serve engine">
        <SettingsRow
          title="Models directory"
          description="Scanned for loadable model subdirectories. ~ expands to your home dir."
          resetAction={
            lm.modelsDir !== DEF.modelsDir ? (
              <SettingResetButton
                label="mlx models directory"
                onClick={() => patchLm({ modelsDir: DEF.modelsDir })}
              />
            ) : null
          }
          control={
            <DraftInput
              aria-label="mlx models directory"
              className="w-[280px] font-mono text-xs"
              value={lm.modelsDir}
              onCommit={(next) => patchLm({ modelsDir: next })}
            />
          }
        />
        <SettingsRow
          title="Default launch args"
          description="Passed to every mlx-serve launch. Host, port and --model are added automatically."
          resetAction={
            !sameArgs(lm.defaultArgs, DEF.defaultArgs) ? (
              <SettingResetButton
                label="mlx default args"
                onClick={() => patchLm({ defaultArgs: [...DEF.defaultArgs] })}
              />
            ) : null
          }
          control={
            <ArgsChipEditor
              ariaLabel="mlx default launch args"
              args={lm.defaultArgs}
              onChange={(next) => patchLm({ defaultArgs: next })}
            />
          }
        />
        <SettingsRow title="Models found" description="Discovered on disk; mirrors the sidebar.">
          <div className="pb-3.5">
            <DiscoveredModelsList engineId="mlx-serve" sample={sample} />
          </div>
        </SettingsRow>
        <PerModelOverrides
          perModel={lm.perModel as PerModel}
          onChange={(next) => patchLm({ perModel: next })}
        />
      </SettingsSection>

      {/* ds4 engine */}
      <SettingsSection
        title="DeepSeek V4 engine (ds4)"
        headerAction={
          <Switch
            checked={lm.ds4.enabled}
            onCheckedChange={(checked) => patchDs4({ enabled: Boolean(checked) })}
            aria-label="Enable the ds4 engine"
          />
        }
      >
        <SettingsRow
          title="Server binary"
          description="ds4-server — an OpenAI-compatible server for a single GGUF file. A path is run from its own directory (so it finds its metal/ shaders); a bare name resolves on PATH."
          resetAction={
            lm.ds4.binaryPath !== DEF.ds4.binaryPath ? (
              <SettingResetButton
                label="ds4 binary path"
                onClick={() => patchDs4({ binaryPath: DEF.ds4.binaryPath })}
              />
            ) : null
          }
          control={
            <DraftInput
              aria-label="ds4 server binary path"
              disabled={ds4Disabled}
              className="w-[280px] font-mono text-xs"
              value={lm.ds4.binaryPath}
              onCommit={(next) => patchDs4({ binaryPath: next })}
            />
          }
        />
        <SettingsRow
          title="Models directory"
          description="Globbed for *.gguf model files. ~ expands to your home dir."
          resetAction={
            lm.ds4.modelsDir !== DEF.ds4.modelsDir ? (
              <SettingResetButton
                label="ds4 models directory"
                onClick={() => patchDs4({ modelsDir: DEF.ds4.modelsDir })}
              />
            ) : null
          }
          control={
            <DraftInput
              aria-label="ds4 models directory"
              disabled={ds4Disabled}
              className="w-[280px] font-mono text-xs"
              value={lm.ds4.modelsDir}
              onCommit={(next) => patchDs4({ modelsDir: next })}
            />
          }
        />
        <SettingsRow
          title="Default launch args"
          description="Passed to every ds4-server launch. Host, port and -m are added automatically."
          resetAction={
            !sameArgs(lm.ds4.defaultArgs, DEF.ds4.defaultArgs) ? (
              <SettingResetButton
                label="ds4 default args"
                onClick={() => patchDs4({ defaultArgs: [...DEF.ds4.defaultArgs] })}
              />
            ) : null
          }
          control={
            <ArgsChipEditor
              ariaLabel="ds4 default launch args"
              args={lm.ds4.defaultArgs}
              disabled={ds4Disabled}
              onChange={(next) => patchDs4({ defaultArgs: next })}
            />
          }
        />
        <SettingsRow title="Models found" description="Discovered on disk; mirrors the sidebar.">
          <div className="pb-3.5">
            {ds4Disabled ? (
              <p className="text-[11px] text-muted-foreground/60">Enable the engine to discover models.</p>
            ) : (
              <DiscoveredModelsList engineId="ds4" sample={sample} />
            )}
          </div>
        </SettingsRow>
        <PerModelOverrides
          perModel={lm.ds4.perModel as PerModel}
          disabled={ds4Disabled}
          onChange={(next) => patchDs4({ perModel: next })}
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
