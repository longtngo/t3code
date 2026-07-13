import { useEffect, useState } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import type { ComposerShortcut } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

let shortcutIdCounter = 0;
/** A locally-unique id for a new shortcut (ids only need to be stable within this device). */
function newShortcutId(): string {
  shortcutIdCounter += 1;
  return `sc-${Date.now().toString(36)}-${shortcutIdCounter}`;
}

/** Drop shortcuts that would render as an empty chip / insert nothing. */
function pruneEmpty(list: readonly ComposerShortcut[]): ComposerShortcut[] {
  return list.filter((s) => s.label.trim().length > 0 || s.text.trim().length > 0);
}

/**
 * The manage-shortcuts modal: list, add, edit, delete, and reorder. Edits are held in a local
 * draft and only committed on Save, so Cancel/Escape discards them.
 */
function ShortcutManagerDialog({
  open,
  onOpenChange,
  shortcuts,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shortcuts: readonly ComposerShortcut[];
  onSave: (next: ComposerShortcut[]) => void;
}) {
  const [draft, setDraft] = useState<ComposerShortcut[]>([]);

  // Re-seed the draft from the saved list each time the dialog opens.
  useEffect(() => {
    if (open) setDraft(shortcuts.map((s) => ({ ...s })));
  }, [open, shortcuts]);

  const update = (index: number, patch: Partial<ComposerShortcut>) =>
    setDraft((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  const remove = (index: number) => setDraft((prev) => prev.filter((_, i) => i !== index));
  const move = (index: number, delta: number) =>
    setDraft((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved as ComposerShortcut);
      return next;
    });
  const add = () =>
    setDraft((prev) => [...prev, { id: newShortcutId(), label: "", text: "" }]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Custom prompt shortcuts</DialogTitle>
          <DialogDescription>
            Buttons above the composer that insert a saved prompt. Reorder with the arrows.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-2.5">
          {draft.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No shortcuts yet. Add one to get started.
            </p>
          ) : (
            draft.map((shortcut, index) => (
              <div
                key={shortcut.id}
                className="flex items-start gap-2 rounded-lg border bg-card p-2"
              >
                <div className="flex flex-col gap-1">
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="Move up"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ChevronUpIcon className="size-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="Move down"
                    disabled={index === draft.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ChevronDownIcon className="size-3.5" />
                  </Button>
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="space-y-1">
                    <label
                      className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                      htmlFor={`shortcut-label-${shortcut.id}`}
                    >
                      Button label
                    </label>
                    <Input
                      id={`shortcut-label-${shortcut.id}`}
                      size="sm"
                      value={shortcut.label}
                      maxLength={40}
                      placeholder="e.g. Write tests"
                      onChange={(event) => update(index, { label: event.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <label
                      className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                      htmlFor={`shortcut-text-${shortcut.id}`}
                    >
                      Prompt text
                    </label>
                    <Textarea
                      id={`shortcut-text-${shortcut.id}`}
                      size="sm"
                      value={shortcut.text}
                      placeholder="The text inserted into the composer…"
                      onChange={(event) => update(index, { text: event.target.value })}
                    />
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Delete shortcut"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => remove(index)}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
            ))
          )}
          <Button variant="outline" className="w-full border-dashed" onClick={add}>
            <PlusIcon className="size-4" /> Add shortcut
          </Button>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onSave(pruneEmpty(draft))}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * The shortcuts strip + gear that live in the composer's tasks bar. Chips insert their prompt
 * text into the composer (via `onInsert`); the gear opens the manager. The strip stretches so
 * the gear sits at the far right of the bar.
 */
export function ComposerShortcutsControls({
  onInsert,
  disabled = false,
}: {
  onInsert: (text: string) => void;
  disabled?: boolean;
}) {
  const shortcuts = useSettings((s) => s.composerShortcuts);
  const { updateSettings } = useUpdateSettings();
  const [managerOpen, setManagerOpen] = useState(false);

  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {shortcuts.map((shortcut) => (
          <button
            key={shortcut.id}
            type="button"
            disabled={disabled}
            title={shortcut.text}
            onClick={() => onInsert(shortcut.text)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border bg-background px-2.5 py-1 text-[11px] leading-none text-foreground",
              "hover:border-primary/40 hover:bg-accent",
              "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-background",
            )}
          >
            <span className="font-semibold text-primary">/</span>
            {shortcut.label || "shortcut"}
          </button>
        ))}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="manage custom prompt shortcut"
              onClick={() => setManagerOpen(true)}
              className="ml-auto inline-flex shrink-0 items-center rounded-md border bg-card p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <SettingsIcon className="size-3.5" />
            </button>
          }
        />
        <TooltipPopup side="top">manage custom prompt shortcut</TooltipPopup>
      </Tooltip>
      <ShortcutManagerDialog
        open={managerOpen}
        onOpenChange={setManagerOpen}
        shortcuts={shortcuts}
        onSave={(next) => {
          updateSettings({ composerShortcuts: next });
          setManagerOpen(false);
        }}
      />
    </>
  );
}
