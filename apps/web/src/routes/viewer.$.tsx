import { FileTextIcon } from "lucide-react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { TrustedFileView } from "~/components/files/TrustedFileView";
import {
  absolutePathFromViewerSplat,
  resolveAddressBarCommit,
  resolveViewerNavigation,
} from "~/components/files/viewerPath";
import { SidebarInset } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import type { EnvironmentId } from "@t3tools/contracts";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

/**
 * Editable, URI-like path field for the viewer header. Shows the full resolved
 * path and lets the user retype any absolute path to retarget the viewer. Enter
 * commits, Escape reverts, blur commits. Resyncs to `value` whenever the loaded
 * path changes and the field is not being edited. (Ported from the fork's
 * FileViewerSidebar address bar.)
 */
function AddressBar({ value, onSubmit }: { value: string; onSubmit: (path: string) => void }) {
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
    const outcome = resolveAddressBarCommit({
      draft,
      value,
      reverting: revertOnBlurRef.current,
    });
    revertOnBlurRef.current = false;
    if (outcome.kind === "revert") {
      setDraft(value);
      return;
    }
    onSubmit(outcome.path);
  }, [draft, value, onSubmit]);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
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
            aria-label="File path"
            className="min-w-0 flex-1 truncate rounded bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground/90 outline-none hover:bg-muted/60 focus:bg-muted/70 focus:text-foreground"
          />
        }
      />
      <TooltipPopup className="max-w-80">{value}</TooltipPopup>
    </Tooltip>
  );
}

function ViewerRouteView() {
  const splat = Route.useParams({ select: (params) => params._splat });
  const absolutePath = absolutePathFromViewerSplat(splat);
  // An absolute path is only meaningful together with the machine it lives on.
  // Opening a file from a thread on a remote environment used to read that path
  // from the PRIMARY one, which 404s or, worse, silently serves a same-named
  // local file. The opener passes the thread's environment.
  //
  // Falling back to primary is right when no environment was ASKED for (older
  // links, the single-environment case) but wrong when one was asked for and is
  // not in the connection catalog — reading a stale link's path off this machine
  // reproduces the bug this fixes. That case says so instead.
  //
  // Gated on `isReady` because the catalog starts empty: opening one of these
  // links directly, which is exactly what the feature adds, would otherwise flash
  // "not connected" for every environment before the catalog arrives.
  const requestedEnvironmentId = Route.useSearch({ select: (search) => search.env });
  const { isReady, presentationById } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const requestedIsUnknown =
    isReady &&
    requestedEnvironmentId !== undefined &&
    !presentationById.has(requestedEnvironmentId);
  const environmentId = requestedIsUnknown
    ? null
    : (requestedEnvironmentId ?? primaryEnvironmentId);
  const navigate = useNavigate();
  const navigateTo = useCallback(
    (rawPath: string) => {
      const nextSplat = resolveViewerNavigation(rawPath, splat);
      if (nextSplat === null) return;
      // Keep the environment across address-bar navigation, or the next path
      // silently resolves against a different machine than the current one.
      void navigate({
        to: "/viewer/$",
        params: { _splat: nextSplat },
        search: (previous: ViewerSearch) => previous,
      });
    },
    [navigate, splat],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {/* The inset matters most here: this route now opens with the sidebar
            collapsed, and the floating sidebar control is positioned over the
            top-left corner — without it, the control sits on the file icon and the
            start of the path field and steals clicks there. */}
        <header
          className={cn(
            "flex items-center gap-2 border-b border-border/60 px-3 py-2",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
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

/** Which environment's filesystem the splat path should be read from. */
export interface ViewerSearch {
  readonly env?: EnvironmentId | undefined;
}

export const Route = createFileRoute("/viewer/$")({
  validateSearch: (raw: Record<string, unknown>): ViewerSearch =>
    typeof raw.env === "string" && raw.env.length > 0 ? { env: raw.env as EnvironmentId } : {},
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
