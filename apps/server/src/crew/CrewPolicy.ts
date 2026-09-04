/**
 * Pure policy helpers shared by the toolkit, the service and the sweep.
 *
 * Kept separate from `CrewService` so each rule is testable without a database,
 * a git repository, or a provider — and so the bounds are stated once.
 *
 * @module crew/CrewPolicy
 */
import {
  CREW_PROMPT_BYTE_LIMIT,
  CREW_REPORT_NOTE_BYTE_LIMIT,
  type CrewReport,
  type CrewReportState,
} from "@t3tools/contracts";

/** Default concurrent-task cap when the env var is absent or unusable. */
export const DEFAULT_CREW_MAX_CONCURRENT_TASKS = 4;

export const CREW_MAX_CONCURRENT_TASKS_ENV = "T3CODE_CREW_MAX_CONCURRENT_TASKS";

/**
 * The master switch lives in Settings (`enableCrew`), not the environment.
 *
 * Two readers, both per call, so "off" takes effect with no restart:
 * `CrewService.dispatch` refuses, and `CrewSweep.runOnce` narrows what it
 * delivers to answers only.
 *
 * What it deliberately does NOT gate, and why each one would be a trap:
 * - **MCP tool registration.** A tool listing cannot be retracted once a server
 *   is running, so gating it would only ever mean "the switch's position at
 *   process start" — a second, quieter contract. The tools are always
 *   advertised and refuse when off.
 * - **`teardown`, `status`, `report`, `answer` and the Crew panel.** These are
 *   the way out for work already dispatched; a switch that closes them strands
 *   it.
 * - **Delivery of `answer` rows.** Accepting an answer while refusing to deliver
 *   it is worse than refusing it: the panel drops the retry affordance the
 *   moment the row is written, so the operator's reply is swallowed for good and
 *   the crewmate stays blocked. See `CrewSweep.runOnce`.
 * - **The zombie scan.** Stopping a session for an already-closed task is
 *   cleanup, not new work.
 *
 * Distinct from `T3CODE_CREW_MAX_CONCURRENT_TASKS=0`, which refuses new
 * dispatches but leaves the sweep running and the panel polling.
 */
export const crewEnabled = (settings: { readonly enableCrew: boolean }): boolean =>
  settings.enableCrew;

/**
 * Reads the cap from an environment record.
 *
 * `0` disables crew, and so do `"00"` and `" 0"` — an operator who typed a zero
 * meant it, whatever the whitespace. Anything that is not a non-negative integer
 * (`-1`, `abc`, `""`) falls back to the default rather than disabling crew
 * silently, because a typo that turns the feature off with no error is worse than
 * a typo that leaves it at its documented default.
 */
export function resolveCrewMaxConcurrentTasks(env: Record<string, string | undefined>): number {
  const raw = env[CREW_MAX_CONCURRENT_TASKS_ENV];
  if (raw === undefined) {
    return DEFAULT_CREW_MAX_CONCURRENT_TASKS;
  }
  const trimmed = raw.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) {
    return DEFAULT_CREW_MAX_CONCURRENT_TASKS;
  }
  return Number.parseInt(trimmed, 10);
}

const encoder = new TextEncoder();

export const byteLength = (text: string): number => encoder.encode(text).length;

export const isPromptWithinBound = (prompt: string): boolean =>
  byteLength(prompt) <= CREW_PROMPT_BYTE_LIMIT;

export const isNoteWithinBound = (note: string): boolean =>
  byteLength(note) <= CREW_REPORT_NOTE_BYTE_LIMIT;

/**
 * Bounds a note on a character boundary, accounting for the prefix that will be
 * prepended to it.
 *
 * Slicing by `length` would count UTF-16 units and could still exceed the byte
 * bound; slicing the encoded bytes could split a code point. This walks down from
 * the character count until the encoding fits.
 */
export function boundNoteBytes(note: string, limit: number): string {
  if (byteLength(note) <= limit) {
    return note;
  }
  let end = note.length;
  while (end > 0 && byteLength(note.slice(0, end)) > limit) {
    end -= 1;
  }
  return note.slice(0, end);
}

/** Normalizes line endings before bounding, so the bound is over what is stored. */
export const normalizeNote = (note: string): string => note.replace(/\r\n?/g, "\n");

/**
 * The destination of a report is the thread that needs to read it: the bridge for
 * a crewmate's report, the crewmate for the bridge's answer.
 *
 * Keying delivery on the bridge instead is what silently loses an operator's
 * answer — the answer sorts into the same pass as a report on the same task,
 * "rides" the turn that report dispatched to a *different* thread, and is stamped
 * handled while the crewmate stays blocked holding a slot.
 */
export const destinationOf = (
  report: Pick<CrewReport, "state">,
  task: { readonly parentThreadId: string; readonly crewThreadId: string },
): string => (report.state === "answer" ? task.crewThreadId : task.parentThreadId);

/** Reports that must reach the destination on a turn if the append did not land. */
export const requiresTurn = (state: CrewReportState): boolean => state !== "progress";

/** `crew_report` may write every state except `answer`, which is crew_answer's. */
export const isWritableReportState = (state: string): state is CrewReportState =>
  state === "progress" || state === "needs-decision" || state === "done" || state === "failed";
