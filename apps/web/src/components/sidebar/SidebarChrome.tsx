import { ArrowLeftIcon, ChartNoAxesColumnIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { usePullRequestsSupported } from "../../state/environments";
import { T3Wordmark } from "../T3Wordmark";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { nextOpenFooterPanel, type SidebarFooterPanel } from "./sidebarChrome.logic";
import { SidebarLocalModels } from "./SidebarLocalModels";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarResourceQueue } from "./SidebarResourceQueue";
import { SidebarSubagentBackend } from "./SidebarSubagentBackend";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { observeResize } from "~/lib/observeResize";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <div
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
        <SidebarTrigger
          variant={backdropVariant ? "media-navigation" : "ghost"}
          className="relative top-auto translate-y-0"
          aria-label="Toggle main sidebar"
        />
      </div>
      <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
        <SidebarBrand onBackdrop={backdropVariant !== null} />
        {pillLabel ? (
          <div className="ml-1 flex h-7 items-center">
            <Badge data-environment-identification="pill" size="sm" variant="secondary">
              {pillLabel}
            </Badge>
          </div>
        ) : null}
      </div>
    </div>
  );
});

export function SidebarBrandWidthProbe({
  onWidthChange,
}: {
  onWidthChange: (width: number) => void;
}) {
  const observeWidth = (probe: HTMLDivElement) => {
    return observeResize(probe, ([entry]) => {
      if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
    });
  };

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max border-r border-transparent pr-3"
      ref={observeWidth}
    >
      <div className="ml-[var(--workspace-titlebar-content-left)] flex">
        <SidebarBrandMark onBackdrop={false} />
      </div>
    </div>
  );
}

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset md:flex",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <SidebarBrandMark onBackdrop={onBackdrop} />
    </Link>
  );
}

function SidebarBrandMark({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
      <T3Wordmark aria-label="T3" className="h-[1cap] w-auto shrink-0" />
      <span
        className={cn(
          "truncate [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1",
          onBackdrop ? "text-white/70" : "text-muted-foreground",
        )}
      >
        Code
      </span>
    </span>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const pullRequestsSupported = usePullRequestsSupported();
  const closeMobileSidebar = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };
  const handlePullRequestsClick = () => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  };
  const handleSettingsClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  };

  const handleUsageClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  };

  const handleBackClick = () => {
    closeMobileSidebar();
    void navigateToMainApp();
  };

  const [openFooterPanel, setOpenFooterPanel] = useState<SidebarFooterPanel | null>(null);
  const setFooterPanelOpen = (panel: SidebarFooterPanel, open: boolean) => {
    setOpenFooterPanel((current) => nextOpenFooterPanel({ current, panel, open }));
  };
  const footerRowRef = useRef<HTMLDivElement | null>(null);

  // Escape and outside-click dismissal for whichever panel is open. This lives here rather than in
  // each panel because the footer already owns which one is open, and both draw into the same row
  // wrapper — so one listener and one containment test cover both, and a panel cannot ship as an
  // overlay that has no way out. (Local models did exactly that when it stopped being an inline
  // expansion.)
  useEffect(() => {
    if (openFooterPanel === null) return;
    const dismiss = () => setOpenFooterPanel(null);
    const onPointerDown = (event: MouseEvent) => {
      if (footerRowRef.current && !footerRowRef.current.contains(event.target as Node)) {
        dismiss();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openFooterPanel]);

  return (
    <>
      {/* This wrapper is the positioning context for the two floating fork-only panels in the
       row below. Their trigger items opt out of `relative`, so each panel draws at exactly
       footer width above the whole row instead of against its own ~40px button — correct
       on the 16rem desktop sidebar and the wider mobile drawer alike, with no width
       arithmetic.

       The row wraps: six controls plus the Electron update pill do not always fit 240px,
       and wrapping to a second line beats overflowing or shrinking the badges past
       legibility. */}
      <div className="relative" ref={footerRowRef}>
        <SidebarMenu className="flex-row flex-wrap items-center">
          {isOnUtilityPage ? (
            <SidebarMenuItem className="min-w-0 flex-1">
              <SidebarMenuButton onClick={handleBackClick}>
                <ArrowLeftIcon />
                <span>Back</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : (
            <>
              <SidebarUtilityItem
                icon={<SettingsIcon />}
                label="Settings"
                onClick={handleSettingsClick}
              />
              {pullRequestsSupported ? (
                <SidebarUtilityItem
                  icon={<PullRequestGlyph.pullRequest />}
                  label="Pull Requests"
                  onClick={handlePullRequestsClick}
                />
              ) : null}
              <SidebarUtilityItem
                icon={<ChartNoAxesColumnIcon />}
                label="Usage"
                onClick={handleUsageClick}
              />
            </>
          )}
          {/* Fork-only, and OUTSIDE the branch above on purpose. Settings, Pull Requests and
            Usage are navigation, so "Back" rightly replaces them once you are on one of
            those pages. Subagents, Local models and Resource Queue are live status readouts —
            hiding them there would be a silent capability loss for no gain.
            `SidebarUpdatePill` below sits outside for the same reason.

            Local models' and Resource Queue's open state lives in this component rather than
            in each panel: both anchor to the wrapper above with identical insets, so two open
            panels would occupy the same box. Subagents keeps its own state; its panel is an
            in-flow first item of this row, not an overlay. */}
          <SidebarSubagentBackend />
          <SidebarLocalModels
            isOpen={openFooterPanel === "models"}
            onOpenChange={(open) => setFooterPanelOpen("models", open)}
          />
          <SidebarResourceQueue
            isOpen={openFooterPanel === "queue"}
            onOpenChange={(open) => setFooterPanelOpen("queue", open)}
          />
          <SidebarUpdatePill />
        </SidebarMenu>
      </div>
    </>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter>
      <SidebarThreadUndoNotice />
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
