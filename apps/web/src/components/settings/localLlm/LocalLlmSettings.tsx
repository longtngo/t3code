import { useEffect, useState } from "react";
import { ChevronRightIcon, EyeIcon, EyeOffIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { LocalLlmModelConfig, LocalLlmProviderConfig, LocalLlmSettings } from "@t3tools/contracts";
import {
  LOCAL_LLM_PROVIDERS,
  type ProviderCatalogEntry,
  compatibleModels,
  getModel,
  getProvider,
} from "@t3tools/shared/localLlm";
import { cn } from "~/lib/utils";
import { formatContext } from "~/lib/llmModels";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { ArgPickerMenu } from "../../llm/ArgPickerMenu";
import {
  clampContext,
  newModelConfig,
  onModelChange,
  onProviderChange,
  providerDefaultArgs,
  visibleProviders,
} from "./modelConfig.logic";
import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { DraftInput } from "../../ui/draft-input";
import { Input } from "../../ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { SettingsPageContainer, SettingsSection } from "../settingsLayout";

const GB = 1024 ** 3;
const bytesToGb = (b: number) => (b > 0 ? Math.round((b / GB) * 10) / 10 : 0);
const gbToBytes = (gb: number) => (gb > 0 ? Math.round(gb * GB) : 0);

function EyeToggle(props: { on: boolean; onToggle: () => void; title: string }) {
  return (
    <button
      type="button"
      title={props.title}
      onClick={(e) => {
        e.stopPropagation();
        props.onToggle();
      }}
      className={cn(
        "rounded-md p-1 transition-colors",
        props.on ? "text-primary" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {props.on ? <EyeIcon className="size-4" /> : <EyeOffIcon className="size-4" />}
    </button>
  );
}

function ProviderCard(props: {
  provider: ProviderCatalogEntry;
  config: LocalLlmProviderConfig;
  onChange: (next: LocalLlmProviderConfig) => void;
}) {
  const { provider, config } = props;
  const [open, setOpen] = useState(false);
  const patch = (p: Partial<LocalLlmProviderConfig>) => props.onChange({ ...config, ...p });

  return (
    <div className={cn("rounded-xl border border-border bg-card", !config.visible && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          className="flex flex-1 items-center gap-2 text-left"
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRightIcon className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className="font-medium">{provider.name}</span>
        </button>
        <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
          {provider.format}
        </span>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[11px]",
            provider.managed
              ? "border-emerald-600/40 text-emerald-500"
              : "border-amber-600/40 text-amber-500",
          )}
        >
          {provider.managed ? "managed" : "external"}
        </span>
        <span className="text-[12px] text-muted-foreground">:{config.port ?? provider.defaultPort}</span>
        <EyeToggle
          on={config.visible}
          onToggle={() => patch({ visible: !config.visible })}
          title={config.visible ? "Visible in pickers — click to hide" : "Hidden from pickers — click to show"}
        />
      </div>
      {open ? (
        <div className="space-y-3 border-t border-border px-3 py-3">
          <p className="text-[12px] text-muted-foreground">{provider.note}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-[12px]">
              <span className="mb-1 block text-muted-foreground">Host</span>
              <DraftInput value={config.host ?? provider.host} onCommit={(v) => patch({ host: v })} />
            </label>
            <label className="block text-[12px]">
              <span className="mb-1 block text-muted-foreground">Default port</span>
              <DraftInput
                value={String(config.port ?? provider.defaultPort)}
                onCommit={(v) => patch({ port: Number(v) || provider.defaultPort })}
              />
            </label>
          </div>
          {provider.managed ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-[12px]">
                <span className="mb-1 block text-muted-foreground">Binary path</span>
                <DraftInput
                  value={config.binaryPath ?? provider.binaryPath ?? ""}
                  onCommit={(v) => patch({ binaryPath: v })}
                />
              </label>
              <label className="block text-[12px]">
                <span className="mb-1 block text-muted-foreground">Models directory</span>
                <DraftInput
                  value={config.modelsDir ?? provider.modelsDir ?? ""}
                  onCommit={(v) => patch({ modelsDir: v })}
                />
              </label>
            </div>
          ) : (
            <label className="block text-[12px]">
              <span className="mb-1 block text-muted-foreground">Base URL</span>
              <DraftInput
                value={config.baseUrl ?? `http://${config.host ?? provider.host}:${config.port ?? provider.defaultPort}`}
                onCommit={(v) => patch({ baseUrl: v })}
              />
            </label>
          )}
          <div className="text-[12px]">
            <span className="mb-1 block text-muted-foreground">Default launch args (runbook recommendation)</span>
            <ArgPickerMenu
              providerId={provider.id}
              value={config.defaultArgs ?? provider.defaultArgs}
              onChange={(next) => patch({ defaultArgs: next })}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ModelConfigCard(props: {
  config: LocalLlmModelConfig;
  settings: LocalLlmSettings;
  onChange: (next: LocalLlmModelConfig) => void;
  onDelete: () => void;
}) {
  const { config, settings } = props;
  const [open, setOpen] = useState(false);
  // Buffer the context slider during a drag so we issue one settings write on release,
  // not one per drag tick. Reset the draft if the model/provider changes mid-drag so a
  // stale value can't be committed to the wrong model.
  const [ctxDraft, setCtxDraft] = useState<number | null>(null);
  useEffect(() => setCtxDraft(null), [config.modelId, config.providerId]);
  const model = getModel(config.modelId);
  const provider = getProvider(config.providerId);
  const compat = compatibleModels(config.providerId);
  const maxCtx = model?.maxContext ?? 163840;
  const ctx = ctxDraft ?? config.contextWindow ?? maxCtx;
  const patch = (p: Partial<LocalLlmModelConfig>) => props.onChange({ ...config, ...p });
  const commitCtx = () => {
    if (ctxDraft != null) {
      patch({ contextWindow: ctxDraft });
      setCtxDraft(null);
    }
  };

  const providerItems = visibleProviders(settings, config.providerId).map((p) => ({
    value: p.id,
    label: p.name,
  }));
  const modelItems = compat.map((m) => ({ value: m.id, label: m.name }));

  return (
    <div className={cn("rounded-xl border border-border bg-card", !config.visible && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          className="flex flex-1 items-center gap-2 text-left"
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRightIcon className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className="font-medium">{config.name || "Untitled"}</span>
        </button>
        {model ? (
          <>
            {model.quant ? (
              <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                {model.quant}
              </span>
            ) : null}
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              {formatContext(ctx)} ctx
            </span>
          </>
        ) : null}
        <span className="text-[12px] text-muted-foreground">{provider?.name ?? config.providerId}</span>
        <EyeToggle
          on={config.visible}
          onToggle={() => patch({ visible: !config.visible })}
          title={config.visible ? "Shown in sidebar — click to hide" : "Hidden from sidebar — click to show"}
        />
      </div>
      {open ? (
        <div className="space-y-3 border-t border-border px-3 py-3">
          <label className="block text-[12px]">
            <span className="mb-1 block text-muted-foreground">Name</span>
            <DraftInput value={config.name} onCommit={(v) => patch({ name: v })} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-[12px]">
              <span className="mb-1 block text-muted-foreground">① Provider</span>
              <Select
                value={config.providerId}
                onValueChange={(v) => props.onChange(onProviderChange(config, v as string))}
                items={providerItems}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {providerItems.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
            <label className="block text-[12px]">
              <span className="mb-1 block text-muted-foreground">② Compatible model</span>
              <Select
                value={config.modelId}
                onValueChange={(v) => props.onChange(onModelChange(config, v as string))}
                items={modelItems}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={modelItems.length === 0 ? "No compatible models" : undefined} />
                </SelectTrigger>
                <SelectPopup>
                  {modelItems.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
          </div>
          <div className="text-[12px]">
            <div className="mb-1 flex items-center justify-between text-muted-foreground">
              <span>Context window</span>
              <span className="font-mono text-primary">{formatContext(ctx)}</span>
            </div>
            <input
              type="range"
              min={4096}
              max={maxCtx}
              step={4096}
              value={ctx}
              onChange={(e) => setCtxDraft(clampContext(Number(e.currentTarget.value), config.modelId))}
              onPointerUp={commitCtx}
              onKeyUp={commitCtx}
              onBlur={commitCtx}
              className="w-full accent-primary"
            />
            <div className="mt-0.5 text-[11px] text-muted-foreground/70">max {formatContext(maxCtx)}</div>
          </div>

          <Collapsible>
            <CollapsibleTrigger className="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground">
              <ChevronRightIcon className="size-3.5" />
              Advanced — provider config overrides
            </CollapsibleTrigger>
            <CollapsiblePanel className="space-y-3 pt-2">
              <div className="text-[12px]">
                <span className="mb-1 block text-muted-foreground">
                  Launch args override (provider default:{" "}
                  {providerDefaultArgs(settings, config.providerId).join("  ") || "none"})
                </span>
                <ArgPickerMenu
                  providerId={config.providerId}
                  value={config.argsOverride ?? []}
                  onChange={(next) => patch({ argsOverride: next })}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-[12px]">
                  <span className="mb-1 block text-muted-foreground">Port override</span>
                  <DraftInput
                    value={config.port != null ? String(config.port) : ""}
                    onCommit={(v) => patch({ port: v.trim() === "" ? undefined : Number(v) || undefined })}
                  />
                </label>
                <label className="block text-[12px]">
                  <span className="mb-1 block text-muted-foreground">Model path override</span>
                  <DraftInput
                    value={config.modelPathOverride ?? ""}
                    onCommit={(v) => patch({ modelPathOverride: v.trim() === "" ? undefined : v })}
                  />
                </label>
              </div>
            </CollapsiblePanel>
          </Collapsible>

          <div>
            <Button variant="destructive-outline" size="sm" onClick={props.onDelete}>
              <Trash2Icon className="size-3.5" /> Delete config
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function LocalLlmSettingsPanel() {
  const lm = useSettings((s) => s.localLlm);
  const { updateSettings } = useUpdateSettings();

  const save = (next: LocalLlmSettings) => updateSettings({ localLlm: next });
  const updateProvider = (id: string, next: LocalLlmProviderConfig) =>
    save({ ...lm, providers: { ...lm.providers, [id]: next } });
  const updateModel = (id: string, next: LocalLlmModelConfig) =>
    save({ ...lm, models: lm.models.map((m) => (m.id === id ? next : m)) });
  const deleteModel = (id: string) => save({ ...lm, models: lm.models.filter((m) => m.id !== id) });
  const addModel = () => save({ ...lm, models: [...lm.models, newModelConfig(lm)] });

  return (
    <SettingsPageContainer>
      <SettingsSection title="Memory budget">
        <label className="block px-3 py-2 text-[12px]">
          <span className="mb-1 block text-muted-foreground">RAM budget in GB (0 = auto, ~80% of system memory)</span>
          <Input
            type="number"
            min={0}
            className="w-40"
            value={bytesToGb(lm.ramBudgetBytes)}
            onChange={(e) => save({ ...lm, ramBudgetBytes: gbToBytes(Number(e.currentTarget.value)) })}
          />
        </label>
      </SettingsSection>

      <SettingsSection title="Providers">
        <p className="px-3 pb-2 text-[12px] text-muted-foreground">
          A fixed catalog from the local-LLM runbook. The eye icon is visibility-only — a hidden
          provider stays fully configurable.
        </p>
        <div className="space-y-2 px-1 pb-2">
          {LOCAL_LLM_PROVIDERS.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              config={lm.providers[p.id] ?? { visible: true }}
              onChange={(next) => updateProvider(p.id, next)}
            />
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Model configurations"
        headerAction={
          <Button size="sm" onClick={addModel}>
            <PlusIcon className="size-3.5" /> New model config
          </Button>
        }
      >
        <div className="space-y-2 px-1 py-2">
          {lm.models.length === 0 ? (
            <p className="px-2 py-2 text-[12px] text-muted-foreground">
              No model configs yet. Add one to pair a model with a provider.
            </p>
          ) : (
            lm.models.map((m) => (
              <ModelConfigCard
                key={m.id}
                config={m}
                settings={lm}
                onChange={(next) => updateModel(m.id, next)}
                onDelete={() => deleteModel(m.id)}
              />
            ))
          )}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
