import type { JiraTicketLinks } from "@t3tools/shared/jiraTicketLinks";
import { createContext } from "react";

/** Provided by screens that know their environment's Jira settings; null turns linking off. */
export const JiraTicketLinksContext = createContext<JiraTicketLinks | null>(null);
