import { FileTextIcon } from "lucide-react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { TrustedFileView } from "~/components/files/TrustedFileView";
import { absolutePathFromViewerSplat, viewerSplatFromPath } from "~/components/files/viewerPath";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { SidebarInset } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";

/** Directory of an absolute posix path — the `cwd` for markdown relative links. */
function directoryOf(absolutePath: string): string {
  const lastSlash = absolutePath.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : absolutePath.slice(0, lastSlash);
}

/**
 * Editable, URI-like path field for the viewer header. Shows the full resolved
 * path and lets the user retype any absolute path to retarget the viewer. Enter
 * commits, Escape reverts, blur commits. Resyncs to `value` whenever the loaded
 * path changes and the field is not being edited. (Ported from the fork's
 * FileViewerSidebar address bar.)
 */
function AddressBar({
  value,
  onSubmit,
}: {
  value: string;
  onSubmit: (path: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  // Set by Escape so the blur it triggers reverts instead of submitting. A ref
  // (not state) because it must be read synchronously inside the blur handler.
  const revertOnBlurRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  // The single commit point: both Enter and focus-loss route through blur, so
  // the path is submitted at most once per edit. Escape sets revertOnBlurRef so
  // its blur reverts the draft instead.
  const commit = useCallback(() => {
    setEditing(false);
    const next = draft.trim();
    if (revertOnBlurRef.current || !next || next === value) {
      revertOnBlurRef.current = false;
      setDraft(value);
      return;
    }
    onSubmit(next);
  }, [draft, value, onSubmit]);

  return (
    <input
      type="text"
      value={draft}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => {
        setEditing(true);
        event.target.select();
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          // Blur drives the commit; Enter just relinquishes focus.
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          revertOnBlurRef.current = true;
          event.currentTarget.blur();
        }
      }}
      title={value}
      aria-label="File path"
      className="min-w-0 flex-1 truncate rounded bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground/90 outline-none hover:bg-muted/60 focus:bg-muted/70 focus:text-foreground"
    />
  );
}

function ViewerRouteView() {
  const splat = Route.useParams({ select: (params) => params._splat });
  const absolutePath = absolutePathFromViewerSplat(splat);
  const environmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  const navigateTo = useCallback(
    (rawPath: string) => {
      const nextSplat = viewerSplatFromPath(rawPath);
      if (nextSplat === null || nextSplat === splat) return;
      void navigate({ to: "/viewer/$", params: { _splat: nextSplat } });
    },
    [navigate, splat],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          <FileTextIcon className="size-4 shrink-0 text-muted-foreground/70" />
          <AddressBar value={absolutePath ?? ""} onSubmit={navigateTo} />
        </header>

        {/* Content, the markdown/HTML toggle, and reload all live in the shared
            component, so this route and the right-panel surface cannot drift. */}
        <TrustedFileView environmentId={environmentId} absolutePath={absolutePath} />
      </div>
    </SidebarInset>
  );
}

function ViewerNotice({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 items-center justify-center gap-2 px-6 text-center text-sm",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

export const Route = createFileRoute("/viewer/$")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ViewerRouteView,
});
