import { useMemo, useState } from "react";
import { ChevronRightIcon, CpuIcon, Loader2Icon } from "lucide-react";
import { cn } from "~/lib/utils";
import { formatBytes } from "~/lib/hostMetrics";
import {
  type LlmModel,
  type ModelStatus,
  countBusy,
  countResident,
  formatContext,
  modelStatus,
} from "~/lib/llmModels";
import { useLlmModelActions, useLlmModels } from "~/hooks/useLlmModels";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

const DOT_CLASS: Record<ModelStatus, string> = {
  online: "bg-green-500",
  loading: "bg-amber-500",
  stopping: "bg-amber-500",
  offline: "bg-muted-foreground/40",
  error: "bg-red-500",
};

function sortModels(models: readonly LlmModel[]): LlmModel[] {
  const rank: Record<ModelStatus, number> = {
    online: 0,
    loading: 1,
    stopping: 2,
    error: 3,
    offline: 4,
  };
  return [...models].sort((a, b) => {
    const byStatus = rank[modelStatus(a)] - rank[modelStatus(b)];
    if (byStatus !== 0) return byStatus;
    return (a.modelId ?? a.id).localeCompare(b.modelId ?? b.id);
  });
}

function ModelMeta(props: { model: LlmModel; showEngine: boolean }) {
  const { model, showEngine } = props;
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

function ModelRow(props: {
  model: LlmModel;
  busy: boolean;
  showEngine: boolean;
  onLoad: () => void;
  onUnload: () => void;
}) {
  const { model, busy, showEngine } = props;
  const status = modelStatus(model);
  const transitional = status === "loading" || status === "stopping" || busy;
  const clickable = !transitional && (status === "online" || status === "offline" || status === "error");

  const onClick = () => {
    if (!clickable) return;
    if (status === "online") props.onUnload();
    else props.onLoad();
  };

  const title =
    status === "online"
      ? "Click to unload"
      : status === "loading"
        ? "Loading…"
        : status === "stopping"
          ? "Stopping…"
          : status === "error"
            ? (model.loadError ?? "Failed — click to retry")
            : "Click to load";

  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={onClick}
      title={title}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
        clickable ? "hover:bg-accent" : "cursor-default",
      )}
    >
      {transitional ? (
        <Loader2Icon className="size-3 shrink-0 animate-spin text-amber-500" />
      ) : (
        <span className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[status])} aria-hidden />
      )}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-xs", status === "offline" && "text-muted-foreground")}>
          {model.modelId ?? model.id}
        </span>
        <ModelMeta model={model} showEngine={showEngine} />
      </span>
    </button>
  );
}

export function SidebarLocalModels() {
  const environmentId = usePrimaryEnvironmentId();
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState<{ model: LlmModel; pid: number } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { sample } = useLlmModels(environmentId ?? ("" as never), environmentId != null);
  const actions = useLlmModelActions(environmentId ?? ("" as never), setActionError);

  const models = useMemo(
    () => sortModels(sample?.providers.flatMap((p) => p.models) ?? []),
    [sample],
  );
  // Show the engine tag on each row only when more than one engine contributes models,
  // so a single-engine setup stays uncluttered.
  const showEngine = useMemo(
    () => (sample?.providers.filter((p) => p.models.length > 0).length ?? 0) > 1,
    [sample],
  );
  const resident = countResident(sample);
  const busy = countBusy(sample);

  if (environmentId == null) return null;

  const headerStatus: ModelStatus = resident > 0 ? "online" : busy > 0 ? "loading" : "offline";

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            <CpuIcon className="size-3.5" />
            <span className="text-xs">Local models</span>
            <span className={cn("size-1.5 rounded-full", DOT_CLASS[headerStatus])} aria-hidden />
            {resident > 0 ? (
              <span className="text-[10px] tabular-nums text-muted-foreground/60">{resident}</span>
            ) : null}
            <ChevronRightIcon
              className={cn("ml-auto size-3.5 transition-transform", expanded && "rotate-90")}
            />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>

      {expanded ? (
        <div className="max-h-64 overflow-y-auto px-1 pb-1">
          {models.length === 0 ? (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground/60">
              {sample == null ? "Connecting…" : "No models found in the models directory."}
            </div>
          ) : (
            models.map((model) => (
              <ModelRow
                key={`${model.engine ?? "?"}:${model.modelId ?? model.id}`}
                model={model}
                showEngine={showEngine}
                busy={
                  (model.modelId != null && actions.pending.has(`load:${model.modelId}`)) ||
                  (model.pid != null && actions.pending.has(`unload:${model.pid}`))
                }
                onLoad={() => {
                  if (model.modelId) {
                    setActionError(null);
                    void actions.load(model.modelId);
                  }
                }}
                onUnload={() => {
                  if (model.pid != null) setConfirm({ model, pid: model.pid });
                }}
              />
            ))
          )}
          {actionError ? (
            <div className="px-2 pt-1 text-[10px] text-red-500">{actionError}</div>
          ) : null}
          {sample?.ramBudgetBytes ? (
            <div className="px-2 pt-1 text-[10px] text-muted-foreground/50">
              RAM {formatBytes(sample.ramUsedBytes ?? 0)} / {formatBytes(sample.ramBudgetBytes)}
            </div>
          ) : null}
        </div>
      ) : null}

      <AlertDialog open={confirm != null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Unload {confirm?.model.modelId ?? confirm?.model.id}?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the {confirm?.model.engine ?? "local-model"} process (pid {confirm?.pid})
              {confirm?.model.sizeBytes ? ` and frees ~${formatBytes(confirm.model.sizeBytes)}` : ""}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirm) void actions.unload(confirm.pid);
                setConfirm(null);
              }}
            >
              Unload
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
