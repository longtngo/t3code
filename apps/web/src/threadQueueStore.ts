/**
 * The sidebar Queue: threads (started or still drafts) waiting to send their composer draft while
 * fewer threads are busy than the queue's slots.
 *
 * Where it lives is the store's mode (`resolveThreadQueueMode`):
 * - local: this device only (the v1 key), shared by its tabs; a claim is "write, wait, re-read".
 * - server: the primary's server holds the document. This tab shows it with its own unconfirmed
 *   changes on top and writes them one at a time by compare-and-set. v1 is neither read nor
 *   written, so an old-bundle tab and a rollback both find their own queue untouched.
 * - pending: before the live document arrives, or while the primary is disconnected. The last
 *   mirror is shown read-only; only what already happened (a hand send's removal, a send's
 *   outcome) is kept, and applied later.
 */
import {
  THREAD_QUEUE_FAILURE_MESSAGE_MAX_LENGTH,
  THREAD_QUEUE_FAILURE_TITLE_MAX_LENGTH,
  ThreadQueueDocument as WireThreadQueueDocumentSchema,
  type EnvironmentId,
  type ThreadQueueDocument as WireThreadQueueDocument,
  type ThreadQueueSetInput,
  type ThreadQueueSetResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import type { DraftId } from "./composerDraftStore";
import { isHostedStaticApp } from "./hostedPairing";
import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";
import { isLocalEnvironmentDisabled } from "./localEnvironment";
import {
  QUEUE_SLOT_SETTINGS_STORAGE_KEY,
  useQueueSlotSettingsStore,
} from "./queueSlotSettingsStore";
import {
  applyQueueAction,
  EMPTY_QUEUE_DATA,
  queueEntryLabel,
  resolveThreadQueueMode,
  sameQueueData,
  type QueueAction,
  type ThreadQueueData,
  type ThreadQueueDocument,
  type ThreadQueueEntry,
  type ThreadQueueFailure,
  type ThreadQueueInFlight,
  type ThreadQueueMode,
  type ThreadQueuePrior,
} from "./threadQueueRules";

export const THREAD_QUEUE_STORAGE_KEY = "t3code:thread-queue:v1";
const THREAD_QUEUE_MIRROR_KEY = "t3code:thread-queue-mirror:v2";
const QUEUE_DEVICE_ID_KEY = "t3code:queue-device-id:v1";
/**
 * Absent until this device first runs in server mode; then "ran" each time it does, and "loaded"
 * once local mode has loaded v1 after it. v1 still holds what was queued before server mode, some
 * of it since sent by hand, so local mode loads it paused once rather than send it again.
 */
const SEEN_SERVER_KEY = "t3code:thread-queue-seen-server:v1";
/** How long a claiming tab waits for another tab's competing claim to land in local storage. */
const LOCAL_CLAIM_SETTLE_MS = 300;
/** First and longest wait before re-asking the server about a change whose reply was lost. */
const LOST_REPLY_RETRY_MS = 1_000;
const LOST_REPLY_RETRY_MAX_MS = 30_000;
/** Already happened while pending, so kept and applied later; all are claim-guarded and idempotent. */
const HELD_KINDS: ReadonlySet<QueueAction["kind"]> = new Set([
  "remove-sent",
  "mark-sent",
  "fail",
  "release-hand-sent",
]);

function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

let deviceId: string | null = null;
/** This device's id on the entries it queues: only it holds their drafts, so only it sends them. */
export function queueDeviceId(): string {
  if (deviceId !== null) return deviceId;
  const storage = browserStorage();
  deviceId = storage?.getItem(QUEUE_DEVICE_ID_KEY) ?? randomUUID();
  try {
    storage?.setItem(QUEUE_DEVICE_ID_KEY, deviceId);
  } catch {
    // A full or blocked storage only costs a new id on the next load.
  }
  return deviceId;
}

/** A positive "this client has no primary": the hosted app, or desktop with its local environment off. */
export function queueHasNoPrimary(): boolean {
  return typeof window !== "undefined" && (isHostedStaticApp() || isLocalEnvironmentDisabled());
}

/** What the store needs to know about the primary environment to pick its mode. */
export interface ThreadQueueConnection {
  readonly primaryId: EnvironmentId | null;
  /** See `queueHasNoPrimary`. */
  readonly noPrimary: boolean;
  readonly configSource: "live" | "cache" | null;
  readonly capability: boolean;
  readonly connected: boolean;
  /** The session may write the queue (`orchestration:operate`). */
  readonly canWrite: boolean;
}

export interface ThreadQueueWriter {
  /** Rejects when the change did not reach the server. */
  readonly write: (input: ThreadQueueSetInput) => Promise<ThreadQueueSetResult>;
  /**
   * A user's change was dropped, with what `write` rejected with. Of the coordinator's own
   * writes, only a claim that cannot be encoded is reported, with the entry it took out of the
   * queue (`unsaved`).
   */
  readonly reportFailure: (error: unknown, unsaved?: ThreadQueueEntry) => void;
}

interface PendingChange {
  readonly id: number;
  readonly action: QueueAction;
  readonly user: boolean;
}

interface ThreadQueueState extends ThreadQueueData {
  readonly mode: ThreadQueueMode;
  /** No user change is accepted: pending, or a server-mode session without operate scope. */
  readonly readOnly: boolean;
  readonly primaryId: EnvironmentId | null;
  /** The adopted server document: the base every write compares against. */
  readonly server: ThreadQueueDocument | null;
  /** A document arrived on the live subscription since the primary last connected. */
  readonly live: boolean;
  /** This tab's changes the server has not confirmed, oldest first, shown over `server`. */
  readonly pending: ReadonlyArray<PendingChange>;
  /** Changes made while pending (`HELD_KINDS`), applied when the queue becomes writable. */
  readonly held: ReadonlyArray<QueueAction>;
  /** `serverTime - Date.now()` from the latest server message. */
  readonly offsetMs: number;
  /** v1 entries left on this device when it first ran in server mode, until someone says so. */
  readonly localEntriesLeftBehind: number;
  readonly enqueue: (
    entry: Pick<ThreadQueueEntry, "environmentId" | "threadId" | "draftId"> & {
      readonly label?: string | null | undefined;
    },
    index?: number,
  ) => void;
  readonly remove: (threadKey: string) => void;
  readonly setPaused: (paused: boolean) => void;
  /** Moves the named entry into `inFlight`; null when it is gone, a claim is held, or the queue is read-only. */
  readonly claimEntry: (input: {
    key: string;
    claimId: string;
    now: number;
    resolve: (entry: ThreadQueueEntry) => { entry: ThreadQueueEntry; prior: ThreadQueuePrior };
  }) => ThreadQueueInFlight | null;
  /** Resolves once the claim is settled: true only when the queue holds it as this tab's. */
  readonly confirmClaim: (claimId: string) => Promise<boolean>;
  /**
   * Marks the send as started. Resolves true when it may go out: at once on this device's queue;
   * on the server's only once the server holds this claim as sending, not sent and not taken over.
   */
  readonly markSending: (claimId: string, now: number) => Promise<boolean>;
  readonly markSent: (claimId: string, now: number) => void;
  /** `ifUnsent`: an abandon, which leaves a claim that has since been marked sent. */
  readonly clearInFlight: (claimId: string, ifUnsent?: true) => void;
  readonly fail: (claimId: string, failure: ThreadQueueFailure) => void;
  /** The coordinator's removal of entries whose thread is gone or archived. */
  readonly prune: (threadKeys: ReadonlyArray<string>) => void;
  readonly removeSent: (threadKey: string, draftId: DraftId | null) => void;
  /** A failed hand send frees the claim its removal took over. */
  readonly releaseHandSent: (claimId: string) => void;
  /** The server's clock as this tab estimates it; claim and landing ages are measured on it. */
  readonly serverNow: () => number;
  readonly setConnection: (connection: ThreadQueueConnection) => void;
  /** A document from the live subscription. */
  readonly receiveDocument: (document: WireThreadQueueDocument, serverTime: number) => void;
  readonly setWriter: (writer: ThreadQueueWriter | null) => void;
}

let connection: ThreadQueueConnection = {
  primaryId: null,
  noPrimary: queueHasNoPrimary(),
  configSource: null,
  capability: false,
  connected: false,
  canWrite: false,
};
let writer: ThreadQueueWriter | null = null;
let chainRunning = false;
/** `kind:claimId` of claim and sending-mark writes whose request failed; the server may hold them. */
const lostReplies = new Set<string>();
let nextChangeId = 0;
/** v1 is written only in local mode, and only after v1 has been read back in. */
let localHydrated = false;

const dataOf = (state: ThreadQueueData): ThreadQueueData => ({
  entries: state.entries,
  paused: state.paused,
  inFlight: state.inFlight,
  lastFailure: state.lastFailure,
});

function displayed(state: Pick<ThreadQueueState, "server" | "pending" | "held">): ThreadQueueData {
  const base = state.server === null ? EMPTY_QUEUE_DATA : dataOf(state.server);
  return [...state.pending.map((change) => change.action), ...state.held].reduce(
    applyQueueAction,
    base,
  );
}

/** The changes whose caller waits to learn whether the server holds them. */
type Settled = "claim" | "mark-sending";
/** True while this tab still has an unwritten change of this kind for this claim. */
const writing = (kind: Settled, claimId: string) => (state: ThreadQueueState) =>
  state.pending.some((change) => change.action.kind === kind && change.action.claimId === claimId);

/** A hand-sent removal is idempotent, so holding it twice only grows the list. */
function alreadyHeld(held: ReadonlyArray<QueueAction>, action: QueueAction): boolean {
  return (
    action.kind === "remove-sent" &&
    held.some(
      (other) =>
        other.kind === "remove-sent" &&
        other.threadKey === action.threadKey &&
        other.draftId === action.draftId,
    )
  );
}

const sameEntry = (a: ThreadQueueEntry, b: ThreadQueueEntry) =>
  a === b ||
  (a.environmentId === b.environmentId &&
    a.threadId === b.threadId &&
    a.draftId === b.draftId &&
    a.addedAt === b.addedAt &&
    a.ownerId === b.ownerId &&
    a.label === b.label);
const sameEntries = (a: ReadonlyArray<ThreadQueueEntry>, b: ReadonlyArray<ThreadQueueEntry>) =>
  a.length === b.length && a.every((entry, i) => sameEntry(entry, b[i]!));

const Mirror = Schema.Struct({
  environmentId: Schema.String,
  document: WireThreadQueueDocumentSchema,
});
const decodeMirror = Schema.decodeUnknownOption(Schema.fromJsonString(Mirror));

/** The last document seen from this primary, shown while pending. Never a write base. */
function readMirror(primaryId: EnvironmentId | null): ThreadQueueDocument | null {
  const raw = primaryId === null ? null : browserStorage()?.getItem(THREAD_QUEUE_MIRROR_KEY);
  const mirror = raw ? Option.getOrNull(decodeMirror(raw)) : null;
  return mirror?.environmentId === primaryId ? (mirror.document as ThreadQueueDocument) : null;
}

function writeMirror(primaryId: EnvironmentId | null, document: ThreadQueueDocument): void {
  if (primaryId === null) return;
  try {
    browserStorage()?.setItem(
      THREAD_QUEUE_MIRROR_KEY,
      JSON.stringify({ environmentId: primaryId, document }),
    );
  } catch {
    // A full or blocked storage only costs the next first paint.
  }
}

const v1Storage: StateStorage = {
  getItem: (name) => resolveStorage(browserStorage()).getItem(name),
  setItem: (name, value) => {
    if (!localHydrated || useThreadQueueStore.getState().mode !== "local") return;
    return resolveStorage(browserStorage()).setItem(name, value);
  },
  removeItem: (name) => resolveStorage(browserStorage()).removeItem(name),
};

/** Stands in for the seen-server key for this page load when storage refuses it. */
let seenServerUnsaved: string | null = null;

function readSeenServer(): string | null {
  try {
    return browserStorage()?.getItem(SEEN_SERVER_KEY) ?? seenServerUnsaved;
  } catch {
    return seenServerUnsaved;
  }
}

function writeSeenServer(value: "ran" | "loaded"): void {
  const storage = browserStorage();
  try {
    if (storage) return storage.setItem(SEEN_SERVER_KEY, value);
  } catch {
    // Fall through: a full or blocked storage still says it once per page load, not per reconnect.
  }
  seenServerUnsaved = value;
}

/** How many entries v1 holds, read without touching it. */
function countLocalEntries(): number {
  try {
    const raw = browserStorage()?.getItem(THREAD_QUEUE_STORAGE_KEY);
    const entries = raw
      ? (JSON.parse(raw) as { state?: { entries?: unknown } }).state?.entries
      : [];
    return Array.isArray(entries) ? entries.length : 0;
  } catch {
    return 0;
  }
}

/** Set by a hydration that paused v1 after server mode; the pause is written back once loaded. */
let pauseOnLoad = false;

type StoredEntry = Omit<ThreadQueueEntry, "ownerId" | "label"> &
  Partial<Pick<ThreadQueueEntry, "ownerId" | "label">>;

/** v1 entries from before ownership were queued on this device. */
function ownLocalQueue(persisted: unknown): Partial<ThreadQueueData> {
  const stored = (persisted ?? {}) as Partial<
    Omit<ThreadQueueData, "entries" | "inFlight"> & {
      entries: ReadonlyArray<StoredEntry>;
      inFlight: (Omit<ThreadQueueInFlight, "entry"> & { entry: StoredEntry }) | null;
    }
  >;
  const own = (entry: StoredEntry): ThreadQueueEntry => ({
    ...entry,
    ownerId: entry.ownerId ?? queueDeviceId(),
    label: entry.label ?? null,
  });
  return {
    ...(stored.paused !== undefined && { paused: stored.paused }),
    ...(stored.lastFailure !== undefined && { lastFailure: stored.lastFailure }),
    ...(stored.entries && { entries: stored.entries.map(own) }),
    ...(stored.inFlight !== undefined && {
      inFlight:
        stored.inFlight === null ? null : { ...stored.inFlight, entry: own(stored.inFlight.entry) },
    }),
  };
}

export const useThreadQueueStore = create<ThreadQueueState>()(
  persist(
    (set, get) => {
      /**
       * Sets non-display fields; outside local mode the displayed fields follow. An unchanged
       * entry list keeps its identity, so a write's reply does not re-render the sidebar.
       */
      const setServerSide = (patch: Partial<ThreadQueueState>) =>
        set((state) => {
          const next = { ...state, ...patch };
          if (next.mode === "local") return patch;
          const shown = displayed(next);
          return {
            ...patch,
            ...shown,
            entries: sameEntries(state.entries, shown.entries) ? state.entries : shown.entries,
          };
        });

      /** Resolves once `done` holds, or after `timeoutMs` when given. */
      const waitFor = (done: (state: ThreadQueueState) => boolean, timeoutMs?: number) =>
        new Promise<void>((resolve) => {
          if (done(get())) return resolve();
          const stop = () => {
            unsubscribe();
            clearTimeout(timer);
            resolve();
          };
          const unsubscribe = useThreadQueueStore.subscribe((state) => {
            if (done(state)) stop();
          });
          const timer = timeoutMs === undefined ? undefined : setTimeout(stop, timeoutMs);
        });

      /** Adopts a newer document: another boot always, the same boot only at a higher revision. */
      const adopt = (wire: WireThreadQueueDocument, serverTime: number, live: boolean) => {
        const document = wire as ThreadQueueDocument;
        const state = get();
        const newer =
          state.server === null ||
          document.bootId !== state.server.bootId ||
          document.revision > state.server.revision;
        setServerSide({
          server: newer ? document : state.server,
          offsetMs: serverTime - Date.now(),
          ...(live && { live: true }),
        });
        if (newer) writeMirror(state.primaryId, document);
      };

      const finish = (id: number) =>
        setServerSide({ pending: get().pending.filter((change) => change.id !== id) });

      /**
       * Writes this tab's changes one at a time. Each is re-run on the newest document until it
       * lands or has nothing left to do; a conflict means another writer made progress. Only a
       * failed request drops a change.
       */
      const runChain = async (): Promise<void> => {
        if (chainRunning) return;
        chainRunning = true;
        try {
          for (;;) {
            const state = get();
            const head = state.pending[0];
            const active = writer;
            if (
              head === undefined ||
              state.mode !== "server" ||
              state.server === null ||
              active === null
            ) {
              return;
            }
            const { bootId, revision } = state.server;
            const base = dataOf(state.server);
            const next = applyQueueAction(base, head.action);
            if (sameQueueData(next, base)) {
              finish(head.id);
              continue;
            }
            let reply: ThreadQueueSetResult;
            try {
              reply = await active.write({ bootId, expectedRevision: revision, state: next });
            } catch (error) {
              // The RPC client encodes before sending: a claim it cannot encode never reaches the
              // server, and the next attempt would be the same, blocking the queue's head. Its
              // entry leaves instead, said once.
              if (head.action.kind === "claim" && Schema.isSchemaError(error) && next.inFlight) {
                const unsaved = next.inFlight.entry;
                const removal: QueueAction = { kind: "remove", keys: [head.action.key] };
                setServerSide({
                  pending: get().pending.map((change) =>
                    change.id === head.id ? { ...change, action: removal } : change,
                  ),
                });
                active.reportFailure(error, unsaved);
                continue;
              }
              const { kind } = head.action;
              if ((kind === "claim" || kind === "mark-sending") && get().mode === "server") {
                lostReplies.add(`${kind}:${head.action.claimId}`);
              }
              finish(head.id);
              if (head.user) active.reportFailure(error);
              continue;
            }
            adopt(reply.document, reply.serverTime, false);
            // A refusal from a newer document than this write's base re-runs on the newest one
            // (it may have arrived on the subscription first); any other cannot converge.
            const moved = reply.document.bootId !== bootId || reply.document.revision > revision;
            if (reply.ok || !moved) finish(head.id);
          }
        } finally {
          chainRunning = false;
        }
      };

      /**
       * Waits for this tab's `kind` write for `claimId` to leave the chain; true when the server
       * then `holds` it. A lost reply is settled by the compare-and-set itself: the adopted
       * document is re-sent unchanged (outside the chain, which skips a no-op), and the reply,
       * accepted or refused, carries the current document. Re-sent with backoff while the request
       * fails; any adopted document that `holds` settles it, and leaving server mode or becoming
       * read-only gives up.
       */
      const settle = async (
        kind: Settled,
        claimId: string,
        holds: (claim: ThreadQueueInFlight | null | undefined) => boolean,
      ): Promise<boolean> => {
        const queued = writing(kind, claimId);
        await waitFor((state) => state.mode !== "server" || !queued(state));
        const lost = lostReplies.delete(`${kind}:${claimId}`);
        for (let delayMs = LOST_REPLY_RETRY_MS; ;) {
          const state = get();
          const active = writer;
          if (state.mode !== "server") return false;
          if (holds(state.server?.inFlight)) return true;
          if (!lost || state.readOnly || state.server === null || active === null) return false;
          try {
            const reply = await active.write({
              bootId: state.server.bootId,
              expectedRevision: state.server.revision,
              state: dataOf(state.server),
            });
            adopt(reply.document, reply.serverTime, false);
            return get().mode === "server" && holds(get().server?.inFlight);
          } catch {
            await waitFor(
              (next) => next.mode !== "server" || next.readOnly || holds(next.server?.inFlight),
              delayMs,
            );
            delayMs = Math.min(delayMs * 2, LOST_REPLY_RETRY_MAX_MS);
          }
        }
      };

      const applyMode = () => {
        const state = get();
        const mode = resolveThreadQueueMode({ ...connection, liveDocument: state.live });
        const readOnly = mode === "pending" || (mode === "server" && !connection.canWrite);
        if (mode === state.mode && readOnly === state.readOnly) return;
        // Leaving server mode resolves every claim and sending-mark waiter as false; a write of
        // either after a reconnect would hold a claim nobody runs.
        const pending =
          state.mode === "server" && mode !== "server"
            ? state.pending.filter(
                (change) => change.action.kind !== "claim" && change.action.kind !== "mark-sending",
              )
            : state.pending;
        if (mode === "server" && state.mode !== "server") {
          const firstServerRun = readSeenServer() === null;
          writeSeenServer("ran");
          if (firstServerRun) setServerSide({ localEntriesLeftBehind: countLocalEntries() });
        }
        localHydrated = false;
        if (mode === "local") {
          set({ mode, readOnly, pending, ...EMPTY_QUEUE_DATA });
          void useThreadQueueStore.persist.rehydrate();
          return;
        }
        const opening = mode === "server" && !readOnly && state.held.length > 0;
        setServerSide({
          mode,
          readOnly,
          pending: opening
            ? [
                ...pending,
                ...state.held.map((action) => ({ id: ++nextChangeId, action, user: false })),
              ]
            : pending,
          ...(opening && { held: [] }),
        });
        if (mode === "server") void runChain();
      };

      const dispatch = (action: QueueAction, origin: "user" | "system") => {
        const state = get();
        if (state.mode === "local") {
          set(applyQueueAction(dataOf(state), action));
          return;
        }
        if (state.mode === "pending") {
          // Nothing is written while pending; what already happened waits.
          if (HELD_KINDS.has(action.kind) && !alreadyHeld(state.held, action)) {
            setServerSide({ held: [...state.held, action] });
          }
          return;
        }
        if (origin === "user" && state.readOnly) return;
        setServerSide({
          pending: [...state.pending, { id: ++nextChangeId, action, user: origin === "user" }],
        });
        void runChain();
      };

      return {
        ...EMPTY_QUEUE_DATA,
        mode: connection.noPrimary ? "local" : "pending",
        readOnly: !connection.noPrimary,
        primaryId: null,
        server: null,
        live: false,
        pending: [],
        held: [],
        offsetMs: 0,
        localEntriesLeftBehind: 0,
        enqueue: (entry, index) =>
          dispatch(
            {
              kind: "enqueue",
              index,
              entry: {
                environmentId: entry.environmentId,
                threadId: entry.threadId,
                draftId: entry.draftId,
                addedAt: get().serverNow(),
                ownerId: queueDeviceId(),
                label: queueEntryLabel(entry.label),
              },
            },
            "user",
          ),
        remove: (threadKey) => dispatch({ kind: "remove", keys: [threadKey] }, "user"),
        setPaused: (paused) =>
          dispatch(
            paused
              ? { kind: "set-paused", paused }
              : { kind: "set-paused", paused, seenFailure: get().lastFailure },
            "user",
          ),
        claimEntry: ({ key, claimId, now, resolve }) => {
          const state = get();
          if (state.readOnly) return null;
          const action: QueueAction = { kind: "claim", key, claimId, now, resolve };
          const next = applyQueueAction(dataOf(state), action);
          if (next.inFlight?.claimId !== claimId) return null;
          // Locally the claim is written as computed, so `resolve` runs once.
          if (state.mode === "local") set(next);
          else dispatch(action, "system");
          return next.inFlight;
        },
        confirmClaim: async (claimId) => {
          if (get().mode === "local") {
            await new Promise((resolve) => setTimeout(resolve, LOCAL_CLAIM_SETTLE_MS));
            await useThreadQueueStore.persist.rehydrate();
            return get().inFlight?.claimId === claimId;
          }
          return settle("claim", claimId, (claim) => claim?.claimId === claimId);
        },
        markSending: async (claimId, now) => {
          dispatch({ kind: "mark-sending", claimId, now }, "system");
          if (get().mode === "local") return true;
          return settle(
            "mark-sending",
            claimId,
            (claim) =>
              claim?.claimId === claimId &&
              claim.sendingAt !== undefined &&
              claim.sentAt === null &&
              claim.handSent === undefined,
          );
        },
        markSent: (claimId, now) => dispatch({ kind: "mark-sent", claimId, now }, "system"),
        clearInFlight: (claimId, ifUnsent) =>
          dispatch({ kind: "clear-in-flight", claimId, ...(ifUnsent && { ifUnsent }) }, "system"),
        fail: (claimId, failure) =>
          dispatch(
            {
              kind: "fail",
              claimId,
              failure: {
                ...failure,
                title: failure.title.slice(0, THREAD_QUEUE_FAILURE_TITLE_MAX_LENGTH),
                message: failure.message.slice(0, THREAD_QUEUE_FAILURE_MESSAGE_MAX_LENGTH),
              },
            },
            "system",
          ),
        prune: (threadKeys) => {
          if (threadKeys.length > 0) dispatch({ kind: "remove", keys: threadKeys }, "system");
        },
        removeSent: (threadKey, draftId) =>
          dispatch({ kind: "remove-sent", threadKey, draftId, now: get().serverNow() }, "system"),
        releaseHandSent: (claimId) => dispatch({ kind: "release-hand-sent", claimId }, "system"),
        serverNow: () => Date.now() + (get().mode === "local" ? 0 : get().offsetMs),
        setConnection: (next) => {
          const state = get();
          const primaryChanged = next.primaryId !== state.primaryId;
          connection = next;
          setServerSide({
            primaryId: next.primaryId,
            // A different primary holds a different queue: nothing from the old one carries over.
            ...(primaryChanged && {
              server: readMirror(next.primaryId),
              pending: [],
              held: [],
              live: false,
              offsetMs: 0,
            }),
            ...(!next.connected && { live: false }),
          });
          applyMode();
        },
        receiveDocument: (document, serverTime) => {
          adopt(document, serverTime, true);
          applyMode();
        },
        setWriter: (next) => {
          writer = next;
          if (next !== null) void runChain();
        },
      };
    },
    {
      name: THREAD_QUEUE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => v1Storage),
      skipHydration: true,
      partialize: (state) => dataOf(state),
      // v1 is local mode's alone; a hydration finishing after the mode changed is ignored.
      merge: (persisted, current) => {
        if (current.mode !== "local") return current;
        const local = { ...current, ...ownLocalQueue(persisted) };
        if (readSeenServer() !== "ran") return local;
        writeSeenServer("loaded");
        if (local.entries.length === 0 && local.inFlight === null) return local;
        pauseOnLoad = true;
        return { ...local, paused: true };
      },
    },
  ),
);

