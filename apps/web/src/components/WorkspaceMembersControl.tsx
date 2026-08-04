import { useState } from "react";

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
  onMembersChange: (next: ReadonlyArray<WorkspaceMember>) => void;
}

export default function WorkspaceMembersControl({
  members,
  onMembersChange,
}: WorkspaceMembersControlProps) {
  const [path, setPath] = useState("");
  const [integrationBranch, setIntegrationBranch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    const message = validateNewMember({ path, integrationBranch }, members);
    setError(message);
    if (message !== null) return;
    onMembersChange(
      addMember(members, { id: randomUUID(), path, integrationBranch }),
    );
    setPath("");
    setIntegrationBranch("");
  };

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2">
        {members.map((member) => (
          <li key={member.id} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{member.title}</div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {member.path}
              </div>
            </div>
            <span className="shrink-0 font-mono text-xs">{member.integrationBranch}</span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Detach ${member.title}`}
              onClick={() => onMembersChange(removeMember(members, member.id))}
            >
              Detach
            </Button>
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2">
        <Label htmlFor="workspace-member-path">Repository path</Label>
        <Input
          id="workspace-member-path"
          value={path}
          placeholder="/Users/you/src/uni/prm_portal_api"
          onChange={(event) => setPath(event.target.value)}
        />
        <Label htmlFor="workspace-member-branch">Integration branch</Label>
        <Input
          id="workspace-member-branch"
          value={integrationBranch}
          placeholder="pickup-v2"
          onChange={(event) => setIntegrationBranch(event.target.value)}
        />
        {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button onClick={handleAdd}>Attach repository</Button>
      </div>
    </div>
  );
}
