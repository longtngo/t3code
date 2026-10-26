// @effect-diagnostics nodeBuiltinImport:off - these install before any Effect runtime exists.
import * as NodeNet from "node:net";

/**
 * Process-level guards for failures that arrive before any Effect error channel exists.
 * Prompted by `setTypeOfService EINVAL` killing the server five times with no record.
 */

const ALREADY_GUARDED = Symbol.for("t3code.setTypeOfServiceGuarded");

type TypeOfServiceSetter = (this: unknown, tos: number) => unknown;

const isTypeOfServiceError = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" &&
  error !== null &&
  (error as NodeJS.ErrnoException).syscall === "setTypeOfService";

/**
 * Makes only `net.Socket#setTypeOfService` non-fatal: on macOS it throws EINVAL on an aborted
 * socket, and the bundled undici calls it uncatchably on plain-HTTP writes. Fixed upstream in
 * undici 8.8.0 (Node v26.5.1): **delete once the minimum Node is >= 26.5.1.** Other syscalls
 * rethrow; the request still fails as `ECONNRESET`, only the process death is removed.
 */
export function guardSocketTypeOfServiceErrors(
  socketPrototype: Record<PropertyKey, unknown> = NodeNet.Socket.prototype as unknown as Record<
    PropertyKey,
    unknown
  >,
  onSuppressed?: (error: NodeJS.ErrnoException) => void,
): boolean {
  const original = socketPrototype["setTypeOfService"];
  if (typeof original !== "function") return false;
  if (socketPrototype[ALREADY_GUARDED] === true) return false;

  const guarded: TypeOfServiceSetter = function (this: unknown, tos: number) {
    try {
      return (original as TypeOfServiceSetter).call(this, tos);
    } catch (error) {
      if (!isTypeOfServiceError(error)) throw error;
      onSuppressed?.(error);
      return this;
    }
  };

  socketPrototype["setTypeOfService"] = guarded;
  socketPrototype[ALREADY_GUARDED] = true;
  return true;
}

/**
 * Records a fatal exception on the way out. **Does not stop the exit**: the server is
 * event-sourced, so resuming after an unknown fatal risks silent state corruption. The write
 * is synchronous because a buffered write may never flush.
 */
export function monitorFatalExceptions(
  target: Pick<NodeJS.Process, "on"> = process,
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): void {
  target.on("uncaughtExceptionMonitor", (error: unknown, origin: unknown) => {
    const detail =
      error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
    write(`[fatal] uncaughtExceptionMonitor origin=${String(origin)} ${detail}\n`);
  });
}

/** Installs both guards. Call once, as early in startup as possible. */
export function installProcessGuards(): void {
  guardSocketTypeOfServiceErrors(
    NodeNet.Socket.prototype as unknown as Record<PropertyKey, unknown>,
    (error) => {
      // Not fatal, and not rare enough to log per occurrence at info level - but
      // silence here is what made the original outages undiagnosable.
      process.emitWarning(
        `suppressed non-fatal ${error.syscall} ${error.code} on a reset socket`,
        "T3SocketTypeOfServiceGuard",
      );
    },
  );
  monitorFatalExceptions();
}
