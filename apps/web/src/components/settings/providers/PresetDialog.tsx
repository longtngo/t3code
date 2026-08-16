import { useMemo, useState } from "react";
import type {
  LocalLlmModelConfig,
  LocalLlmSettings,
  ProviderInstanceEnvironmentVariable,
} from "@t3tools/contracts";
import { getProvider } from "@t3tools/shared/localLlm";
import { cn } from "~/lib/utils";
import { mergeEnv, presetEnv } from "./localLlmPreset.logic";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";

export interface PresetTarget {
  readonly id: string;
  readonly label: string;
  readonly driver: string;
  readonly environment: readonly ProviderInstanceEnvironmentVariable[];
}

/**
 * Pick a local-LLM model config and a target agent instance; preview the env vars the
 * preset generates merged into the instance (preset wins on conflict), then apply.
 */
export function PresetDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targets: readonly PresetTarget[];
  models: readonly LocalLlmModelConfig[];
  settings: LocalLlmSettings;
  onApply: (targetId: string, mergedEnv: ProviderInstanceEnvironmentVariable[]) => void;
}) {
  const { targets, models, settings } = props;
  const [configId, setConfigId] = useState<string | null>(models[0]?.id ?? null);
  const [targetId, setTargetId] = useState<string | null>(targets[0]?.id ?? null);

  const config = models.find((m) => m.id === configId) ?? null;
  const target = targets.find((t) => t.id === targetId) ?? null;

  const preview = useMemo(() => {
    if (!config || !target) return null;
    const preset = presetEnv(config, target.driver, settings);
    return mergeEnv(target.environment, preset);
  }, [config, target, settings]);

  const provider = config ? getProvider(config.providerId) : undefined;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Apply a local-LLM preset</DialogTitle>
          <DialogDescription>
            Generate the env vars that point an agent instance at a local model config, then merge
            them in. Existing vars are kept; the preset wins on conflict.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-4 py-3">
          <div>
            <div className="mb-1.5 text-[12px] text-muted-foreground">Model config</div>
            {models.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">
                No model configs yet — create one in Settings → Local LLM.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {models.map((m) => {
                  const p = getProvider(m.providerId);
                  return (
                    <Button
                      key={m.id}
                      size="sm"
                      variant={m.id === configId ? "default" : "outline"}
                      onClick={() => setConfigId(m.id)}
                    >
                      {m.name}
                      <span className="ml-1.5 text-[10px] opacity-70">
                        {p?.name} :{m.port ?? p?.defaultPort}
                      </span>
                    </Button>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <div className="mb-1.5 text-[12px] text-muted-foreground">Apply to instance</div>
            <div className="flex flex-wrap gap-1.5">
              {targets.map((t) => (
                <Button
                  key={t.id}
                  size="sm"
                  variant={t.id === targetId ? "default" : "outline"}
                  onClick={() => setTargetId(t.id)}
                >
                  {t.label}
                </Button>
              ))}
            </div>
          </div>

          {preview && config && provider ? (
            <div className="rounded-lg border border-border">
              <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
                Merged environment — http://
                {settings.providers[config.providerId]?.host ?? provider.host}:
                {config.port ?? provider.defaultPort}/v1
              </div>
              <div className="divide-y divide-border/60">
                {preview.merged.map((e) => {
                  const added = preview.added.includes(e.name);
                  const overridden = preview.overridden.includes(e.name);
                  return (
                    <div
                      key={e.name}
                      className={cn(
                        "flex items-center justify-between gap-2 px-3 py-1.5 text-[12px]",
                        added && "bg-emerald-500/10",
                        overridden && "bg-amber-500/10",
                      )}
                    >
                      <code className="truncate">{e.name}</code>
                      <code className="truncate text-muted-foreground">
                        {e.sensitive ? "••••••" : e.value}
                      </code>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {added ? "＋ added" : overridden ? "⚠ overrides" : "kept"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!preview || !target}
            onClick={() => {
              if (preview && target) {
                props.onApply(target.id, preview.merged);
                props.onOpenChange(false);
              }
            }}
          >
            Merge into instance
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
