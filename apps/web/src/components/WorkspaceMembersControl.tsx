import { useId, useState } from "react";

import type { WorkspaceMember } from "@t3tools/contracts";

import { randomUUID } from "~/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  addMember,
  removeMember,
  validateNewMember,
} from "./WorkspaceMembersControl.logic";

interface WorkspaceMembersControlProps {
  members: ReadonlyArray<WorkspaceMember>;
  /**
   * Dispatches the update and resolves to whether it succeeded. The caller
   * (SidebarV2) is responsible for surfacing failure toasts; this component
   * only uses the boolean to decide whether the add-form inputs are safe to
   * clear — clearing them on a failed dispatch would discard what the user
   * typed.
   */
  onMembersChange: (next: ReadonlyArray<WorkspaceMember>) => Promise<boolean>;
}

export default function WorkspaceMembersControl({
  members,
  onMembersChange,
}: WorkspaceMembersControlProps) {
  const [path, setPath] = useState("");
  const [integrationBranch, setIntegrationBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The control renders once per project in a grouped project's settings
  // dialog, so hard-coded element ids would make every <label> point at the
  // first section's inputs.
  const controlId = useId();
  const pathInputId = `${controlId}-path`;
  const branchInputId = `${controlId}-branch`;

  const handleAdd = async () => {
    const message = validateNewMember({ path, integrationBranch }, members);
    setError(message);
    if (message !== null) return;
    const succeeded = await onMembersChange(
      addMember(members, { id: randomUUID(), path, integrationBranch }),
    );
    if (succeeded) {
      setPath("");
      setIntegrationBranch("");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2">
        {members.map((workspaceMember) => (
          <li key={workspaceMember.id} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{workspaceMember.title}</div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {workspaceMember.path}
              </div>
            </div>
            <span className="shrink-0 font-mono text-xs">
              {workspaceMember.integrationBranch}
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Detach ${workspaceMember.title}`}
              onClick={() => {
                void onMembersChange(removeMember(members, workspaceMember.id));
              }}
            >
              Detach
            </Button>
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2">
        <Label htmlFor={pathInputId}>Repository path</Label>
        <Input
          id={pathInputId}
          value={path}
          placeholder="~/src/uni/prm_portal_api"
          onChange={(event) => setPath(event.target.value)}
        />
        <Label htmlFor={branchInputId}>Integration branch</Label>
        <Input
          id={branchInputId}
          value={integrationBranch}
          placeholder="pickup-v2"
          onChange={(event) => setIntegrationBranch(event.target.value)}
        />
        {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button
          onClick={() => {
            void handleAdd();
          }}
        >
          Attach repository
        </Button>
      </div>
    </div>
  );
}
