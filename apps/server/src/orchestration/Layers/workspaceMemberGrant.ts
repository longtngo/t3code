/**
 * Deciding whether a running provider session still has the workspace member
 * grant its project asks for.
 *
 * The grant (`additionalDirectories` for the Claude adapter) is fixed when the
 * session starts, so attaching or detaching a member mid-thread only takes
 * effect if the session is restarted — otherwise the very next tool call in the
 * new repository prompts for approval and the feature reads as broken.
 *
 * @module workspaceMemberGrant
 */
import { ProviderDriverKind } from "@t3tools/contracts";

/** Driver slug of the Claude Agent adapter — the only grant consumer today. */
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");

/**
 * Drivers that consume `ProviderSessionStartInput.workspaceMemberPaths` and
 * echo the granted set back on their `ProviderSession`.
 *
 * The set matters because a driver that ignores the field also never echoes
 * it, so its sessions always report an empty grant. Comparing those against a
 * non-empty desired set would read as "members changed" on every single turn
 * and restart the session each time.
 */
const DRIVERS_GRANTING_WORKSPACE_MEMBERS: ReadonlySet<ProviderDriverKind> = new Set([
  CLAUDE_AGENT_DRIVER,
]);

export function providerGrantsWorkspaceMembers(
  provider: ProviderDriverKind | undefined,
): provider is ProviderDriverKind {
  return provider !== undefined && DRIVERS_GRANTING_WORKSPACE_MEMBERS.has(provider);
}

/**
 * True when the running session's grant differs from what the project now
 * declares, and the session's driver is one that acts on the grant.
 */
export function workspaceMemberGrantChanged(input: {
  readonly sessionProvider: ProviderDriverKind | undefined;
  readonly sessionMemberPaths: ReadonlyArray<string> | undefined;
  readonly desiredMemberPaths: ReadonlyArray<string>;
}): boolean {
  if (!providerGrantsWorkspaceMembers(input.sessionProvider)) {
    return false;
  }
  const granted = input.sessionMemberPaths ?? [];
  return (
    granted.length !== input.desiredMemberPaths.length ||
    input.desiredMemberPaths.some((path, index) => granted[index] !== path)
  );
}
