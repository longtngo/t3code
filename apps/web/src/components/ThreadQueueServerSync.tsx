import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { readThreadShell } from "../state/entities";
import { usePrimaryEnvironment } from "../state/environments";
import { primaryThreadQueueSupportAtom, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import type { ThreadQueueEntry } from "../threadQueueRules";
import { queueHasNoPrimary, useThreadQueueStore } from "../threadQueueStore";
import { toastManager } from "./ui/toast";

/**
 * Connects the sidebar Queue store to the primary environment: which mode to run in, the live
 * document, and the compare-and-set writer. Mounted once at the app root.
 */
export function ThreadQueueServerSync() {
  const primary = usePrimaryEnvironment();
  const primaryId = primary?.environmentId ?? null;
  const connected = primary?.connection.phase === "connected";
  const { configSource, capability } = useAtomValue(primaryThreadQueueSupportAtom);
  const canWrite = useAtomValue(serverEnvironment.setThreadQueue.permissionAtom(primaryId));
  const noPrimary = queueHasNoPrimary();
  const localEntriesLeftBehind = useThreadQueueStore((state) => state.localEntriesLeftBehind);

  useEffect(() => {
    useThreadQueueStore
      .getState()
      .setConnection({ primaryId, noPrimary, configSource, capability, connected, canWrite });
  }, [canWrite, capability, configSource, connected, noPrimary, primaryId]);

  useEffect(() => {
    if (localEntriesLeftBehind === 0) return;
    const title =
      localEntriesLeftBehind === 1
        ? "1 item queued before the queue was shared was not moved into it. Add it again."
        : `${localEntriesLeftBehind} items queued before the queue was shared were not moved into it. Add them again.`;
    toastManager.add({ type: "info", title });
    useThreadQueueStore.setState({ localEntriesLeftBehind: 0 });
  }, [localEntriesLeftBehind]);

  // Only a live config that advertises the queue is ever subscribed to (old servers and cached
  // configs never see the RPC). Each connect mounts a fresh subscription, so its first document
  // always arrives after the connect is recorded: one that beat the disconnect would be cleared.
  return primaryId !== null && connected && configSource === "live" && capability ? (
    <ThreadQueueSubscription
      key={primaryId}
      environmentId={primaryId}
      serverLabel={primary?.label ?? "the server"}
    />
  ) : null;
}

function ThreadQueueSubscription(props: { environmentId: EnvironmentId; serverLabel: string }) {
  const { environmentId, serverLabel } = props;
  const snapshot = Option.getOrNull(
    AsyncResult.value(useAtomValue(serverEnvironment.threadQueue({ environmentId, input: {} }))),
  );
  useEffect(() => {
    // Each message is a new object, so a value kept across a reconnect is not delivered twice.
    if (snapshot !== null) {
      useThreadQueueStore.getState().receiveDocument(snapshot.document, snapshot.serverTime);
    }
  }, [snapshot]);

  const setThreadQueue = useAtomCommand(serverEnvironment.setThreadQueue, {
    reportFailure: false,
  });
  // Read at failure time: a rename must not retire the writes in flight.
  const serverLabelRef = useRef(serverLabel);
  useEffect(() => {
    serverLabelRef.current = serverLabel;
  }, [serverLabel]);
  useEffect(() => {
    // A socket loss fails the request on its own. Leaving this server (a primary change) does
    // not, so it rejects here: the queue must never adopt the old server's reply.
    let retire: (error: Error) => void = () => {};
    const retired = new Promise<never>((_, reject) => {
      retire = reject;
    });
    retired.catch(() => {});
    const store = useThreadQueueStore.getState();
    store.setWriter({
      write: async (input) => {
        try {
          const reply = await Promise.race([setThreadQueue({ environmentId, input }), retired]);
          if (reply._tag === "Failure") throw squashAtomCommandFailure(reply);
          return reply.value;
        } catch (error) {
          console.error("Queue change failed", error);
          throw error;
        }
      },
      reportFailure: (error, unsaved) =>
        toastManager.add({
          type: "error",
          // A payload the RPC client cannot encode fails here, before anything is sent. A reply
          // it cannot decode is a SchemaError too, so "rejected" can follow a change the server
          // saved; the subscription's next document corrects what this tab shows.
          title: unsaved
            ? `${queuedThreadTitle(unsaved)} can't be queued: it is too large to save.`
            : Schema.isSchemaError(error)
              ? "Queue change was rejected"
              : Predicate.isTagged(error, "ThreadQueueWriteError")
                ? `Queue change couldn't be saved on ${serverLabelRef.current}`
                : `Queue change didn't reach ${serverLabelRef.current}`,
        }),
    });
    return () => {
      retire(new Error("The queue's server changed."));
      store.setWriter(null);
    };
  }, [environmentId, setThreadQueue]);
  return null;
}

/** The thread's title on this device, else the label taken when it was queued. */
function queuedThreadTitle(entry: ThreadQueueEntry): string {
  return (
    readThreadShell(scopeThreadRef(entry.environmentId, entry.threadId))?.title ??
    entry.label ??
    "A queued thread"
  );
}
