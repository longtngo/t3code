import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import type { EnvironmentId, WorkspaceMember } from "@t3tools/contracts";
import { CornerLeftUpIcon, FolderIcon, GitBranchIcon } from "lucide-react";
import { useDeferredValue, useEffect, useId, useMemo, useState } from "react";

import { filesystemEnvironment } from "../state/filesystem";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "./ui/autocomplete";
import {
  canAutofillBranch,
  resolveBranchOptions,
  resolveMemberCwd,
  splitMemberPath,
  validateMemberDraft,
  type WorkspaceMemberDraft,
} from "./WorkspaceMembersControl.logic";

/**
 * Local branches only, and enough of them that the client can filter without a
 * round trip per keystroke — the repositories this was built for carry between
 * 6 and 24. An integration branch is checked out in the member's worktree, so a
 * remote-only ref is never the answer.
 */
const BRANCH_LIST_LIMIT = 200;

const EMPTY_BROWSE_ENTRIES: ReadonlyArray<{ readonly name: string; readonly fullPath: string }> =
  [];

interface WorkspaceMemberEditorProps {
  readonly environmentId: EnvironmentId;
  /** Existing members, so a draft can be checked against them for duplicates. */
  readonly members: ReadonlyArray<WorkspaceMember>;
  /** The member being changed, or null when attaching a new one. */
  readonly editing: WorkspaceMember | null;
  /** Resolves to whether the write succeeded. */
  readonly onSubmit: (draft: WorkspaceMemberDraft) => Promise<boolean>;
  readonly onCancel: () => void;
}

/**
 * The one editor in the dialog: it attaches a repository, or edits the one
 * selected from the list. The caller remounts it (via `key`) when the target
 * changes, so the draft state below always starts from the right values without
 * a synchronizing effect.
 */
