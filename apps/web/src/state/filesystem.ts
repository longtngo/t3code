import {
  createFilesystemEnvironmentAtoms,
  resolveFilesystemReadAccess,
} from "@t3tools/client-runtime/state/filesystem";
import { AuthFilesystemReadScope, type EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentPresentation } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { environmentSession, useEnvironmentScope } from "./session";

export const filesystemEnvironment = createFilesystemEnvironmentAtoms(connectionAtomRuntime);

export function useFilesystemReadAccess(environmentId: EnvironmentId | null) {
  const session = useEnvironmentQuery(
    environmentId === null ? null : environmentSession.sessionStateAtom(environmentId),
  );
  const environment = useEnvironmentPresentation(environmentId);
  // FORK: cached scopes stand while a refresh could not reach the server, so offline keeps files.
  const grantsFileRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  if (grantsFileRead) return { canReadFiles: true, isPending: false, error: null };
  return resolveFilesystemReadAccess({
    isCatalogReady: environment.isReady,
    connection: environment.presentation?.connection ?? null,
    session: session.data,
    sessionError: session.error,
  });
}