useThreadQueueStore.persist.onFinishHydration(() => {
  const state = useThreadQueueStore.getState();
  if (state.mode !== "local") return;
  localHydrated = true;
  if (pauseOnLoad) {
    pauseOnLoad = false;
    // Written back, so the next load and every other tab see the pause too.
    useThreadQueueStore.setState({ paused: true });
  }
  // Changes held while pending still apply when the queue turned out to be local, except a
  // failure: it reported the server queue's send and would pause this one.
  if (state.held.length > 0) {
    useThreadQueueStore.setState({
      held: [],
      ...state.held
        .filter((action) => action.kind !== "fail")
        .reduce(applyQueueAction, dataOf(state)),
    });
  }
});
if (useThreadQueueStore.getState().mode === "local") void useThreadQueueStore.persist.rehydrate();

/**
 * A thread the user sent by hand leaves the queue (a draft may have moved machine since it joined).
 * A claim on it whose send has not started is taken over: marked sent by hand, so no tab sends it
 * again and every tab holds the slot until that message lands. Call the returned function when
 * the hand send fails: it frees the slot that claim still holds. A removal held while pending
 * returns a no-op: that slot waits for the landing cap.
 */
export function removeSentThreadFromQueue(threadKey: string, draftId: DraftId | null): () => void {
  const queue = useThreadQueueStore.getState();
  const before = queue.inFlight;
  queue.removeSent(threadKey, draftId);
  const after = useThreadQueueStore.getState().inFlight;
  const takenClaimId =
    queue.mode !== "pending" &&
    before !== null &&
    before.handSent !== true &&
    after?.claimId === before.claimId &&
    after.handSent === true
      ? before.claimId
      : null;
  return () => {
    if (takenClaimId !== null) useThreadQueueStore.getState().releaseHandSent(takenClaimId);
  };
}

/**
 * Keeps every tab's copy of a local queue and its slot settings current, so no tab writes a stale
 * queue back over another's claim. A null key means storage was cleared.
 */
export function subscribeToCrossTabThreadQueueUpdates(): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    const localQueue = useThreadQueueStore.getState().mode === "local";
    if (localQueue && (event.key === null || event.key === THREAD_QUEUE_STORAGE_KEY)) {
      void useThreadQueueStore.persist.rehydrate();
    }
    if (event.key === null || event.key === QUEUE_SLOT_SETTINGS_STORAGE_KEY) {
      void useQueueSlotSettingsStore.persist.rehydrate();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
