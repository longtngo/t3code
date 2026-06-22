import { useMemo, useState } from "react";
import { ChevronRightIcon, CpuIcon, Loader2Icon } from "lucide-react";
import { cn } from "~/lib/utils";
import { formatBytes } from "~/lib/hostMetrics";
import { formatContext, type ModelStatus } from "~/lib/llmModels";
import { MODEL_DOT_CLASS } from "../llm/modelPresentation";
import { useLlmModelActions, useLlmModels } from "~/hooks/useLlmModels";
import { useSettings } from "~/hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  type SidebarRow,
  countBusy,
  countOnline,
  mergeConfigsWithSample,
} from "./sidebarLocalModels.logic";
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

function rowMeta(row: SidebarRow): string {
  const parts = [row.providerName];
  if (row.contextWindow) parts.push(formatContext(row.contextWindow));
  if (row.sizeBytes) parts.push(formatBytes(row.sizeBytes));
  return parts.join(" · ");
}

function ModelRow(props: {
  row: SidebarRow;
  busy: boolean;
  onLoad: () => void;
  onUnload: () => void;
}) {
  const { row, busy } = props;
  const status = row.status;
  const transitional = status === "loading" || status === "stopping" || busy;
  const clickable = row.loadable && !transitional && (status === "online" || status === "offline" || status === "error");

  const onClick = () => {
    if (!clickable) return;
    if (status === "online") props.onUnload();
    else props.onLoad();
  };

  const title = !row.loadable
    ? `${row.providerName} is external / probe-only — t3code can't load it`
    : status === "online"
      ? "Click to unload"
      : status === "loading"
        ? "Loading…"
        : status === "stopping"
          ? "Stopping…"
          : status === "error"
            ? "Failed — click to retry"
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
        <span className={cn("size-1.5 shrink-0 rounded-full", MODEL_DOT_CLASS[status])} aria-hidden />
      )}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-xs", status === "offline" && "text-muted-foreground")}>
          {row.name}
        </span>
        <span className="block truncate text-[10px] text-muted-foreground/60">{rowMeta(row)}</span>
      </span>
    </button>
  );
}

export function SidebarLocalModels() {
  const environmentId = usePrimaryEnvironmentId();
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState<SidebarRow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const models = useSettings((s) => s.localLlm.models);
  const { sample } = useLlmModels(environmentId ?? ("" as never), environmentId != null);
  const actions = useLlmModelActions(environmentId ?? ("" as never), setActionError);

  const rows = useMemo(() => mergeConfigsWithSample(models, sample), [models, sample]);
  const online = countOnline(rows);
  const busy = countBusy(rows);

  if (environmentId == null) return null;

  const headerStatus: ModelStatus = online > 0 ? "online" : busy > 0 ? "loading" : "offline";

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
            <span className={cn("size-1.5 rounded-full", MODEL_DOT_CLASS[headerStatus])} aria-hidden />
            {online > 0 ? (
              <span className="text-[10px] tabular-nums text-muted-foreground/60">{online}</span>
            ) : null}
            <ChevronRightIcon
              className={cn("ml-auto size-3.5 transition-transform", expanded && "rotate-90")}
            />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>

      {expanded ? (
        <div className="max-h-64 overflow-y-auto px-1 pb-1">
          {rows.length === 0 ? (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground/60">
              No model configs yet. Add one in Settings → Local LLM.
            </div>
          ) : (
            rows.map((row) => (
              <ModelRow
                key={row.configId}
                row={row}
                busy={
                  actions.pending.has(`load:${row.configId}`) ||
                  actions.pending.has(`unload:${row.configId}`)
                }
                onLoad={() => {
                  setActionError(null);
                  void actions.load(row.configId);
                }}
                onUnload={() => setConfirm(row)}
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
            <AlertDialogTitle>Unload {confirm?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops the {confirm?.providerName ?? "local-model"} process
              {confirm?.pid != null ? ` (pid ${confirm.pid})` : ""}
              {confirm?.sizeBytes ? ` and frees ~${formatBytes(confirm.sizeBytes)}` : ""}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirm) void actions.unload(confirm.configId);
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
