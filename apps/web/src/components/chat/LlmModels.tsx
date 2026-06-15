import { cn } from "~/lib/utils";
import { formatBytes } from "~/lib/hostMetrics";
import {
  type LlmModel,
  type LlmModelsSample,
  type LlmProvider,
  countAvailable,
  countResident,
  formatContext,
} from "~/lib/llmModels";
import { METER_VALUE_SLOT } from "~/lib/usage";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/** Loaded models first, then by id, so the resident ones are always on top. */
function sortModels(models: readonly LlmModel[]): LlmModel[] {
  return [...models].sort((a, b) => {
    if (a.loaded !== b.loaded) return a.loaded ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

function ModelRow(props: { model: LlmModel }) {
  const { model } = props;
  const chips: string[] = [];
  if (model.quantization) chips.push(model.quantization);
  if (model.isMoe) chips.push("MoE");
  const tail: string[] = [];
  if (model.contextLength) tail.push(formatContext(model.contextLength));
  if (model.state) tail.push(model.state);
  const meta = tail.join(" · ");
  return (
    <div className="flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-foreground/[0.04]">
      <span
        className={cn(
          "mt-1 size-1.5 shrink-0 rounded-full",
          model.loaded ? "bg-green-500" : "bg-muted-foreground/40",
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate text-xs",
            model.loaded ? "text-foreground" : "text-muted-foreground",
          )}
          title={model.id}
        >
          {model.id}
        </div>
        {chips.length || meta ? (
          <div className="mt-0.5 text-[10px] text-muted-foreground/70">
            {chips.map((chip) => (
              <span key={chip} className="mr-1 rounded bg-foreground/[0.06] px-1 py-px">
                {chip}
              </span>
            ))}
            {meta}
          </div>
        ) : null}
      </div>
      {model.sizeBytes != null ? (
        <span className="mt-0.5 shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
          {formatBytes(model.sizeBytes)}
        </span>
      ) : null}
    </div>
  );
}

function ProviderGroup(props: { provider: LlmProvider }) {
  const { provider } = props;
  const loaded = provider.models.filter((model) => model.loaded).length;
  return (
    <div className="py-1">
      <div className="flex items-center gap-1.5 px-1.5">
        <span className="truncate text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/70">
          {provider.name}
          <span className="ml-1 font-normal normal-case tracking-normal text-muted-foreground/50">
            {provider.baseUrl}
          </span>
        </span>
        <span
          className={cn(
            "ml-auto shrink-0 text-[10px] tabular-nums",
            provider.reachable ? "text-muted-foreground/50" : "text-orange-400",
          )}
        >
          {provider.reachable ? `${loaded} loaded` : "unreachable"}
        </span>
      </div>
      {!provider.reachable ? (
        <div className="px-1.5 py-1 text-[11px] italic text-muted-foreground/50">
          Configured but not responding{provider.error ? ` (${provider.error})` : ""}.
        </div>
      ) : provider.models.length === 0 ? (
        <div className="px-1.5 py-1 text-[11px] italic text-muted-foreground/50">
          Reachable, no models reported.
        </div>
      ) : (
        sortModels(provider.models).map((model) => <ModelRow key={model.id} model={model} />)
      )}
    </div>
  );
}

function LlmModelsDetail(props: {
  sample: LlmModelsSample | null;
  onToggle: (next: boolean) => void;
}) {
  const { sample } = props;
  const resident = countResident(sample);
  const available = countAvailable(sample);
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          Local models
        </div>
        <button
          type="button"
          onClick={() => props.onToggle(false)}
          aria-label="Pause local-model probing"
          title="Live — click to pause"
          className="-mr-1 flex items-center gap-1 rounded-md p-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="size-1.5 animate-pulse rounded-full bg-green-500" />
          live
        </button>
      </div>
      {sample == null ? (
        <div className="text-xs text-muted-foreground">Connecting to providers…</div>
      ) : sample.providers.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          No providers configured.
          <span className="mt-1 block text-[11px] text-muted-foreground/70">
            Add local-LLM providers in server settings.
          </span>
        </div>
      ) : resident === 0 && sample.providers.every((provider) => provider.reachable) ? (
        <>
          <div className="text-xs text-muted-foreground">
            No models currently resident.
            <span className="mt-1 block text-[11px] text-muted-foreground/70">
              Providers are reachable but nothing is loaded into memory.
            </span>
          </div>
          <div className="-mx-1 max-h-56 overflow-y-auto">
            {sample.providers.map((provider) => (
              <ProviderGroup
                key={`${provider.name}@${provider.baseUrl}`}
                provider={provider}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="-mx-1 max-h-56 overflow-y-auto">
          {sample.providers.map((provider) => (
            <ProviderGroup key={`${provider.name}@${provider.baseUrl}`} provider={provider} />
          ))}
        </div>
      )}
      {sample && sample.providers.length > 0 ? (
        <div className="border-t border-border pt-1.5 text-[10px] text-muted-foreground/60">
          {resident} resident · {available} available
        </div>
      ) : null}
    </div>
  );
}

/**
 * Toolbar indicator for locally-loaded LLMs: a fixed-width "LLM" chip with a status
 * dot (green = ≥1 model resident, gray = none) and a resident count, with the full
 * provider-grouped list in a hover/click popover — mirroring the host-metrics
 * widget. A live-dot button toggles the probe stream to save resources; when
 * disabled it collapses to a single "models paused" affordance.
 */
export function LlmModels(props: {
  sample: LlmModelsSample | null;
  streaming: boolean;
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  const { sample, enabled, onToggle } = props;

  if (!enabled) {
    return (
      <button
        type="button"
        onClick={() => onToggle(true)}
        aria-label="Enable local-model probing"
        title="Local-model probing paused — click to resume"
        className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground/60 transition-colors hover:text-muted-foreground"
      >
        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        <span className="hidden sm:inline">models paused</span>
      </button>
    );
  }

  const resident = countResident(sample);

  return (
    <div className="flex items-center gap-1">
      <Popover>
        <PopoverTrigger
          openOnHover
          delay={150}
          closeDelay={0}
          render={
            <button
              type="button"
              className="group flex min-w-0 items-center gap-1.5 rounded-md px-1 text-[11px] text-muted-foreground transition-opacity hover:opacity-85"
              aria-label="Local models"
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  resident > 0 ? "animate-pulse bg-green-500" : "bg-muted-foreground/40",
                )}
                aria-hidden="true"
              />
              <span className="text-muted-foreground/70">LLM</span>
              <span
                className={cn(
                  METER_VALUE_SLOT,
                  "text-center",
                  sample == null
                    ? "text-muted-foreground/50"
                    : resident > 0
                      ? "text-foreground/80"
                      : "text-muted-foreground/50",
                )}
              >
                {sample == null ? "—" : resident}
              </span>
            </button>
          }
        />
        <PopoverPopup tooltipStyle side="top" align="center" className="w-72 max-w-none px-3 py-2.5">
          <LlmModelsDetail sample={sample} onToggle={onToggle} />
        </PopoverPopup>
      </Popover>
      <button
        type="button"
        onClick={() => onToggle(false)}
        aria-label="Pause local-model probing"
        title="Live — click to pause"
        className="flex items-center rounded-md p-1 text-muted-foreground/70 transition-colors hover:text-foreground"
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            props.streaming ? "animate-pulse bg-green-500" : "bg-muted-foreground/40",
          )}
        />
      </button>
    </div>
  );
}
