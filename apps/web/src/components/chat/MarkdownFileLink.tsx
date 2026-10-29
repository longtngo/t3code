import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { splitFilePathPosition } from "@t3tools/shared/fileLinks";
import { ChevronDownIcon } from "lucide-react";
import { memo, type MouseEvent as ReactMouseEvent } from "react";

import { isAbsoluteFilePath } from "../../chatFilePathLinks";
import { basenamePathSegment } from "../../filePathDisplay";

import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import {
  shouldOpenMarkdownFileLinkInEditor,
  type MarkdownFileLinkMeta,
} from "../../markdown-links";
import type { markdownFileCopyPaths } from "../../markdownFileHostPath";
import { documentChipKindForFileName } from "../../pierre-icons";
import { ContextChip } from "../ContextChip";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { FileTagChipContent } from "./FileTagChip";
import {
  hasMarkdownFilePrimaryAction,
  markdownFileCopyMenuItems,
  shouldUseMarkdownFileBrowserPrimaryAction,
} from "./MarkdownFileLink.logic";
import { reportMarkdownActionFailure } from "./markdownActionFailure";
import { WorkspaceEntryTooltip } from "./WorkspaceEntryIcon";

interface MarkdownFileLinkProps {
  environmentId: EnvironmentId | null;
  href: string;
  targetPath: string;
  iconPath: string;
  workspaceRelativePath: string | null;
  panelPath: string | null;
  label: string;
  copyMarkdown: string;
  theme: "light" | "dark";
  threadRef?: ScopedThreadRef | undefined;
  fileEnvironmentId?: EnvironmentId | undefined;
  /** What the handlers below resolve against; compared by field, not identity. */
  fileLink: MarkdownFileLinkMeta;
  /* The handlers take their target as an argument rather than closing over it. A
     closure per link is a fresh function on every render, and the memo comparator
     compares them, so every chip in a streaming message would re-render on every delta.
     The parent resolves the real host path inside them, at call time. */
  onOpen?:
    | ((fileLink: MarkdownFileLinkMeta) => Promise<AtomCommandResult<unknown, unknown>>)
    | undefined;
  onOpenInPanel: (fileLink: MarkdownFileLinkMeta, panelPath: string) => void;
  resolveCopyPaths: (
    fileLink: MarkdownFileLinkMeta,
  ) => Promise<ReturnType<typeof markdownFileCopyPaths>>;
  openInEditorMenuLabel: string;
  onOpenInBrowser?:
    | ((filePath: string) => Promise<AtomCommandResult<unknown, unknown>>)
    | undefined;
  onOpenMedia?: (() => void) | undefined;
  onReveal?:
    | ((fileLink: MarkdownFileLinkMeta) => Promise<AtomCommandResult<unknown, unknown>>)
    | undefined;
  revealLabel?: string | undefined;
}

const MARKDOWN_FILE_LINK_CLASS_NAME = "chat-markdown-file-link";

