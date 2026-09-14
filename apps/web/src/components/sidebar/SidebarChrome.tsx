import {
  ArrowLeftIcon,
  ChartNoAxesColumnIcon,
  GitPullRequestIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Link, useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { T3Wordmark } from "../T3Wordmark";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  resolveSidebarStageFocusRingOffsetClass,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarHeader,
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
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarCrew } from "./SidebarCrew";
import { SidebarResourceQueue } from "./SidebarResourceQueue";
import { SidebarSubagentBackend } from "./SidebarSubagentBackend";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";

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
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0 md:px-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarTrigger
        className={cn(
          "relative z-10 md:hidden",
          backdropVariant &&
            "focus-visible:ring-white/90 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white! [:hover,[data-pressed]]:bg-white/15",
          backdropVariant && resolveSidebarStageFocusRingOffsetClass(backdropVariant),
        )}
      />
      <SidebarBrand onBackdrop={backdropVariant !== null} />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 hidden rounded-full px-1.5 text-muted-foreground @[15rem]/sidebar-header:inline-flex"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </SidebarHeader>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 md:flex group-data-[collapsible=icon]:hidden",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <span className="inline-flex min-w-0 items-baseline gap-1">
        <T3Wordmark aria-label="T3" className="h-2.5 w-auto shrink-0" />
        <span
          className={cn(
            "truncate text-sm font-medium tracking-tight",
            onBackdrop ? "text-white/70" : "text-muted-foreground",
          )}
        >
          Code
        </span>
      </span>
    </Link>
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
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const currentFooterPage = useLocation({
    select: (location) =>
      /^\/settings(?:\/|$)/.test(location.pathname)
        ? "settings"
        : /^\/projects\/[^/]+\/?$/.test(location.pathname)
          ? "project-settings"
          : location.pathname === "/usage"
            ? "usage"
            : location.pathname === "/pull-requests"
              ? "pull-requests"
              : null,
  });
  const { environments } = useEnvironments();
  // The page reads every connected server, so one of them offering pull requests is enough for
  // the link to lead somewhere.
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  }, [closeMobileSidebar, navigate]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handleUsageClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, closeMobileSidebar, navigate]);

  const [openFooterPanel, setOpenFooterPanel] = useState<SidebarFooterPanel | null>(null);
  const setFooterPanelOpen = useCallback((panel: SidebarFooterPanel, open: boolean) => {
    setOpenFooterPanel((current) => nextOpenFooterPanel({ current, panel, open }));
  }, []);
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
        <SidebarMenu className="flex-row flex-wrap items-center group-data-[collapsible=icon]:flex-col">
          {currentFooterPage ? (
            <SidebarMenuItem className="min-w-0 flex-1">
              <SidebarMenuButton onClick={handleBackClick} aria-label="Back" tooltip="Back">
                <ArrowLeftIcon />
                <span className="group-data-[collapsible=icon]:hidden">Back</span>
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
                  icon={<GitPullRequestIcon />}
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
          <SidebarCrew />
          <SidebarUpdatePill />
        </SidebarMenu>
      </div>
    </>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter className="px-[var(--sidebar-content-inset)] py-1">
      <div className="contents group-data-[collapsible=icon]:hidden">
        <SidebarProviderUpdatePill />
        <SidebarUpdateArchitectureWarning />
      </div>
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
