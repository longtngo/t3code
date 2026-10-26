import type { EnvironmentId, WorkspaceMember } from "@t3tools/contracts";
import { GitBranchIcon } from "lucide-react";
import { useState } from "react";

import { cn, randomUUID } from "~/lib/utils";
import { Button } from "./ui/button";
import WorkspaceMemberEditor from "./WorkspaceMemberEditor";
import {
  addMember,
  removeMember,
  splitMemberPath,
  updateMember,
  type WorkspaceMemberDraft,
} from "./WorkspaceMembersControl.logic";

interface WorkspaceMembersControlProps {
  readonly environmentId: EnvironmentId;
  readonly members: ReadonlyArray<WorkspaceMember>;
  /**
   * Dispatches the update and resolves to whether it succeeded. The caller is
   * responsible for surfacing failure toasts; this component only uses the
   * boolean to decide whether the editor is safe to clear — clearing it on a
   * failed dispatch would discard what the user typed.
   */
  readonly onMembersChange: (next: ReadonlyArray<WorkspaceMember>) => Promise<boolean>;
}

export default function WorkspaceMembersControl({
  environmentId,
  members,
  onMembersChange,
}: WorkspaceMembersControlProps) {
  // Only the id is held. The members array is re-rendered from the server on
  // every write, so a held member object would go stale after the first save.
  const [editingId, setEditingId] = useState<string | null>(null);

  /**
   * The list the last write submitted, held until the server echoes it: the RPC acks before the
   * 50ms-coalesced shell update, so a second write computed from the prop would undo the first.
   * Keyed on list CONTENTS, not identity: every reconnect replaces the snapshot with equal arrays.
   * `stale` holds every list this write supersedes, so an earlier write's echo is ignored.
   */
  const [pending, setPending] = useState<{
    readonly list: ReadonlyArray<WorkspaceMember>;
    readonly stale: ReadonlySet<string>;
  } | null>(null);
  const membersKey = JSON.stringify(members);
  if (pending !== null && !pending.stale.has(membersKey)) {
    // The list moved past everything in flight, so the server is authoritative
    // again. Adjusting state during render is React's own alternative to a
    // synchronizing effect.
    setPending(null);
  }
  const current = pending?.list ?? members;
  const editing = current.find((member) => member.id === editingId) ?? null;

  const writeMembers = async (next: ReadonlyArray<WorkspaceMember>): Promise<boolean> => {
    // State rather than a ref: the rows and the next click's handler both have to
    // see the submitted list, which means re-rendering from it.
    setPending((held) => ({
      list: next,
      stale: new Set([
        ...(held?.stale ?? []),
        membersKey,
        ...(held === null ? [] : [JSON.stringify(held.list)]),
      ]),
    }));
    // Only retract THIS write; a later one already supersedes it.
    const retract = () => setPending((held) => (held?.list === next ? null : held));
    let succeeded: boolean;
    try {
      succeeded = await onMembersChange(next);
    } catch {
      // Both callers report their own failures and resolve `false`, so a rejection
      // is contract-breaking. Treat it as a failed write anyway: leaving the
      // optimistic list in place would show a change that was never stored, with
      // nothing to correct it until the next echo.
      retract();
      return false;
    }
    if (!succeeded) retract();
    return succeeded;
  };

  const handleSubmit = async (draft: WorkspaceMemberDraft): Promise<boolean> => {
    const next =
      editing === null
        ? addMember(current, { ...draft, id: randomUUID() })
        : updateMember(current, editing.id, draft);
    const succeeded = await writeMembers(next);
    if (succeeded && editing !== null) setEditingId(null);
    return succeeded;
  };

  return (
    <div className="flex flex-col gap-4">
      {current.length === 0 ? (
        <p className="rounded-lg border border-border/70 border-dashed px-3 py-6 text-center text-muted-foreground text-sm">
          No repositories attached yet. Attach one below to let this project's threads read and
          write it.
        </p>
      ) : (
        <ul className="divide-y divide-border/70 overflow-hidden rounded-lg border border-border/70">
          {current.map((workspaceMember) => {
            const { parent, name } = splitMemberPath(workspaceMember.path);
            const isEditing = workspaceMember.id === editingId;
            return (
              <li
                className={cn("flex items-center gap-3 px-3 py-2.5", isEditing && "bg-accent/40")}
                key={workspaceMember.id}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm">
                    <span className="text-muted-foreground">{parent}</span>
                    <span className="font-medium text-foreground">{name}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1 text-muted-foreground text-xs">
                    <GitBranchIcon aria-hidden="true" className="size-3 shrink-0" />
                    <span className="truncate font-mono">{workspaceMember.integrationBranch}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    aria-label={`Edit ${workspaceMember.title}`}
                    onClick={() => setEditingId(isEditing ? null : workspaceMember.id)}
                    size="sm"
                    variant="ghost"
                  >
                    Edit
                  </Button>
                  <Button
                    aria-label={`Detach ${workspaceMember.title}`}
                    onClick={() => {
                      if (isEditing) setEditingId(null);
                      void writeMembers(removeMember(current, workspaceMember.id));
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    Detach
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <WorkspaceMemberEditor
        editing={editing}
        environmentId={environmentId}
        // Remounting on target change resets the draft to the new member's
        // values without a synchronizing effect.
        key={editing?.id ?? "attach"}
        members={current}
        onCancel={() => setEditingId(null)}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