export const MarkdownFileLink = memo(function MarkdownFileLink({
  environmentId,
  href,
  targetPath,
  iconPath,
  workspaceRelativePath,
  panelPath,
  label,
  copyMarkdown,
  theme,
  threadRef,
  fileEnvironmentId,
  fileLink,
  onOpen,
  onOpenInPanel,
  openInEditorMenuLabel,
  onOpenInBrowser,
  onOpenMedia,
  onReveal,
  revealLabel,
  resolveCopyPaths,
}: MarkdownFileLinkProps) {
  const handleOpenInEditor = () => {
    if (!onOpen) {
      return;
    }
    void (async () => {
      try {
        const result = await onOpen(fileLink);
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        reportMarkdownActionFailure(
          { operation: "open-file-in-editor", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "open-file-in-editor", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        );
      }
    })();
  };

  const handleOpenInFilePreview = () => {
    if (!threadRef) {
      handleOpenInEditor();
      return;
    }
    if (panelPath) {
      onOpenInPanel(fileLink, panelPath);
      return;
    }
    if (onOpenMedia) {
      onOpenMedia();
      return;
    }
    handleOpenInEditor();
  };

  const handleOpenInBrowser = () => {
    if (!onOpenInBrowser) {
      return;
    }
    void (async () => {
      try {
        const result = await onOpenInBrowser(iconPath);
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        reportMarkdownActionFailure(
          { operation: "open-file-in-browser", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file in browser",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "open-file-in-browser", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file in browser",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        );
      }
    })();
  };

  const handleRevealInFileManager = () => {
    if (!onReveal) {
      return;
    }
    void (async () => {
      try {
        const result = await onReveal(fileLink);
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        reportMarkdownActionFailure(
          { operation: "reveal-file-in-file-manager", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to reveal file",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "reveal-file-in-file-manager", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to reveal file",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        );
      }
    })();
  };

  const handleCopy = (resolveValue: () => Promise<string>, title: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to copy ${title.toLowerCase()}`,
          description: "Clipboard API unavailable.",
        }),
      );
      return;
    }

    const value = resolveValue().then((text) => formatFilePathForClipboard(text, targetPath));
    // Start the write before workspace lookup finishes so Safari retains the user gesture.
    const write =
      typeof navigator.clipboard.write === "function" && typeof ClipboardItem !== "undefined"
        ? navigator.clipboard.write([
            new ClipboardItem({
              "text/plain": value.then((text) => new Blob([text], { type: "text/plain" })),
            }),
          ])
        : value.then((text) => navigator.clipboard.writeText(text));
    void Promise.all([write, value]).then(
      ([, text]) => {
        toastManager.add({
          type: "success",
          title: `${title} copied`,
          description: text,
        });
      },
      (error) => {
        reportMarkdownActionFailure(
          { operation: "copy-file-path", target: targetPath, copyTarget: title },
          error,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to copy ${title.toLowerCase()}`,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  };

  const copyPath = (copyId: string, title: string) =>
    handleCopy(
      () =>
        resolveCopyPaths(fileLink).then((paths) =>
          copyId === "copy-relative" ? paths.relativePath : paths.fullPath,
        ),
      title,
    );

  /**
   * The items BOTH of this chip's menus carry, with their conditions and handlers, in
   * one place. The native right-click menu shows exactly this list; the chevron menu
   * prepends its two web-route entries ("View in side panel", "Open in new tab") and
   * then renders the rest. Two hand-kept lists drifted twice; one array cannot.
   */
  const sharedFileMenuItems = [
    ...(onOpenMedia
      ? ([{ id: "preview-media", label: "Preview media", run: onOpenMedia }] as const)
      : []),
    ...(onOpen
      ? ([{ id: "open", label: openInEditorMenuLabel, run: handleOpenInEditor }] as const)
      : []),
    // Gated on the preview runtime and file type, not on shell actions, so this is the
    // one item here that survives on a remote or browser client.
    ...(onOpenInBrowser
      ? ([
          {
            id: "open-in-browser",
            label: "Open in integrated browser",
            run: handleOpenInBrowser,
          },
        ] as const)
      : []),
    // The inline truthiness test is what narrows `revealLabel` to the required string.
    ...(onReveal && revealLabel
      ? ([{ id: "reveal", label: revealLabel, run: handleRevealInFileManager }] as const)
      : []),
    ...markdownFileCopyMenuItems({ targetPath, workspaceRelativePath }).map(
      ({ id, label, title }) => ({ id, label, run: () => copyPath(id, title) }),
    ),
  ];

  const showFileContextMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;

    try {
      const clicked = await api.contextMenu.show(
        sharedFileMenuItems.map(({ id, label }) => ({ id, label })),
        position,
      );
      sharedFileMenuItems.find((item) => item.id === clicked)?.run();
    } catch (cause) {
      reportMarkdownActionFailure(
        { operation: "show-file-context-menu", target: targetPath },
        cause,
      );
    }
  };

  const basename = basenamePathSegment(targetPath);

  /**
   * Opens the file through the app's `/viewer` route: a real, refreshable URL on this
   * app's own origin, so the tab carries the session cookie. The environment rides
   * along, or the route reads an absolute path off the primary environment instead.
   */
  const handleOpenInNewTab = () => {
    const { path } = splitFilePathPosition(targetPath);
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const linkEnvironmentId = threadRef?.environmentId ?? fileEnvironmentId;
    const query = linkEnvironmentId ? `?env=${encodeURIComponent(linkEnvironmentId)}` : "";
    window.open(
      `${window.location.origin}/viewer${encoded}${query}`,
      "_blank",
      "noopener,noreferrer",
    );
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const position =
      event.clientX === 0 && event.clientY === 0
        ? (() => {
            const bounds = event.currentTarget.getBoundingClientRect();
            return { x: bounds.left, y: bounds.bottom };
          })()
        : { x: event.clientX, y: event.clientY };
    void showFileContextMenu(position);
  };

  const canOpenInEditor = onOpen !== undefined;
  const canOpenInBrowser = onOpenInBrowser !== undefined;
  const canOpenInPanel = threadRef !== undefined && Boolean(panelPath);
  // The narrow sense: this picks between the integrated browser and the editable panel,
  // and for an .html file outside the workspace the rendered view is the better answer.
  const canOpenInWorkspacePanel = threadRef !== undefined && Boolean(workspaceRelativePath);
  const hasPrimaryAction = hasMarkdownFilePrimaryAction({
    canOpenInEditor,
    canOpenInBrowser,
    canOpenInPanel,
    canOpenMedia: onOpenMedia !== undefined,
  });
  const useBrowserPrimaryAction = shouldUseMarkdownFileBrowserPrimaryAction({
    iconPath,
    canOpenInEditor,
    canOpenInBrowser,
    canOpenInPanel: canOpenInWorkspacePanel,
  });
  const chipKind = documentChipKindForFileName(iconPath) ?? "mention";

  return (
    <span className="inline-flex max-w-full items-center align-middle">
      <Tooltip>
        <TooltipTrigger
          render={
            hasPrimaryAction ? (
              <ContextChip
                kind={chipKind}
                dir="ltr"
                render={<a href={href} />}
                className={MARKDOWN_FILE_LINK_CLASS_NAME}
                data-markdown-copy={copyMarkdown}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (onOpen && shouldOpenMarkdownFileLinkInEditor(event)) {
                    handleOpenInEditor();
                    return;
                  }
                  if (useBrowserPrimaryAction) {
                    handleOpenInBrowser();
                    return;
                  }
                  handleOpenInFilePreview();
                }}
                onContextMenu={handleContextMenu}
              >
                <FileTagChipContent
                  path={iconPath}
                  environmentId={environmentId}
                  label={label}
                  theme={theme}
                />
              </ContextChip>
            ) : (
              <ContextChip
                kind={chipKind}
                dir="ltr"
                render={<button type="button" />}
                aria-label={`File options for ${label}`}
                aria-haspopup="menu"
                className={cn(MARKDOWN_FILE_LINK_CLASS_NAME, "select-text")}
                data-markdown-copy={copyMarkdown}
                onClick={handleContextMenu}
                onContextMenu={handleContextMenu}
              >
                <FileTagChipContent
                  path={iconPath}
                  environmentId={environmentId}
                  label={label}
                  theme={theme}
                />
              </ContextChip>
            )
          }
        />
        <TooltipPopup side="top" variant="code">
          <div className="overflow-x-auto whitespace-nowrap scrollbar-thumb-border/78 scrollbar-track-transparent [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/78 [&::-webkit-scrollbar-track]:bg-transparent">
            <WorkspaceEntryTooltip
              path={iconPath}
              label={targetPath}
              environmentId={environmentId}
            />
          </div>
        </TooltipPopup>
      </Tooltip>
      {/* A visible affordance for the actions the native context menu also offers,
          which on a chip with a primary action otherwise takes an undiscoverable
          right-click (and none at all on touch). */}
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <button
                    type="button"
                    className="ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-accent/70 hover:text-foreground"
                    aria-label={`View options for ${basename}`}
                    onClick={(event) => event.stopPropagation()}
                  />
                }
              />
            }
          >
            <ChevronDownIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">{`View options for ${basename}`}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end">
          <MenuItem onClick={handleOpenInFilePreview}>View in side panel</MenuItem>
          {/* Needs a machine to open against, or the tab resolves the path on the
              primary environment. A thread supplies it, and so does
              `fileEnvironmentId` for markdown rendered without one. */}
          {isAbsoluteFilePath(targetPath) && (threadRef ?? fileEnvironmentId) ? (
            <MenuItem onClick={handleOpenInNewTab}>Open in new tab</MenuItem>
          ) : null}
          {sharedFileMenuItems.map((item) => (
            <MenuItem key={item.id} onClick={item.run}>
              {item.label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </span>
  );
}, areMarkdownFileLinkPropsEqual);

function areMarkdownFileLinkPropsEqual(
  previous: Readonly<MarkdownFileLinkProps>,
  next: Readonly<MarkdownFileLinkProps>,
): boolean {
  return (
    previous.href === next.href &&
    previous.targetPath === next.targetPath &&
    previous.iconPath === next.iconPath &&
    previous.environmentId === next.environmentId &&
    previous.workspaceRelativePath === next.workspaceRelativePath &&
    previous.panelPath === next.panelPath &&
    previous.label === next.label &&
    previous.copyMarkdown === next.copyMarkdown &&
    previous.theme === next.theme &&
    previous.threadRef === next.threadRef &&
    previous.fileEnvironmentId === next.fileEnvironmentId &&
    sameMarkdownFileLink(previous.fileLink, next.fileLink) &&
    previous.onOpen === next.onOpen &&
    previous.onOpenInPanel === next.onOpenInPanel &&
    previous.openInEditorMenuLabel === next.openInEditorMenuLabel &&
    previous.onOpenInBrowser === next.onOpenInBrowser &&
    previous.onOpenMedia === next.onOpenMedia &&
    previous.onReveal === next.onReveal &&
    previous.resolveCopyPaths === next.resolveCopyPaths &&
    previous.revealLabel === next.revealLabel
  );
}

function sameMarkdownFileLink(previous: MarkdownFileLinkMeta, next: MarkdownFileLinkMeta): boolean {
  return (
    previous === next ||
    (previous.filePath === next.filePath &&
      previous.workspaceLookupPath === next.workspaceLookupPath &&
      previous.targetPath === next.targetPath &&
      previous.displayPath === next.displayPath &&
      previous.workspaceRelativePath === next.workspaceRelativePath &&
      previous.basename === next.basename &&
      previous.line === next.line &&
      previous.column === next.column)
  );
}
