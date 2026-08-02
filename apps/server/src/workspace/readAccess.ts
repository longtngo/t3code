// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Absolute roots a file-preview read is allowed to touch:
 *  - the user's home directory (`$HOME` / `~`),
 *  - the OS temp dir (handoff docs and some temp reports land there),
 *  - any `extraRoots` the *server* trusts (the workspace roots of the projects
 *    it actually knows about — see the read RPC handlers).
 *
 * `extraRoots` must come from server-side state, never from the client-supplied
 * `cwd`: trusting the request's `cwd` as a root would let a caller pass `cwd: "/"`
 * and read anything. The client `cwd` is used only to *resolve* relative paths,
 * not to *authorize* them.
 *
 * The user has native terminal access, so this is a sandbox against arbitrary
 * host reads in remote/relay sessions — not an attempt to hide paths (the path
 * is now shown in the UI).
 */
export function allowedReadRoots(extraRoots: readonly string[] = []): string[] {
  const roots = [NodePath.resolve(NodeOS.homedir()), NodePath.resolve(NodeOS.tmpdir())];
  for (const root of extraRoots) {
    if (root && NodePath.isAbsolute(root)) roots.push(NodePath.resolve(root));
  }
  return roots;
}

/**
 * True when `absolutePath` is one of `roots` or a descendant of one. Both sides
 * are lexically resolved first, so `..` segments can't escape. Pass a
 * realpath-resolved `absolutePath` (and realpath-resolved roots) when symlink
 * escapes are a concern.
 */
export function isWithinAllowedRoots(absolutePath: string, roots: readonly string[]): boolean {
  const target = NodePath.resolve(absolutePath);
  return roots.some((root) => {
    const normalizedRoot = NodePath.resolve(root);
    if (target === normalizedRoot) return true;
    const prefix = normalizedRoot.endsWith(NodePath.sep)
      ? normalizedRoot
      : normalizedRoot + NodePath.sep;
    return target.startsWith(prefix);
  });
}
