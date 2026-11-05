import type { HostMetricsDisk } from "@t3tools/contracts";

/**
 * Shared disk-usage reader for host metrics. A hung statfs pins a libuv pool thread and cannot
 * be cancelled, so at most {@link MAX_IN_FLIGHT} reads are in flight and a source in flight is
 * never read again until it settles.
 */

/** Never pins more than 2 of the 4 libuv pool threads. */
const MAX_IN_FLIGHT = 2;
/** Refreshes are at least this far apart (monotonic clock, from the last refresh start). */
const REFRESH_MS = 10_000;
/** A read in flight longer than this is reported stuck, once per episode. */
const STUCK_MS = 30_000;
/** Local block-device filesystems worth reporting. */
const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  "ext2",
  "ext3",
  "ext4",
  "xfs",
  "btrfs",
  "f2fs",
  "exfat",
  "ntfs3",
]);
const DARWIN_DATA = "/System/Volumes/Data";

export interface MountRow {
  readonly source: string;
  /** Mount point shown to the user: escapes decoded, control characters dropped. */
  readonly mount: string;
  readonly type: string;
  /** The real mount point, handed to statfs; identifies the mount. */
  readonly path: string;
}

export interface StatFsLike {
  readonly bsize: number;
  readonly blocks: number;
  readonly bfree: number;
  readonly bavail: number;
}

export interface HostDisksDeps {
  readonly statfs: (path: string) => Promise<StatFsLike>;
  /** A mount point that is not a directory (a bind-mounted file) is not a disk. */
  readonly stat: (path: string) => Promise<{ isDirectory(): boolean }>;
  readonly readMounts: () => string;
  /** Monotonic milliseconds; drives every timer. */
  readonly monoNow: () => number;
  /** Epoch milliseconds; stamped on each reading as `readAt`. */
  readonly epochNow: () => number;
  readonly log: {
    warn(msg: string, data: object): void;
    info(msg: string, data: object): void;
  };
  readonly platform: NodeJS.Platform;
  readonly exists: (path: string) => boolean;
}

export interface HostDisks {
  /** Readings in mount-table order; undefined until a mount table has been parsed once. */
  snapshot(): ReadonlyArray<HostMetricsDisk> | undefined;
}

/** `/proc/self/mounts` encodes space, tab, newline and backslash as `\ooo`. */
const decodeOctal = (field: string) =>
  field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Allowlisted local block devices from a `/proc/self/mounts` text, in table order. Of all rows
 * stacked on one mount point only the last (the visible top) counts, whatever its type; then the
 * allowlist applies. A source can have several rows; the reader picks the first directory.
 */
export function parseMounts(text: string): ReadonlyArray<MountRow> {
  const parsed: Array<{ source: string; rawMount: string; type: string; path: string }> = [];
  for (const line of text.split("\n")) {
    const [source, rawMount, type] = line.split(" ");
    if (source === undefined || rawMount === undefined || type === undefined) continue;
    parsed.push({ source, rawMount, type, path: decodeOctal(rawMount) });
  }
  const top = new Map(parsed.map((row) => [row.path, row]));
  const rows: MountRow[] = [];
  for (const row of parsed) {
    if (top.get(row.path) !== row) continue;
    if (!ALLOWED_TYPES.has(row.type)) continue;
    if (!row.source.startsWith("/dev/") || row.source.startsWith("/dev/loop")) continue;
    rows.push({
      source: row.source,
      mount: row.path.replace(CONTROL_CHARS, ""),
      type: row.type,
      path: row.path,
    });
  }
  return rows;
}

function toDisk(mount: string, s: StatFsLike, readAt: number): HostMetricsDisk {
  const usedBytes = (s.blocks - s.bfree) * s.bsize;
  const availBytes = s.bavail * s.bsize;
  const denominator = usedBytes + availBytes;
  return {
    mount,
    usedBytes,
    totalBytes: s.blocks * s.bsize,
    pct: denominator > 0 ? (usedBytes / denominator) * 100 : 0,
    readAt,
  };
}