export default function WorkspaceMemberEditor({
  environmentId,
  members,
  editing,
  onSubmit,
  onCancel,
}: WorkspaceMemberEditorProps) {
  const [path, setPath] = useState(editing?.path ?? "");
  const [branch, setBranch] = useState(editing?.integrationBranch ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Which branch value an autofill wrote, and which repository it was written
  // for. Together they let a repository change refill the field while never
  // overwriting a branch the user typed.
  const [autofilledBranch, setAutofilledBranch] = useState<string | null>(null);
  const [autofilledForCwd, setAutofilledForCwd] = useState<string | null>(null);
  const [isPathOpen, setIsPathOpen] = useState(false);

  const fieldId = useId();
  const pathInputId = `${fieldId}-path`;
  const branchInputId = `${fieldId}-branch`;

  // ---------------------------------------------------------------------------
  // Repository path
  // ---------------------------------------------------------------------------
  const browsePath = useMemo(() => getFilesystemBrowsePath(path), [path]);
  const browseQuery = useEnvironmentQuery(
    browsePath.isBrowsing && browsePath.directoryPath.length > 0
      ? filesystemEnvironment.browse({
          environmentId,
          input: { partialPath: browsePath.directoryPath },
        })
      : null,
  );
  const { visibleEntries } = useMemo(
    () =>
      filterFilesystemBrowseEntries(
        browseQuery.data?.entries ?? EMPTY_BROWSE_ENTRIES,
        browsePath.filterQuery,
      ),
    [browseQuery.data?.entries, browsePath.filterQuery],
  );
  // The server returns directories only, so every row is a folder to descend
  // into. Selecting one appends a separator, which re-runs the browse against
  // that folder — the same drill-down the command palette and the mobile
  // "Add project" screen use. Trailing separators are stripped on save.
  const pathItems = useMemo(() => {
    const entries = visibleEntries.map((entry) => `${entry.fullPath}/`);
    return browsePath.canBrowseUp && browsePath.parentPath !== null
      ? [browsePath.parentPath, ...entries]
      : entries;
  }, [browsePath.canBrowseUp, browsePath.parentPath, visibleEntries]);

  // ---------------------------------------------------------------------------
  // Integration branch
  // ---------------------------------------------------------------------------
  // Deferred so that typing a path does not fire a git call per character.
  const deferredPath = useDeferredValue(path);
  const branchCwd = useMemo(() => resolveMemberCwd(deferredPath), [deferredPath]);
  const refsQuery = useEnvironmentQuery(
    branchCwd !== null
      ? vcsEnvironment.listRefs({
          environmentId,
          input: { cwd: branchCwd, refKind: "local", limit: BRANCH_LIST_LIMIT },
        })
      : null,
  );
  const refs = refsQuery.data?.refs;
  const isRepository = refsQuery.data?.isRepo ?? true;
  const currentBranch = useMemo(
    () => refs?.find((ref) => ref.current)?.name ?? null,
    [refs],
  );
  const branchItems = useMemo(
    () => resolveBranchOptions(refs?.map((ref) => ref.name) ?? [], branch),
    [branch, refs],
  );

  // Picking a repository fills in the branch it currently has checked out.
  useEffect(() => {
    if (branchCwd === null || currentBranch === null || autofilledForCwd === branchCwd) return;
    setAutofilledForCwd(branchCwd);
    if (!canAutofillBranch(branch, autofilledBranch)) return;
    setAutofilledBranch(currentBranch);
    setBranch(currentBranch);
  }, [autofilledBranch, autofilledForCwd, branch, branchCwd, currentBranch]);

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------
  const handleSubmit = async () => {
    const draft: WorkspaceMemberDraft = { path, integrationBranch: branch };
    const message = validateMemberDraft(draft, members, editing?.id);
    setError(message);
    if (message !== null) return;
    setIsSaving(true);
    try {
      const succeeded = await onSubmit(draft);
      // Only a successful write clears the form; clearing on failure would
      // discard what the user typed with nothing to recover it from.
      if (succeeded && editing === null) {
        setPath("");
        setBranch("");
        setAutofilledBranch(null);
        setAutofilledForCwd(null);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const branchHint = (() => {
    if (branchCwd === null) return "Choose a repository to list its branches.";
    if (!isRepository) return "That folder is not a git repository.";
    if (currentBranch !== null && branch.trim() === currentBranch) {
      return `${currentBranch} is checked out in that repository.`;
    }
    return null;
  })();

  return (
    <div className="rounded-lg border border-border/70 bg-muted/40 p-3">
      {/* The eyebrow is uppercased as a section marker, but a repository name is
          a proper noun and keeps its own casing — and its monospace face, which
          is how paths and refs are set everywhere else in this dialog. */}
      <p className="mb-3 flex items-baseline gap-1.5 text-muted-foreground text-xs">
        <span className="font-medium uppercase tracking-wide">
          {editing === null ? "Attach a repository" : "Edit"}
        </span>
        {editing !== null ? (
          <span className="min-w-0 truncate font-mono text-foreground">{editing.title}</span>
        ) : null}
      </p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={pathInputId}>Repository path</Label>
        <Autocomplete
          filter={null}
          items={pathItems}
          onOpenChange={(nextOpen) => setIsPathOpen(nextOpen)}
          onValueChange={(nextValue, details) => {
            setPath(nextValue);
            setError(null);
            // Selecting a folder descends into it, so the list must stay up to
            // show what is inside rather than closing on every step down.
            if (details.reason === "item-press") setIsPathOpen(true);
          }}
          open={isPathOpen}
          openOnInputClick
          value={path}
        >
          <AutocompleteInput
            id={pathInputId}
            placeholder="~/src/uni/prm_portal_api"
            startAddon={<FolderIcon />}
          />
          <AutocompletePopup className="w-(--anchor-width)">
            <AutocompleteEmpty>
              {!browsePath.isBrowsing
                ? "Start with ~/ or / to browse folders."
                : browseQuery.isPending
                  ? "Reading folder…"
                  : "No folders here."}
            </AutocompleteEmpty>
            <AutocompleteList>
              {pathItems.map((itemPath) => {
                const isParent = itemPath === browsePath.parentPath;
                const { name } = splitMemberPath(itemPath);
                return (
                  <AutocompleteItem
                    className="gap-2 font-mono text-xs"
                    key={itemPath}
                    value={itemPath}
                  >
                    {isParent ? (
                      <CornerLeftUpIcon className="size-3.5 shrink-0" />
                    ) : (
                      <FolderIcon className="size-3.5 shrink-0" />
                    )}
                    <span className="truncate">{isParent ? "Go up" : name}</span>
                  </AutocompleteItem>
                );
              })}
            </AutocompleteList>
          </AutocompletePopup>
        </Autocomplete>
      </div>

      <div className="mt-3 flex flex-col gap-1.5">
        <Label htmlFor={branchInputId}>Integration branch</Label>
        <Autocomplete
          filter={null}
          items={branchItems}
          onValueChange={(nextValue) => {
            setBranch(nextValue);
            setError(null);
          }}
          openOnInputClick
          value={branch}
        >
          <AutocompleteInput
            disabled={branchCwd === null}
            id={branchInputId}
            placeholder="pickup-v2"
            startAddon={<GitBranchIcon />}
          />
          <AutocompletePopup className="w-(--anchor-width)">
            <AutocompleteEmpty>
              {refsQuery.isPending ? "Reading branches…" : "No branches match."}
            </AutocompleteEmpty>
            <AutocompleteList>
              {branchItems.map((branchName) => (
                <AutocompleteItem
                  className="justify-between gap-2 font-mono text-xs"
                  key={branchName}
                  value={branchName}
                >
                  <span className="truncate">{branchName}</span>
                  {branchName === currentBranch ? (
                    <span className="shrink-0 font-sans text-[0.6875rem] text-muted-foreground">
                      checked out
                    </span>
                  ) : null}
                </AutocompleteItem>
              ))}
            </AutocompleteList>
          </AutocompletePopup>
        </Autocomplete>
        {branchHint !== null ? (
          <p className="text-muted-foreground text-xs">{branchHint}</p>
        ) : null}
      </div>

      {error !== null ? <p className="mt-3 text-destructive text-sm">{error}</p> : null}

      <div className="mt-3 flex justify-end gap-2">
        {editing !== null ? (
          <Button onClick={onCancel} size="sm" variant="outline">
            Cancel
          </Button>
        ) : null}
        <Button
          disabled={isSaving}
          onClick={() => {
            void handleSubmit();
          }}
          size="sm"
        >
          {editing === null ? "Attach repository" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
