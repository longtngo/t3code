import {
  AuthFilesystemReadScope,
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type T3ProjectFile,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readEnvironmentScopeDenied } from "~/state/session";

// FORK: a loaded grant without `filesystem:read` resolves to null and is never asked.
// A grant still loading is asked anyway; the server decides.
export async function readT3ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<T3ProjectFile | null> {
  // FORK: a loaded grant without file reads is not asked; the refused read would say nothing.
  const result = !readEnvironmentScopeDenied(environmentId, AuthFilesystemReadScope)
    ? await executeAtomQuery(
        appAtomRegistry,
        getProjectFileQueryAtom(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME),
        { reportDefect: false, reportFailure: false },
      )
    : null;
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    T3_PROJECT_FILE_NAME,
    result?._tag === "Success" ? result.value : null,
  );
  if (data === null || data.truncated) return null;
  return parseT3ProjectFile(data.contents);
}