const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unknown";
};
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function makeHostDisks(deps: HostDisksDeps): HostDisks {
  const { statfs, stat, monoNow, epochNow, log } = deps;
  /** Last reading per source, with the path it was taken at. */
  const cache = new Map<string, { readonly path: string; readonly disk: HostMetricsDisk }>();
  /** Each source's mount rows, in table order. */
  let rows = new Map<string, ReadonlyArray<MountRow>>();
  /** `row` is the candidate being read now. */
  const inFlight = new Map<string, { row: MountRow; readonly startedAt: number }>();
  /** Sources waiting for a slot, in mount-table order; never holds an in-flight source. */
  const queue = new Map<string, ReadonlyArray<MountRow>>();
  /** The row each stuck read was reported on, so its recovery names the same row. */
  const stuckLogged = new Map<string, MountRow>();
  /** Error codes already logged per source; cleared by a successful read. */
  const failureLogged = new Map<string, Set<string>>();
  let parsed = false;
  let mountsFailing = false;
  let saturated = false;
  /** Reads that settled since the last refresh after holding their slot a whole period. */
  let slowSettled = 0;
  let lastRefresh = 0;

  function readRows(): ReadonlyArray<MountRow> | undefined {
    if (deps.platform === "linux") return parseMounts(deps.readMounts());
    if (deps.platform === "darwin") {
      const path = deps.exists(DARWIN_DATA) ? DARWIN_DATA : "/";
      return [{ source: "darwin-data", mount: "/", type: "apfs", path }];
    }
    return undefined;
  }

  /** A source's mounts include this path. */
  const mountedAt = (source: string, path: string) =>
    rows.get(source)?.some((row) => row.path === path) === true;

  function refresh() {
    lastRefresh = monoNow();
    try {
      const next = readRows();
      if (next === undefined) return;
      rows = new Map();
      for (const row of next) rows.set(row.source, [...(rows.get(row.source) ?? []), row]);
      parsed = true;
      mountsFailing = false;
    } catch (error) {
      if (!mountsFailing) {
        mountsFailing = true;
        log.warn("disk mount table unreadable", {
          code: errorCode(error),
          error: errorMessage(error),
        });
      }
    }
    // A reading is shown only under the mount it was taken at.
    for (const [source, entry] of cache) {
      if (!mountedAt(source, entry.path)) cache.delete(source);
    }
    for (const source of queue.keys()) if (!rows.has(source)) queue.delete(source);
    for (const [source, candidates] of rows) {
      const running = inFlight.get(source);
      if (running === undefined) queue.set(source, candidates);
      else warnIfStuck(source, running.row, running.startedAt);
    }
    reportSaturation();
    pump();
  }

  function warnIfStuck(source: string, row: MountRow, startedAt: number) {
    const stuckMs = monoNow() - startedAt;
    if (stuckMs <= STUCK_MS || stuckLogged.has(source)) return;
    stuckLogged.set(source, row);
    log.warn("disk read stuck", {
      mount: row.mount,
      type: row.type,
      stuckMs,
      inFlight: inFlight.size,
    });
  }

  function pump() {
    while (inFlight.size < MAX_IN_FLIGHT) {
      const next = queue.entries().next();
      if (next.done === true) break;
      const [source, candidates] = next.value;
      queue.delete(source);
      start(source, candidates);
    }
  }

  /**
   * A source is named by the mount its last reading came from. A never-read source is named by
   * its device: its first row may be a file bind mount, not the disk.
   */
  const label = (source: string) => cache.get(source)?.disk.mount ?? source;

  /**
   * Saturated: every slot holds a read older than a period and some source is skipped. The
   * episode lasts while slow reads keep the slots busy (running past a period, or settled since
   * the last refresh after one), so 15 s reads are one episode, not a toggle.
   */
  function reportSaturation() {
    const stuck = [...inFlight.values()].filter((e) => monoNow() - e.startedAt >= REFRESH_MS);
    const busy = stuck.length + slowSettled;
    slowSettled = 0;
    if (saturated && busy >= MAX_IN_FLIGHT) return;
    if (stuck.length >= MAX_IN_FLIGHT) {
      const skipped = [...rows.keys()].filter((source) => !inFlight.has(source));
      if (saturated || skipped.length === 0) return;
      saturated = true;
      log.warn("disk reads saturated", {
        inFlight: stuck.map((entry) => entry.row.mount),
        skipped: skipped.map(label),
      });
    } else if (saturated) {
      saturated = false;
      log.info("disk reads no longer saturated", {});
    }
  }

  /**
   * One read of a source: its first row whose mount point is a directory. Every stat and statfs
   * runs inside this one in-flight slot, so a hang in either stays under the cap.
   */
  async function readSource(entry: { row: MountRow }, candidates: ReadonlyArray<MountRow>) {
    // A row whose stat fails is skipped; the read fails only if no later row is a directory.
    let failed: { readonly row: MountRow; readonly error: unknown } | undefined;
    for (const row of candidates) {
      entry.row = row;
      let isDirectory: boolean;
      try {
        isDirectory = (await stat(row.path)).isDirectory();
      } catch (error) {
        failed ??= { row, error };
        continue;
      }
      if (isDirectory) return { row, stat: await statfs(row.path) };
    }
    if (failed === undefined) return undefined;
    entry.row = failed.row;
    throw failed.error;
  }

  function start(source: string, candidates: ReadonlyArray<MountRow>) {
    const startedAt = monoNow();
    const entry = { row: candidates[0]!, startedAt };
    inFlight.set(source, entry);
    readSource(entry, candidates)
      .then((read) => {
        failureLogged.delete(source);
        // No directory among its mounts: a file bind mount is not a disk.
        if (read === undefined) cache.delete(source);
        // The source may have been unmounted or remounted while this read was parked.
        else if (mountedAt(source, read.row.path)) {
          cache.set(source, {
            path: read.row.path,
            disk: toDisk(read.row.mount, read.stat, epochNow()),
          });
        }
      })
      .catch((error: unknown) => {
        const code = errorCode(error);
        const logged = failureLogged.get(source) ?? new Set<string>();
        if (logged.has(code)) return;
        failureLogged.set(source, logged.add(code));
        log.warn("disk read failed", { mount: entry.row.mount, code, error: errorMessage(error) });
      })
      .finally(() => {
        inFlight.delete(source);
        if (monoNow() - startedAt >= REFRESH_MS) slowSettled += 1;
        const stuckRow = stuckLogged.get(source);
        if (stuckRow !== undefined) {
          stuckLogged.delete(source);
          log.info("disk read recovered", {
            mount: stuckRow.mount,
            afterMs: monoNow() - startedAt,
          });
        }
        pump();
      })
      // A throw from a log sink or pump here must not become an unhandled rejection.
      .catch(() => {});
  }

  refresh();
  return {
    snapshot() {
      if (monoNow() - lastRefresh >= REFRESH_MS) refresh();
      if (!parsed) return undefined;
      const disks: HostMetricsDisk[] = [];
      for (const source of rows.keys()) {
        const entry = cache.get(source);
        if (entry !== undefined) disks.push(entry.disk);
      }
      return disks;
    },
  };
}
