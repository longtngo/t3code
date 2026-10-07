import {
  type AuthEnvironmentScope,
  type AuthSessionState,
  sessionGrantsScope,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClientError } from "effect/http";
import { AsyncResult } from "effect/reactivity";

import { ConnectionTransientError } from "../connection/model.ts";
import { RemoteEnvironmentAuthFetchError, RemoteEnvironmentAuthTimeoutError } from "../rpc/http.ts";

const isConnectionTransientError = Schema.is(ConnectionTransientError);

/**
 * FORK: a session refresh that never reached the server says nothing about the grant, so
 * the cached scopes stand; any other failure (an answer, a rejection, a bad body) revokes
 * them. Without this, going offline greys out Send and the offline outbox never queues.
 */
const isUnreachableSessionFailure = (error: unknown): boolean =>
  error instanceof RemoteEnvironmentAuthTimeoutError ||
  (error instanceof RemoteEnvironmentAuthFetchError &&
    ((HttpClientError.isHttpClientError(error.cause) && error.cause.response === undefined) ||
      // A relay token renewal that could not reach the relay.
      isConnectionTransientError(error.cause)));

/** Whether a session-state result grants `scope`, keeping cached scopes while unreachable. */
export function sessionResultGrantsScope(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
  scope: AuthEnvironmentScope,
): boolean {
  const session = Option.getOrNull(AsyncResult.value(result));
  if (session === null) return false;
  if (result._tag === "Failure") {
    const error = Cause.findErrorOption(result.cause);
    if (Option.isNone(error) || !isUnreachableSessionFailure(error.value)) return false;
  }
  return sessionGrantsScope(session, scope);
}
