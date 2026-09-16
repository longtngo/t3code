import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerSettings } from "@t3tools/contracts";
import { resolveJiraTicketLinks, type JiraTicketLinks } from "@t3tools/shared/jiraTicketLinks";
import { useMemo } from "react";

import { serverEnvironment } from "../state/server";

// Module-level selectors keep the mapped atoms stable, and string results only
// re-render the caller when these two settings change.
const selectBaseUrl = (settings: ServerSettings | null) => settings?.jiraBaseUrl ?? "";
const selectProjectKeys = (settings: ServerSettings | null) => settings?.jiraProjectKeys ?? "";

/** The environment's Jira link settings, stable while they are unchanged. */
export function useJiraTicketLinks(environmentId: EnvironmentId): JiraTicketLinks | null {
  const settingsAtom = serverEnvironment.settingsValueAtom(environmentId);
  const baseUrl = useAtomValue(settingsAtom, selectBaseUrl);
  const projectKeys = useAtomValue(settingsAtom, selectProjectKeys);
  return useMemo(() => resolveJiraTicketLinks(baseUrl, projectKeys), [baseUrl, projectKeys]);
}
