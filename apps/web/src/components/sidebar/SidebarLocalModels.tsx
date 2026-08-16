import { useMemo, useState } from "react";
import { CpuIcon, Loader2Icon } from "lucide-react";
import { cn } from "~/lib/utils";
import { formatBytes } from "~/lib/hostMetrics";
import { formatContext, type ModelStatus } from "~/lib/llmModels";
import { MODEL_DOT_CLASS } from "../llm/modelPresentation";
import { useLlmModelActions, useLlmModels } from "~/hooks/useLlmModels";
import { usePrimarySettings } from "~/hooks/useSettings";
import { usePrimaryEnvironmentId } from "~/state/environments";
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
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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
  const clickable =
    row.loadable &&
    !transitional &&
    (status === "online" || status === "offline" || status === "error");

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
        <span
          className={cn("size-1.5 shrink-0 rounded-full", MODEL_DOT_CLASS[status])}
          aria-hidden
        />
      )}
      <span className="min-w-0 flex-1">
        <span
          className={cn("block truncate text-xs", status === "offline" && "text-muted-foreground")}
        >
          {row.name}
        </span>
        <span className="block truncate text-[10px] text-muted-foreground/60">{rowMeta(row)}</span>
      </span>
    </button>
  );
}

/**
 * Open state is controlled by `SidebarChromeFooter` rather than held here: this panel and the
 * Resource Queue one share a positioning context, so only one may be open at a time and the
 * footer is what arbitrates.
 */
export function SidebarLocalModels({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const [confirm, setConfirm] = useState<SidebarRow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const models = usePrimarySettings((s) => s.localLlm.models);
  const { sample } = useLlmModels(environmentId ?? ("" as never), environmentId != null);
  const actions = useLlmModelActions(environmentId ?? ("" as never), setActionError);

  const rows = useMemo(() => mergeConfigsWithSample(models, sample), [models, sample]);
  const online = countOnline(rows);
  const busy = countBusy(rows);

  if (environmentId == null) return null;

  const headerStatus: ModelStatus = online > 0 ? "online" : busy > 0 ? "loading" : "offline";

  return (
    /*
     * `static` is load-bearing, not cosmetic. `SidebarMenuItem` bakes in
     * `relative`; leaving it would anchor the panel below to this ~40px
     * trigger. Opting out lets the panel resolve against the footer row's
     * `relative` wrapper instead, so it draws at exactly footer width on both
     * the 16rem desktop sidebar and the wider mobile drawer, with no width
     * arithmetic to drift.
     */
    <SidebarMenuItem className="static shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              size="sm"
              className="h-8 w-auto gap-1 px-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
              onClick={() => onOpenChange(!isOpen)}
              aria-expanded={isOpen}
              aria-label="Local models"
            >
              <CpuIcon className="size-3.5" />
              <span
                className={cn("size-1.5 rounded-full", MODEL_DOT_CLASS[headerStatus])}
                aria-hidden
              />
              {online > 0 ? (
                <span className="text-[10px] tabular-nums text-muted-foreground/60">{online}</span>
              ) : null}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">Local models</TooltipPopup>
      </Tooltip>

      {isOpen ? (
        <div className="absolute right-0 bottom-full left-0 z-50 mb-2 rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg">
          {/* The row shows only an icon and a dot, so the panel carries the name. */}
          <div className="px-0.5 pb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Local models
          </div>
          <div className="max-h-64 overflow-y-auto">
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
          </div>
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
    </SidebarMenuItem>
  );
}
