/**
 * Deciding whether a running provider session still has the workspace member
 * grant its project asks for.
 *
 * The grant (`additionalDirectories` for the Claude adapter) is fixed when the
 * session starts, so attaching or detaching a member mid-thread only takes
 * effect if the session is restarted — otherwise the very next tool call in the
 * new repository prompts for approval and the feature reads as broken.
 *
 * Which providers act on the grant is not decided here: the adapter declares it
 * through `ProviderAdapterCapabilities.grantsWorkspaceMemberPaths`, because only
 * the adapter knows whether its transport carries the field. This module used to
 * keep a hardcoded set of driver slugs, which was correct but had no way to stay
 * correct.
 *
 * @module workspaceMemberGrant
 */

/**
 * True when the running session's grant differs from what the project now
 * declares, on an adapter that acts on the grant.
 *
 * `providerGrantsMemberPaths` comes from the adapter's own capabilities. When it
 * is false this always answers false: such an adapter never echoes a granted set
 * back, so its sessions report an empty grant, and comparing that against a
 * non-empty desired set would read as "members changed" on every single turn and
 * restart the session each time.
 */
export function workspaceMemberGrantChanged(input: {
  readonly providerGrantsMemberPaths: boolean;
  readonly sessionMemberPaths: ReadonlyArray<string> | undefined;
  readonly desiredMemberPaths: ReadonlyArray<string>;
}): boolean {
  if (!input.providerGrantsMemberPaths) {
    return false;
  }
  const granted = input.sessionMemberPaths ?? [];
  return (
    granted.length !== input.desiredMemberPaths.length ||
    input.desiredMemberPaths.some((path, index) => granted[index] !== path)
  );
}
