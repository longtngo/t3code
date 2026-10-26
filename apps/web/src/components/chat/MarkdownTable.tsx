import { Check, Copy, Maximize2 } from "lucide";
import { useRef, useState, type ComponentProps } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  serializeTableElementToCsv,
  serializeTableElementToMarkdown,
} from "../../markdown-clipboard";
import { MorphIcon } from "../MorphIcon";
import { Button } from "../ui/button";
import { Dialog, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { reportMarkdownActionFailure } from "./markdownActionFailure";

// FORK: cells wrap to fit the lane, and the footer button opens the whole table in a
// full-width dialog instead of upstream's per-cell expand/collapse toggle.
export function MarkdownTable({ children, ...props }: ComponentProps<"table">) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [expandedOpen, setExpandedOpen] = useState(false);
  const { copyToClipboard, isCopied: copied } = useCopyToClipboard<"markdown" | "csv">({
    timeout: 1200,
    onError: (cause, format) =>
      reportMarkdownActionFailure({ operation: "copy-table", format }, cause),
  });
  const expandLabel = "Expand table";
  const copyLabel = copied ? "Copied" : "Copy table";

  const handleCopy = (format: "markdown" | "csv") => {
    const table = containerRef.current?.querySelector("table");
    if (!table) return;
    copyToClipboard(
      format === "markdown"
        ? serializeTableElementToMarkdown(table)
        : serializeTableElementToCsv(table),
      format,
    );
  };

  return (
    <div ref={containerRef} className="chat-markdown-table-container">
      <ScrollArea radius="none" chainVerticalScroll scrollFade className="w-full max-w-full">
        <table {...props}>{children}</table>
      </ScrollArea>
      {/* Stays within the row's px-1: the chat lane clips sideways overflow. */}
      <div className="mt-0.5 -mx-1 flex items-center justify-between select-none">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-xs"
                onClick={() => setExpandedOpen(true)}
                aria-label={expandLabel}
              />
            }
          >
            <MorphIcon className="size-3" icon={Maximize2} />
          </TooltipTrigger>
          <TooltipPopup side="top">{expandLabel}</TooltipPopup>
        </Tooltip>
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="icon-xs"
                      aria-label={copyLabel}
                    />
                  }
                />
              }
            >
              <MorphIcon className="size-3" icon={copied ? Check : Copy} />
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <MenuItem onClick={() => handleCopy("markdown")}>Copy as Markdown</MenuItem>
            <MenuItem onClick={() => handleCopy("csv")}>Copy as CSV</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <Dialog open={expandedOpen} onOpenChange={setExpandedOpen}>
        <DialogPopup className="max-h-[88vh] max-w-[min(96vw,72rem)]">
          <DialogTitle className="sr-only">Expanded table</DialogTitle>
          <DialogPanel>
            <div className="chat-markdown">
              <table {...props}>{children}</table>
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
