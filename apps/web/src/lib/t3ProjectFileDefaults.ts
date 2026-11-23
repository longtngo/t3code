import {
  AuthFilesystemReadScope,
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ProjectReadFileResult,
  type T3ProjectFile,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readEnvironmentScopeDenied } from "~/state/session";

function toT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  result: ProjectReadFileResult | null,
): T3ProjectFile | null {
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    T3_PROJECT_FILE_NAME,
    result,
  );
  if (data === null || data.exists === false || data.truncated) return null;
  return parseT3ProjectFile(data.contents);
}

// FORK: a loaded grant without `filesystem:read` resolves to null and is never asked.
// A grant still loading is asked anyway; the server decides.
export async function readT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<T3ProjectFile | null> {
  // FORK: a loaded grant without file reads is not asked; the refused read would say nothing.
  if (readEnvironmentScopeDenied(environmentId, AuthFilesystemReadScope)) return null;
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  return toT3ProjectFile(
    environmentId,
    workspaceRoot,
    result._tag === "Success" ? result.value : null,
  );
}

/** The project's t3.json from an earlier read, or `undefined` when none has loaded yet. */
export function peekT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): T3ProjectFile | null | undefined {
  // FORK: same rule as `readT3ProjectFile`; reading the query atom would start the refused read.
  if (readEnvironmentScopeDenied(environmentId, AuthFilesystemReadScope)) return null;
  const result = appAtomRegistry.get(
    getProjectFileQueryAtom(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME),
  );
  return AsyncResult.isSuccess(result)
    ? toT3ProjectFile(environmentId, workspaceRoot, result.value)
    : undefined;
}
