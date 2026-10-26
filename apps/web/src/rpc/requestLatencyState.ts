import { useAtomValue } from "@effect/atom-react";
import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atomRegistry";

export const SLOW_RPC_ACK_THRESHOLD_MS = 15_000;
/**
 * Updates wait for package installs; VCS refreshes may wait for background work and network calls.
 * Give these requests longer than the normal 15s warning threshold.
 */
export const LONG_RUNNING_RPC_ACK_THRESHOLD_MS = 120_000;
const MAX_TRACKED_RPC_ACK_REQUESTS = 256;
let slowRpcAckThresholdMs = SLOW_RPC_ACK_THRESHOLD_MS;

export interface SlowRpcAckRequest {
  readonly requestId: string;
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly tag: string;
  readonly thresholdMs: number;
}

interface PendingRpcAckRequest {
  readonly request: SlowRpcAckRequest;
  readonly timeoutId: ReturnType<typeof setTimeout>;
}

const pendingRpcAckRequests = new Map<string, PendingRpcAckRequest>();
const untrackedRpcAckMethods = new Set<string>();
// Usage summary shells out to every provider CLI, and the client-activity heartbeat is the
// first thing a busy host delays, so both join the long leash (fork precedent: pull requests)
// rather than the untracked set upstream chose: a call wedged for 120s is still worth reporting.
const longRunningRpcAckMethods = new Set<string>([
  WS_METHODS.serverUpdateProvider,
  WS_METHODS.serverRefreshProviders,
  WS_METHODS.serverUpdateServer,
  WS_METHODS.serverGetUsageSummary,
  WS_METHODS.serverReportClientActivity,
  WS_METHODS.vcsRefreshStatus,
]);
/**
 * Pull request calls fan out across every server and shell out to the provider CLI, so 15s is
 * normal. Kept tracked (not in {@link untrackedRpcAckMethods}) because "slow by design" is not
 * "unobservable": a genuinely wedged fetch is the one case a user wants to hear about.
 */
const longRunningRpcAckPrefixes = ["pullRequests."];

function isLongRunningRpcAck(method: string): boolean {
  return (
    longRunningRpcAckMethods.has(method) ||
    longRunningRpcAckPrefixes.some((prefix) => method.startsWith(prefix))
  );
}

const slowRpcAckRequestsAtom = Atom.make<ReadonlyArray<SlowRpcAckRequest>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("slow-rpc-ack-requests"),
);

function setSlowRpcAckRequests(requests: ReadonlyArray<SlowRpcAckRequest>) {
  appAtomRegistry.set(slowRpcAckRequestsAtom, [...requests]);
}

function getSlowRpcAckRequestsValue(): ReadonlyArray<SlowRpcAckRequest> {
  return appAtomRegistry.get(slowRpcAckRequestsAtom);
}

function shouldTrackRpcAck(method: string): boolean {
  return !method.includes("subscribe") && !untrackedRpcAckMethods.has(method);
}

function rpcAckThresholdMs(method: string): number {
  return isLongRunningRpcAck(method)
    ? Math.max(slowRpcAckThresholdMs, LONG_RUNNING_RPC_ACK_THRESHOLD_MS)
    : slowRpcAckThresholdMs;
}

export function getSlowRpcAckRequests(): ReadonlyArray<SlowRpcAckRequest> {
  return getSlowRpcAckRequestsValue();
}

export function trackRpcRequestSent(requestId: string, method: string, tag = method): void {
  if (!shouldTrackRpcAck(method)) {
    return;
  }

  clearTrackedRpcRequest(requestId);
  evictOldestPendingRpcRequestIfNeeded();

  const startedAtMs = Date.now();
  const thresholdMs = rpcAckThresholdMs(method);
  const request: SlowRpcAckRequest = {
    requestId,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    tag,
    thresholdMs,
  };
  const timeoutId = setTimeout(() => {
    pendingRpcAckRequests.delete(requestId);
    appendSlowRpcAckRequest(request);
  }, thresholdMs);

  pendingRpcAckRequests.set(requestId, {
    request,
    timeoutId,
  });
}

export function acknowledgeRpcRequest(requestId: string): void {
  clearTrackedRpcRequest(requestId);
  const slowRequests = getSlowRpcAckRequestsValue();
  if (!slowRequests.some((request) => request.requestId === requestId)) {
    return;
  }

  setSlowRpcAckRequests(slowRequests.filter((request) => request.requestId !== requestId));
}

function clearTrackedRpcRequest(requestId: string): void {
  const pending = pendingRpcAckRequests.get(requestId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timeoutId);
  pendingRpcAckRequests.delete(requestId);
}

function appendSlowRpcAckRequest(request: SlowRpcAckRequest): void {
  const requests = [...getSlowRpcAckRequestsValue(), request];
  if (requests.length <= MAX_TRACKED_RPC_ACK_REQUESTS) {
    setSlowRpcAckRequests(requests);
    return;
  }

  setSlowRpcAckRequests(requests.slice(-MAX_TRACKED_RPC_ACK_REQUESTS));
}

function evictOldestPendingRpcRequestIfNeeded(): void {
  while (pendingRpcAckRequests.size >= MAX_TRACKED_RPC_ACK_REQUESTS) {
    const oldestRequestId = pendingRpcAckRequests.keys().next().value;
    if (oldestRequestId === undefined) {
      return;
    }

    clearTrackedRpcRequest(oldestRequestId);
  }
}

// FORK: the long-leash rule (registry invariant 23) keeps its own test, which needs these.
export function resetRequestLatencyStateForTests(): void {
  slowRpcAckThresholdMs = SLOW_RPC_ACK_THRESHOLD_MS;
  for (const pending of pendingRpcAckRequests.values()) {
    clearTimeout(pending.timeoutId);
  }
  pendingRpcAckRequests.clear();
  setSlowRpcAckRequests([]);
}

export function useSlowRpcAckRequests(): ReadonlyArray<SlowRpcAckRequest> {
  return useAtomValue(slowRpcAckRequestsAtom);
}
