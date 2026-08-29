// @effect-diagnostics nodeBuiltinImport:off - the guards are Node-level, so the test is too.
import * as NodeNet from "node:net";

import { describe, expect, it } from "vite-plus/test";

import { guardSocketTypeOfServiceErrors, monitorFatalExceptions } from "./processGuards.ts";

const typeOfServiceError = () =>
  Object.assign(new Error("setTypeOfService EINVAL"), {
    syscall: "setTypeOfService",
    code: "EINVAL",
    errno: -22,
  });

/** A stand-in for `net.Socket.prototype`, so no test touches the real one. */
const makePrototype = (setTypeOfService: unknown): Record<PropertyKey, unknown> => ({
  setTypeOfService,
});

describe("guardSocketTypeOfServiceErrors", () => {
  it("swallows the EINVAL that kills the process", () => {
    const prototype = makePrototype(() => {
      throw typeOfServiceError();
    });
    const suppressed: Array<NodeJS.ErrnoException> = [];

    expect(guardSocketTypeOfServiceErrors(prototype, (error) => suppressed.push(error))).toBe(true);

    const setter = prototype["setTypeOfService"] as (tos: number) => unknown;
    expect(() => setter.call(prototype, 0)).not.toThrow();
    expect(suppressed.map((error) => error.code)).toEqual(["EINVAL"]);
  });

  it("rethrows anything that is not this syscall", () => {
    // The guard exists for one failure. A different one must stay fatal, or it
    // becomes the blanket crash suppressor this deliberately is not.
    const other = Object.assign(new Error("read ECONNRESET"), {
      syscall: "read",
      code: "ECONNRESET",
    });
    const prototype = makePrototype(() => {
      throw other;
    });
    guardSocketTypeOfServiceErrors(prototype);

    const setter = prototype["setTypeOfService"] as (tos: number) => unknown;
    expect(() => setter.call(prototype, 0)).toThrow("read ECONNRESET");
  });

  it("passes through a call that succeeds, so TOS still works when it works", () => {
    const seen: number[] = [];
    const prototype = makePrototype(function (this: unknown, tos: number) {
      seen.push(tos);
      return this;
    });
    guardSocketTypeOfServiceErrors(prototype);

    const setter = prototype["setTypeOfService"] as (tos: number) => unknown;
    setter.call(prototype, 4);
    expect(seen).toEqual([4]);
  });

  it("installs once, so a second call cannot double-wrap", () => {
    let calls = 0;
    const prototype = makePrototype(() => {
      calls += 1;
      throw typeOfServiceError();
    });

    expect(guardSocketTypeOfServiceErrors(prototype)).toBe(true);
    expect(guardSocketTypeOfServiceErrors(prototype)).toBe(false);

    const setter = prototype["setTypeOfService"] as (tos: number) => unknown;
    setter.call(prototype, 0);
    expect(calls).toBe(1);
  });

  it("does nothing on a runtime without the method", () => {
    // Node < 25.6 has no `setTypeOfService`, and `TLSWrap` never gets one.
    expect(guardSocketTypeOfServiceErrors(makePrototype(undefined))).toBe(false);
  });

  it("is installed on the real socket prototype only by installProcessGuards", () => {
    // Importing this module must not patch anything: `bin.ts` installs inside its
    // entrypoint guard so tests and library consumers get an unmodified builtin.
    const prototype = NodeNet.Socket.prototype as unknown as Record<PropertyKey, unknown>;
    expect(prototype[Symbol.for("t3code.setTypeOfServiceGuarded")]).toBeUndefined();
  });
});

describe("monitorFatalExceptions", () => {
  it("records the fatal without suppressing the exit", () => {
    const listeners: Array<{ event: string; listener: (...args: never[]) => void }> = [];
    const lines: string[] = [];
    const target = {
      on(event: string, listener: (...args: never[]) => void) {
        listeners.push({ event, listener });
        return this;
      },
    } as unknown as Pick<NodeJS.Process, "on">;

    monitorFatalExceptions(target, (line) => lines.push(line));

    // `uncaughtExceptionMonitor` observes and lets Node exit; `uncaughtException`
    // would suppress the exit. Registering the wrong one is the whole risk here,
    // so assert the event name rather than trusting the call.
    expect(listeners.map((entry) => entry.event)).toEqual(["uncaughtExceptionMonitor"]);

    listeners[0]?.listener(...([new Error("boom"), "uncaughtException"] as never[]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[fatal] uncaughtExceptionMonitor");
    expect(lines[0]).toContain("origin=uncaughtException");
    expect(lines[0]).toContain("boom");
  });

  it("survives a thrown non-Error", () => {
    const lines: string[] = [];
    let captured: ((...args: never[]) => void) | undefined;
    const target = {
      on(_event: string, listener: (...args: never[]) => void) {
        captured = listener;
        return this;
      },
    } as unknown as Pick<NodeJS.Process, "on">;

    monitorFatalExceptions(target, (line) => lines.push(line));
    captured?.(...(["a string, not an Error", "uncaughtException"] as never[]));

    expect(lines[0]).toContain("a string, not an Error");
  });
});
