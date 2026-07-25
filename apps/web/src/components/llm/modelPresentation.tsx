import { cn } from "~/lib/utils";
import { formatBytes } from "~/lib/hostMetrics";
import { type LlmModel, type ModelStatus, formatContext, modelStatus } from "~/lib/llmModels";

/** Status → dot colour, shared by the sidebar manager and the settings discovered-models list. */
export const MODEL_DOT_CLASS: Record<ModelStatus, string> = {
  online: "bg-green-500",
  loading: "bg-amber-500",
  stopping: "bg-amber-500",
  offline: "bg-muted-foreground/40",
  error: "bg-red-500",
};

/** A small status dot for a local model. */
export function ModelStatusDot({ status, className }: { status: ModelStatus; className?: string }) {
  return (
    <span
      className={cn("size-1.5 shrink-0 rounded-full", MODEL_DOT_CLASS[status], className)}
      aria-hidden
    />
  );
}

/** The compact meta line (engine · quant · MoE · ctx · size · external) for a local model. */
export function ModelMeta({ model, showEngine }: { model: LlmModel; showEngine: boolean }) {
  const parts: string[] = [];
  if (showEngine && model.engine) parts.push(model.engine);
  if (model.quantization) parts.push(model.quantization);
  if (model.isMoe) parts.push("MoE");
  if (model.contextLength) parts.push(formatContext(model.contextLength));
  if (model.sizeBytes) parts.push(formatBytes(model.sizeBytes));
  if (model.managed === false && modelStatus(model) === "online") parts.push("external");
  if (parts.length === 0) return null;
  return <div className="truncate text-[10px] text-muted-foreground/60">{parts.join(" · ")}</div>;
}
