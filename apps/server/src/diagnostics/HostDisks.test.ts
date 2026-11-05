import { describe, expect, it } from "@effect/vitest";

import { makeHostDisks, parseMounts, type StatFsLike } from "./HostDisks.ts";

const line = (source: string, mount: string, type: string) =>
  `${source} ${mount} ${type} rw,relatime 0 0`;
const mountsText = (rows: ReadonlyArray<readonly [string, string]>) =>
  rows.map(([source, mount]) => line(source, mount, "ext4")).join("\n") + "\n";

/** Every mount point is a directory. */
const statDir = async () => ({ isDirectory: () => true });

/** 100 blocks of 4 KiB, 40 free, 30 available to non-root. */
const STAT: StatFsLike = { bsize: 4096, blocks: 100, bfree: 40, bavail: 30 };

/** Let every settled promise chain (then/catch/finally, pump) run. */
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};

interface Parked {
  readonly path: string;
  readonly resolve: (s: StatFsLike) => void;
  readonly reject: (e: unknown) => void;
}

/**
 * A reader over injected fakes. Paths in `hang` park their statfs until released;
 * everything else resolves with `STAT` on the next microtask.
 */
function harness(
  initialMounts: string,
  options: {
    hang?: ReadonlyArray<string>;
    /** Mount points that are files (bind mounts); every other path is a directory. */
    files?: ReadonlyArray<string>;
    /** Paths whose stat parks until released with `releaseStat`. */
    hangStat?: ReadonlyArray<string>;
    /** Paths whose stat rejects with this error code. */
    statErrors?: Readonly<Record<string, string>>;
  } = {},
) {
  const state = {
    mounts: initialMounts as string | Error,
    mono: 0,
    epoch: 1_782_000_000_000,
    hang: new Set(options.hang ?? []),
    files: new Set(options.files ?? []),
    hangStat: new Set(options.hangStat ?? []),
    stat: STAT,
  };
  const statCalls: string[] = [];
  const parkedStats: Array<{ path: string; release: () => void }> = [];
  const calls = new Map<string, number>();
  const parked: Parked[] = [];
  const warns: Array<{ msg: string; data: object }> = [];
  const infos: Array<{ msg: string; data: object }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const statfs = (path: string): Promise<StatFsLike> => {
    calls.set(path, (calls.get(path) ?? 0) + 1);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const result = state.hang.has(path)
      ? new Promise<StatFsLike>((resolve, reject) => parked.push({ path, resolve, reject }))
      : Promise.resolve(state.stat);
    return result.finally(() => {
      inFlight -= 1;
    });
  };
  const stat = (path: string) => {
    statCalls.push(path);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const isDir = { isDirectory: () => !state.files.has(path) };
    const code = options.statErrors?.[path];
    const result = code
      ? Promise.reject(Object.assign(new Error(`${code}: ${path}`), { code }))
      : state.hangStat.has(path)
        ? new Promise<typeof isDir>((resolve) =>
            parkedStats.push({ path, release: () => resolve(isDir) }),
          )
        : Promise.resolve(isDir);
    return result.finally(() => {
      inFlight -= 1;
    });
  };
  const reader = makeHostDisks({
    statfs,
    stat,
    exists: () => false,
    readMounts: () => {
      if (state.mounts instanceof Error) throw state.mounts;
      return state.mounts;
    },
    monoNow: () => state.mono,
    epochNow: () => state.epoch,
    log: {
      warn: (msg, data) => warns.push({ msg, data }),
      info: (msg, data) => infos.push({ msg, data }),
    },
    platform: "linux",
  });
  return {
    state,
    reader,
    calls,
    statCalls,
    parked,
    warns,
    infos,
    maxInFlight: () => maxInFlight,
    /** Advance the monotonic clock one refresh period and take a sample. */
    tick: async (ms = 10_000) => {
      state.mono += ms;
      state.epoch += ms;
      const snapshot = reader.snapshot();
      await flush();
      return snapshot;
    },
    release: (path: string) => {
      const index = parked.findIndex((p) => p.path === path);
      const [p] = parked.splice(index, 1);
      p!.resolve(state.stat);
    },
    releaseStat: (path: string) => {
      const index = parkedStats.findIndex((p) => p.path === path);
      parkedStats.splice(index, 1)[0]!.release();
    },
  };
}

const FOUR = mountsText([
  ["/dev/a", "/a"],
  ["/dev/b", "/b"],
  ["/dev/c", "/c"],
  ["/dev/d", "/d"],
]);

describe("parseMounts", () => {
  it("drops a mount point whose top row is not allowlisted", () => {
    const text = [line("/dev/sdb1", "/home", "ext4"), line("tmpfs", "/home", "tmpfs")].join("\n");
    expect(parseMounts(text)).toEqual([]);
  });

  it("a stacked-over source stays visible at its other mount", () => {
    const text = [
      line("/dev/sdb1", "/mnt/data", "ext4"),
      line("/dev/sdc1", "/mnt/data", "ext4"),
      line("/dev/sdb1", "/srv", "ext4"),
    ].join("\n");
    expect(parseMounts(text).map((row) => [row.source, row.path])).toEqual([
      ["/dev/sdc1", "/mnt/data"],
      ["/dev/sdb1", "/srv"],
    ]);
  });

  it("keeps only allowlisted block devices", () => {
    const text = [
      "/dev/nvme0n1p2 / ext4 rw,relatime 0 0",
      "/dev/loop3 /snap/core18/2999 squashfs ro,nodev,relatime,errors=continue,threads=single 0 0",
      "/dev/nvme0n1p1 /boot/efi vfat rw,relatime,fmask=0022,dmask=0022,codepage=437,iocharset=iso8859-1,shortname=mixed,errors=remount-ro 0 0",
      "/dev/loop7 /mnt/img ext4 rw 0 0",
      "server:/x /mnt/nfs nfs4 rw 0 0",
      "tmpfs /run tmpfs rw 0 0",
      "overlay /ovl overlay rw 0 0",
      "/dev/sdb1 /mnt/w fuseblk rw 0 0",
      "rpool/ROOT /zfs zfs rw 0 0",
      "/dev/sdc1 /x weirdfs rw 0 0",
      "devext4 /y ext4 rw 0 0",
      "",
    ].join("\n");
    expect(parseMounts(text)).toEqual([
      { source: "/dev/nvme0n1p2", mount: "/", type: "ext4", path: "/" },
    ]);
  });

  it("accepts every allowlisted type and nothing else", () => {
    const allowed = ["ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "exfat", "ntfs3"];
    const rejected = ["ntfs", "vfat", "EXT4", "ext", "apfs", "squashfs", "fuse.sshfs", ""];
    const text = [...allowed, ...rejected]
      .map((type, i) => line(`/dev/x${i}`, `/m${i}`, type))
      .join("\n");
    expect(parseMounts(text).map((row) => row.type)).toEqual(allowed);
  });

  it("decodes octal escapes", () => {
    const text = [
      line("/dev/sdd1", "/mnt/My\\040Disk", "ext4"),
      line("/dev/sdd2", "/mnt/tab\\011here", "ext4"),
      line("/dev/sdd3", "/mnt/back\\134slash", "ext4"),
    ].join("\n");
    expect(parseMounts(text).map((row) => row.mount)).toEqual([
      "/mnt/My Disk",
      "/mnt/tabhere",
      "/mnt/back\\slash",
    ]);
    expect(parseMounts(text)[0]!.path).toBe("/mnt/My Disk");
  });

  it("keeps hostile mount names intact as one row each", () => {
    // newline (\012), space, $, |, [, *, and a leading -; each line's fields stay aligned.
    const text = [
      line("/dev/h1", "/mnt/-x\\012y", "ext4"),
      line("/dev/h2", "/mnt/$HOME\\040|\\040[a]*", "xfs"),
      line("/dev/h3", "-rf", "btrfs"),
    ].join("\n");
    expect(parseMounts(text)).toEqual([
      // The label sent to clients drops control characters; statfs still gets the real path.
      { source: "/dev/h1", mount: "/mnt/-xy", type: "ext4", path: "/mnt/-x\ny" },
      { source: "/dev/h2", mount: "/mnt/$HOME | [a]*", type: "xfs", path: "/mnt/$HOME | [a]*" },
      { source: "/dev/h3", mount: "-rf", type: "btrfs", path: "-rf" },
    ]);
  });

  it("strips control characters from the label only", () => {
    const text = line("/dev/h4", "/mnt/\\033[31mred\\177\\011x", "ext4");
    expect(parseMounts(text)).toEqual([
      { source: "/dev/h4", mount: "/mnt/[31mredx", type: "ext4", path: "/mnt/\x1b[31mred\x7f\tx" },
    ]);
  });

  it("keeps only the top filesystem of a stacked mount point", () => {
    const text = [
      line("/dev/sda1", "/", "ext4"),
      line("/dev/sdb1", "/mnt/data", "ext4"),
      line("/dev/sdc1", "/mnt/data", "xfs"),
      line("/dev/sdd1", "/srv", "ext4"),
    ].join("\n");
    expect(parseMounts(text).map((row) => row.source)).toEqual([
      "/dev/sda1",
      "/dev/sdc1",
      "/dev/sdd1",
    ]);
  });

  it("stacked mount points are compared by real path, not by label", () => {
    const text = [
      line("/dev/sdb1", "/mnt/a\\012", "ext4"),
      line("/dev/sdc1", "/mnt/a", "ext4"),
    ].join("\n");
    expect(parseMounts(text).map((row) => row.source)).toEqual(["/dev/sdb1", "/dev/sdc1"]);
  });

  it("keeps every row of a source, in table order", () => {
    const text = [
      "/dev/sde1 / btrfs rw,subvol=/@ 0 0",
      "/dev/sde1 /home btrfs rw,subvol=/@home 0 0",
      "/dev/sde1 /srv/bind btrfs rw,subvol=/@home 0 0",
    ].join("\n");
    expect(parseMounts(text).map((row) => row.path)).toEqual(["/", "/home", "/srv/bind"]);
  });
});

describe("makeHostDisks", () => {
  it("computes sizes and pct from statfs fields", async () => {
    const h = harness(mountsText([["/dev/a", "/a"]]));
    await flush();
    expect(h.reader.snapshot()).toEqual([
      {
        mount: "/a",
        totalBytes: 100 * 4096,
        usedBytes: 60 * 4096,
        pct: (60 / 90) * 100,
        readAt: 1_782_000_000_000,
      },
    ]);
  });

  it("I1a every healthy disk is read once per refresh", async () => {
    const h = harness(FOUR);
    await flush();
    await h.tick();
    await h.tick();
    for (const path of ["/a", "/b", "/c", "/d"]) expect(h.calls.get(path)).toBe(3);
    expect(h.reader.snapshot()?.map((d) => d.mount)).toEqual(["/a", "/b", "/c", "/d"]);
  });

  it("healthy disks queued behind the cap are never reported saturated", async () => {
    const h = harness(FOUR);
    await flush();
    await h.tick();
    await h.tick();
    await h.tick();
    expect(h.calls.get("/d")).toBe(4);
    expect(h.warns).toEqual([]);
    expect(h.infos).toEqual([]);
  });

  it("refreshes at most once per 10 s", async () => {
    const h = harness(FOUR);
    await flush();
    await h.tick(9_999);
    expect(h.calls.get("/a")).toBe(1);
    await h.tick(1);
    expect(h.calls.get("/a")).toBe(2);
  });

  it("I1b a stuck read does not block the others", async () => {
    const h = harness(FOUR, { hang: ["/a"] });
    await flush();
    await h.tick();
    await h.tick();
    expect(h.calls.get("/a")).toBe(1);
    for (const path of ["/b", "/c", "/d"]) expect(h.calls.get(path)).toBe(3);
    expect(h.warns.filter((w) => w.msg === "disk reads saturated")).toEqual([]);
  });

  it("I1c at most two reads are in flight", async () => {
    const h = harness(FOUR, { hang: ["/a", "/b", "/c", "/d"] });
    await flush();
    expect(h.reader.snapshot()).toEqual([]);
    await h.tick();
    expect(await h.tick()).toEqual([]);
    expect(h.maxInFlight()).toBe(2);
    expect(h.calls.get("/a")).toBe(1);
    expect(h.calls.get("/b")).toBe(1);
    expect(h.calls.has("/c")).toBe(false);
    // One slot frees: the next queued disk is read without waiting for a refresh.
    h.release("/a");
    await flush();
    expect(h.calls.get("/c")).toBe(1);
    expect(h.maxInFlight()).toBe(2);
  });

  it("a queued source that is unmounted before its slot frees is never read", async () => {
    const h = harness(FOUR, { hang: ["/a", "/b"] });
    h.state.mounts = mountsText([
      ["/dev/a", "/a"],
      ["/dev/b", "/b"],
      ["/dev/d", "/d"],
    ]);
    await h.tick();
    h.release("/a");
    await flush();
    expect(h.calls.has("/c")).toBe(false);
    expect(h.calls.get("/d")).toBe(1);
  });

  it("keeps a stuck disk's last value while it is stuck", async () => {
    const h = harness(mountsText([["/dev/a", "/a"]]));
    await flush();
    const first = h.reader.snapshot();
    h.state.hang.add("/a");
    await h.tick();
    expect(await h.tick()).toEqual(first);
  });

  it("I12 a late result for an unmounted source is dropped", async () => {
    const h = harness(mountsText([["/dev/a", "/a"]]), { hang: ["/a"] });
    await flush();
    h.state.mounts = "";
    await h.tick();
    h.release("/a");
    await flush();
    expect(h.reader.snapshot()).toEqual([]);
    // Remounted at the same path with its new read parked: the read taken across the unmount
    // must not reappear.
    h.state.mounts = mountsText([["/dev/a", "/a"]]);
    expect(await h.tick()).toEqual([]);
    expect(h.calls.get("/a")).toBe(2);
  });

  it("I12 a late result for a remounted source is not labelled with the old mount", async () => {
    const h = harness(mountsText([["/dev/a", "/a"]]), { hang: ["/a"] });
    await flush();
    h.state.mounts = mountsText([["/dev/a", "/new"]]);
    await h.tick();
    h.release("/a");
    await flush();
    expect(h.reader.snapshot()).toEqual([]);
    // The next refresh reads the new mount and labels it correctly.
    await h.tick();
    expect(h.reader.snapshot()?.map((d) => d.mount)).toEqual(["/new"]);
  });

  it("I12 a value read before a remount is not shown under the old mount", async () => {
    const h = harness(mountsText([["/dev/a", "/a"]]));
    await flush();
    expect(h.reader.snapshot()?.map((d) => d.mount)).toEqual(["/a"]);
    h.state.hang.add("/new");
    h.state.mounts = mountsText([["/dev/a", "/new"]]);
    expect(await h.tick()).toEqual([]);
  });

  it("I12 a remount to a path with the same label is still a remount", async () => {
    const h = harness(mountsText([["/dev/a", "/a\\012"]]));
    await flush();
    expect(h.reader.snapshot()?.map((d) => d.mount)).toEqual(["/a"]);
    h.state.hang.add("/a");
    h.state.mounts = mountsText([["/dev/a", "/a"]]);
    expect(await h.tick()).toEqual([]);
  });

  it("I12 a late result from the old path is not shown under a same-label new path", async () => {
    const h = harness(mountsText([["/dev/a", "/a\\012"]]), { hang: ["/a\n"] });
    await flush();
    h.state.hang.add("/a");
    h.state.mounts = mountsText([["/dev/a", "/a"]]);
    await h.tick();
    h.release("/a\n");
    await flush();
    expect(h.reader.snapshot()).toEqual([]);
  });

  it("I14 readMounts throwing at construct never throws", async () => {
    const emfile = Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
    let mono = 0;
    let mounts: string | Error = emfile;
    const warns: object[] = [];
    const reader = makeHostDisks({
      statfs: async () => STAT,
      readMounts: () => {
        if (mounts instanceof Error) throw mounts;
        return mounts;
      },
      monoNow: () => mono,
      epochNow: () => 0,
      log: { warn: (_msg, data) => warns.push(data), info: () => {} },
      platform: "linux",
      stat: statDir,
      exists: () => false,
    });
    expect(reader.snapshot()).toBeUndefined();
    mono += 10_000;
    expect(() => reader.snapshot()).not.toThrow();
    expect(reader.snapshot()).toBeUndefined();
    expect(warns).toEqual([{ code: "EMFILE", error: "EMFILE: too many open files" }]);
    // Once the table reads, disks appear.
    mounts = FOUR;
    mono += 10_000;
    reader.snapshot();
    await flush();
    expect(reader.snapshot()).toHaveLength(4);
  });

  it("I14 readMounts throwing on a refresh keeps the previous rows", async () => {
    const h = harness(FOUR);
    await flush();
    const before = h.reader.snapshot();
    h.state.mounts = Object.assign(new Error("EMFILE"), { code: "EMFILE" });
    expect(await h.tick()).toEqual(before);
    await h.tick();
    expect(h.calls.get("/a")).toBe(3);
    expect(h.warns.filter((w) => w.msg.includes("mount table"))).toHaveLength(1);
    // A later, separate failure episode warns again.
    h.state.mounts = FOUR;
    await h.tick();
    h.state.mounts = new Error("EIO");
    await h.tick();
    expect(h.warns.filter((w) => w.msg.includes("mount table"))).toHaveLength(2);
  });

  it("a statfs that throws synchronously never throws out of snapshot", async () => {
    const warns: object[] = [];
    const reader = makeHostDisks({
      statfs: () => {
        throw Object.assign(new Error("boom"), { code: "EINVAL" });
      },
      readMounts: () => FOUR,
      monoNow: () => 0,
      epochNow: () => 0,
      log: { warn: (_msg, data) => warns.push(data), info: () => {} },
      platform: "linux",
      stat: statDir,
      exists: () => false,
    });
    await flush();
    expect(reader.snapshot()).toEqual([]);
    expect(warns.length).toBeGreaterThan(0);
  });

  it("nothing allowlisted yields [] after first refresh", () => {
    const h = harness("tmpfs /run tmpfs rw 0 0\n");
    expect(h.reader.snapshot()).toEqual([]);
  });

  it("pct is 0 when used+avail is 0", async () => {
    const h = harness(mountsText([["/dev/a", "/a"]]));
    await flush();
    h.state.stat = { bsize: 4096, blocks: 0, bfree: 0, bavail: 0 };
    await h.tick();
    expect(h.reader.snapshot()?.[0]?.pct).toBe(0);
  });

  it("a failed statfs keeps the last value and logs once per source and code", async () => {
    const h = harness(mountsText([["/dev/a", "/a"]]));
    await flush();
    const first = h.reader.snapshot();
    h.state.hang.add("/a");
    for (let i = 0; i < 3; i++) {
      await h.tick();
      h.parked.splice(0).forEach((p) => p.reject(Object.assign(new Error("EIO"), { code: "EIO" })));
      await flush();
    }
    await h.tick();
    h.parked
      .splice(0)
      .forEach((p) => p.reject(Object.assign(new Error("EACCES"), { code: "EACCES" })));
    await flush();
    expect(h.reader.snapshot()).toEqual(first);
    const failed = h.warns.filter((w) => w.msg === "disk read failed");
    expect(failed.map((w) => (w.data as { code: string }).code)).toEqual(["EIO", "EACCES"]);
  });

  it("a failure after a successful read logs again", async () => {
    const h = harness(mountsText([["/dev/a", "/a"]]));
    await flush();
    const eio = () => Object.assign(new Error("EIO"), { code: "EIO" });
    const failOnce = async () => {
      h.state.hang.add("/a");
      await h.tick();
      h.parked.splice(0).forEach((p) => p.reject(eio()));
      await flush();
      h.state.hang.delete("/a");
    };
    await failOnce();
    await failOnce();
    await h.tick(); // succeeds: ends the episode
    await failOnce();
    expect(h.warns.filter((w) => w.msg === "disk read failed")).toHaveLength(2);
  });

  it("stuck warn fires once after 30 s and recovered info when it resolves", async () => {
    const h = harness(mountsText([["/dev/a", "/a"]]), { hang: ["/a"] });
    await h.tick(); // 10 s
    await h.tick(); // 20 s
    await h.tick(); // 30 s: not yet past 30 s
    expect(h.warns.filter((w) => w.msg === "disk read stuck")).toHaveLength(0);
    await h.tick(); // 40 s
    await h.tick(); // 50 s
    const stuck = h.warns.filter((w) => w.msg === "disk read stuck");
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.data).toMatchObject({
      mount: "/a",
      type: "ext4",
      stuckMs: 40_000,
      inFlight: 1,
    });
    h.release("/a");
    await flush();
    const recovered = h.infos.filter((i) => i.msg === "disk read recovered");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.data).toMatchObject({ mount: "/a", afterMs: 50_000 });
  });

  it("a stuck warning names the mount the hung read started on", async () => {
    const h = harness(mountsText([["/dev/a", "/a"]]), { hang: ["/a"] });
    h.state.mounts = mountsText([["/dev/a", "/new"]]);
    for (let i = 0; i < 4; i++) await h.tick();
    const stuck = h.warns.filter((w) => w.msg === "disk read stuck");
    expect(stuck.map((w) => (w.data as { mount: string }).mount)).toEqual(["/a"]);
  });

  it("a throwing log sink during settlement leaves no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let mono = 0;
      const parked: Array<(s: StatFsLike) => void> = [];
      const reader = makeHostDisks({
        statfs: (path) =>
          path === "/a"
            ? new Promise((resolve) => parked.push(resolve))
            : Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" })),
        readMounts: () =>
          mountsText([
            ["/dev/a", "/a"],
            ["/dev/b", "/b"],
          ]),
        monoNow: () => mono,
        epochNow: () => 0,
        log: {
          warn: (msg) => {
            if (msg !== "disk read stuck") throw new Error("warn sink down");
          },
          info: () => {
            throw new Error("info sink down");
          },
        },
        platform: "linux",
        stat: statDir,
        exists: () => false,
      });
      for (let i = 0; i < 4; i++) {
        mono += 10_000;
        reader.snapshot();
        await flush();
      }
      parked.splice(0).forEach((resolve) => resolve(STAT));
      // Two macrotask turns: Node reports a rejection nobody observed after the first.
      for (let turn = 0; turn < 2; turn++) {
        // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- Node emits unhandledRejection only between macrotasks; no promise can mark that point.
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(unhandled).toEqual([]);
      // The reader keeps working after the sinks threw.
      expect(reader.snapshot()?.map((d) => d.mount)).toEqual(["/a"]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a read that resolves without being reported stuck logs no recovery", async () => {
    const h = harness(mountsText([["/dev/a", "/a"]]), { hang: ["/a"] });
    await h.tick();
    h.release("/a");
    await flush();
    expect(h.infos).toHaveLength(0);
  });

  it("saturated warn names skipped mounts once per episode", async () => {
    const h = harness(FOUR, { hang: ["/a", "/b"] });
    await h.tick();
    await h.tick();
    const saturated = h.warns.filter((w) => w.msg === "disk reads saturated");
    expect(saturated).toHaveLength(1);
    // Never read, so named by device.
    expect(saturated[0]!.data).toEqual({ inFlight: ["/a", "/b"], skipped: ["/dev/c", "/dev/d"] });
    // /a settles (after holding its slot two periods) and reads fast from now on.
    h.state.hang.delete("/a");
    h.release("/a");
    await flush();
    const over = () => h.infos.filter((i) => i.msg === "disk reads no longer saturated");
    // Its slow read still counts for the period it settled in; the refresh after reports it over.
    await h.tick();
    expect(over()).toHaveLength(0);
    await h.tick();
    expect(over()).toHaveLength(1);
    // /a hangs again, so /c and /d wait a whole period: a second episode warns again.
    h.state.hang.add("/a");
    await h.tick();
    await h.tick();
    expect(h.warns.filter((w) => w.msg === "disk reads saturated")).toHaveLength(2);
  });

  it("a source mounted several times is read once, at its first row", async () => {
    const h = harness(
      ["/dev/sde1 / btrfs rw,subvol=/@ 0 0", "/dev/sde1 /home btrfs rw,subvol=/@home 0 0"].join(
        "\n",
      ),
    );
    await flush();
    expect(h.statCalls).toEqual(["/"]);
    expect(h.reader.snapshot()?.map((d) => d.mount)).toEqual(["/"]);
  });

  it("F4 in a container the disk is named by its directory mount, not a bind-mounted file", async () => {
    // Docker: the root is overlay, and the host disk's first rows are single-file bind mounts.
    const docker = [
      "overlay / overlay rw,relatime,lowerdir=/var/lib/docker/l1,upperdir=/u,workdir=/w 0 0",
      "proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0",
      "tmpfs /dev tmpfs rw,nosuid,size=65536k,mode=755 0 0",
      "/dev/sda1 /etc/resolv.conf ext4 rw,relatime 0 0",
      "/dev/sda1 /etc/hostname ext4 rw,relatime 0 0",
      "/dev/sda1 /etc/hosts ext4 rw,relatime 0 0",
      "/dev/sda1 /work\\040$x\\040|\\040[a]*\\012-y ext4 rw,relatime 0 0",
      "/dev/sdb1 /run/secrets/-token ext4 ro,relatime 0 0",
    ].join("\n");
    const files = ["/etc/resolv.conf", "/etc/hostname", "/etc/hosts", "/run/secrets/-token"];
    const h = harness(docker, { files });
    await flush();
    expect(h.reader.snapshot()?.map((d) => d.mount)).toEqual(["/work $x | [a]*-y"]);
    // Directories are found in table order; statfs only ever sees the directory.
    expect(h.statCalls).toEqual([
      "/etc/resolv.conf",
      "/run/secrets/-token",
      "/etc/hostname",
      "/etc/hosts",
      "/work $x | [a]*\n-y",
    ]);
    expect([...h.calls.keys()]).toEqual(["/work $x | [a]*\n-y"]);
    // A source whose every mount is a file never appears, refresh after refresh.
    await h.tick();
    expect(h.reader.snapshot()?.map((d) => d.mount)).toEqual(["/work $x | [a]*-y"]);
    expect(h.calls.has("/run/secrets/-token")).toBe(false);
  });

  it("F4 a mount point that became a file drops its reading", async () => {
    const h = harness(mountsText([["/dev/a", "/a"]]));
    await flush();
    expect(h.reader.snapshot()?.map((d) => d.mount)).toEqual(["/a"]);
    h.state.files.add("/a");
    await h.tick();
    expect(h.reader.snapshot()).toEqual([]);
  });

  it("F4 a hung stat holds its read's slot, so the cap still holds", async () => {
    const h = harness(
      mountsText([
        ["/dev/a", "/a\\040b"],
        ["/dev/b", "/$b"],
        ["/dev/c", "/c"],
      ]),
      { hangStat: ["/a b", "/$b"] },
    );
    await flush();
    await h.tick();
    expect(h.maxInFlight()).toBe(2);
    expect(h.statCalls).toEqual(["/a b", "/$b"]);
    expect(h.calls.size).toBe(0);
    // The hung stat is stuck like a hung statfs: it names the mount and the reads waiting.
    const saturated = h.warns.filter((w) => w.msg === "disk reads saturated");
    expect(saturated.map((w) => w.data)).toEqual([
      { inFlight: ["/a b", "/$b"], skipped: ["/dev/c"] },
    ]);
    h.releaseStat("/a b");
    await flush();
    expect([...h.calls.keys()]).toEqual(["/a b", "/c"]);
    expect(h.maxInFlight()).toBe(2);
  });

  it("F2 the saturated warning names every stuck read and every disk going unread", async () => {
    // Two hung disks hold both slots. `/` was read once and queues again behind them, so it goes
    // stale; `/-backup [1]` never gets a read. Both are skipped.
    const h = harness(
      mountsText([
        ["/dev/a", "/"],
        ["/dev/b", "/data\\040$HOME"],
        ["/dev/c", "/scratch|*"],
        ["/dev/d", "/-backup\\040[1]"],
      ]),
      { hang: ["/data $HOME", "/scratch|*"] },
    );
    await flush();
    expect(Object.fromEntries(h.calls)).toEqual({ "/": 1, "/data $HOME": 1, "/scratch|*": 1 });
    // A disk mounted in the saturated refresh itself is skipped too.
    h.state.mounts += line("/dev/e", "/new\\040e", "ext4");
    await h.tick();
    await h.tick();
    const saturated = h.warns.filter((w) => w.msg === "disk reads saturated");
    expect(saturated.map((w) => w.data)).toEqual([
      { inFlight: ["/data $HOME", "/scratch|*"], skipped: ["/", "/dev/d", "/dev/e"] },
    ]);
    expect(h.calls.get("/")).toBe(1);
  });

  it("F2 a skipped disk is named by the mount it was last read at, not a bind-mounted file", async () => {
    const h = harness(
      [
        line("/dev/sda1", "/etc/hosts", "ext4"),
        line("/dev/sda1", "/work", "ext4"),
        line("/dev/b", "/b", "ext4"),
        line("/dev/c", "/c", "ext4"),
      ].join("\n"),
      { files: ["/etc/hosts"], hang: ["/b", "/c"] },
    );
    await flush();
    // The first refresh re-queues /work behind the two hung reads; it has waited by the second.
    await h.tick();
    await h.tick();
    const saturated = h.warns.filter((w) => w.msg === "disk reads saturated");
    expect(saturated.map((w) => w.data)).toEqual([{ inFlight: ["/b", "/c"], skipped: ["/work"] }]);
  });

  it("N2 one disk waiting a whole period is saturation", async () => {
    const h = harness(
      mountsText([
        ["/dev/a", "/a"],
        ["/dev/b", "/b"],
        ["/dev/c", "/c"],
      ]),
      { hang: ["/a", "/b"] },
    );
    await h.tick();
    const saturated = h.warns.filter((w) => w.msg === "disk reads saturated");
    expect(saturated.map((w) => w.data)).toEqual([{ inFlight: ["/a", "/b"], skipped: ["/dev/c"] }]);
  });

  it("R2-F1 a row whose stat fails is skipped; the read fails only when no row is a directory", async () => {
    const h = harness(
      [
        line("/dev/sda1", "/etc/hosts", "ext4"),
        line("/dev/sda1", "/locked\\040$x", "ext4"),
        line("/dev/sda1", "/work", "ext4"),
        line("/dev/sdb1", "/-gone", "ext4"),
        line("/dev/sdc1", "/gone|2", "ext4"),
        line("/dev/sdc1", "/etc/c.conf", "ext4"),
      ].join("\n"),
      {
        files: ["/etc/hosts", "/etc/c.conf"],
        statErrors: { "/locked $x": "EACCES", "/-gone": "ENOENT", "/gone|2": "ENOENT" },
      },
    );
    await flush();
    expect(h.reader.snapshot()?.map((d) => d.mount)).toEqual(["/work"]);
    const failed = h.warns.filter((w) => w.msg === "disk read failed");
    // Each failure names the row whose stat failed.
    expect(
      failed.map((w) => [(w.data as { mount: string }).mount, (w.data as { code: string }).code]),
    ).toEqual([
      ["/-gone", "ENOENT"],
      ["/gone|2", "ENOENT"],
    ]);
  });

  it("R2-F2 stuck, saturated and recovered logs name the directory row being read", async () => {
    const h = harness(
      [
        line("/dev/sda1", "/etc/resolv.conf", "ext4"),
        line("/dev/sda1", "/work\\040$w", "ext4"),
        line("/dev/sdb1", "/b", "ext4"),
        line("/dev/sdc1", "/etc/c.conf", "ext4"),
        line("/dev/sdc1", "/c", "ext4"),
      ].join("\n"),
      { files: ["/etc/resolv.conf", "/etc/c.conf"], hang: ["/work $w", "/b"] },
    );
    await flush(); // the file row's stat settles; the read moves on to the directory
    for (let i = 0; i < 4; i++) await h.tick();
    const mounts = (msg: string) =>
      h.warns.filter((w) => w.msg === msg).map((w) => (w.data as { mount: string }).mount);
    expect(mounts("disk read stuck")).toEqual(["/work $w", "/b"]);
    // A never-read source is named by its device, not its first (file) row.
    expect(h.warns.filter((w) => w.msg === "disk reads saturated").map((w) => w.data)).toEqual([
      { inFlight: ["/work $w", "/b"], skipped: ["/dev/sdc1"] },
    ]);
    h.release("/work $w");
    await flush();
    expect(
      h.infos
        .filter((i) => i.msg === "disk read recovered")
        .map((i) => (i.data as { mount: string }).mount),
    ).toEqual(["/work $w"]);
  });

  it("R2-N2 one stuck episode names the same row when stuck and when recovered", async () => {
    const h = harness(
      [line("/dev/sda1", "/etc/hosts", "ext4"), line("/dev/sda1", "/work", "ext4")].join("\n"),
      { files: ["/etc/hosts"], hangStat: ["/etc/hosts"] },
    );
    for (let i = 0; i < 4; i++) await h.tick();
    h.releaseStat("/etc/hosts");
    await flush();
    const stuck = h.warns.filter((w) => w.msg === "disk read stuck");
    const recovered = h.infos.filter((i) => i.msg === "disk read recovered");
    expect(stuck.map((w) => (w.data as { mount: string }).mount)).toEqual(["/etc/hosts"]);
    expect(recovered.map((i) => (i.data as { mount: string }).mount)).toEqual(["/etc/hosts"]);
    expect(h.reader.snapshot()?.map((d) => d.mount)).toEqual(["/work"]);
  });

  it("R2-N3 nothing skipped is not saturation, even with every slot stuck", async () => {
    const h = harness(
      mountsText([
        ["/dev/a", "/a"],
        ["/dev/b", "/b"],
        ["/dev/c", "/c"],
      ]),
      { hang: ["/a", "/b"] },
    );
    // The waiting disk is unmounted before anyone could call it skipped.
    h.state.mounts = mountsText([
      ["/dev/a", "/a"],
      ["/dev/b", "/b"],
    ]);
    await h.tick();
    await h.tick();
    expect(h.warns.filter((w) => w.msg === "disk reads saturated")).toEqual([]);
    expect(h.infos).toEqual([]);
  });

  it("R2-N4 a read under one period old does not count as stuck", async () => {
    const h = harness(FOUR, { hang: ["/a", "/b", "/c"] });
    await flush();
    // Half a period in, /a settles and /c takes its slot; /d waits behind /b and /c.
    h.state.mono = 5_000;
    h.release("/a");
    await flush();
    await h.tick(5_000);
    expect(h.calls.get("/c")).toBe(1);
    expect(h.warns.filter((w) => w.msg === "disk reads saturated")).toEqual([]);
    // A period later both slots have been held a whole period.
    await h.tick();
    expect(h.warns.filter((w) => w.msg === "disk reads saturated").map((w) => w.data)).toEqual([
      { inFlight: ["/b", "/c"], skipped: ["/a", "/dev/d"] },
    ]);
  });

  it("R2-N4 a saturation episode lasts while the same reads hold the slots", async () => {
    const three = mountsText([
      ["/dev/a", "/a"],
      ["/dev/b", "/b"],
      ["/dev/c", "/c"],
    ]);
    const h = harness(three, { hang: ["/a", "/b"] });
    await h.tick();
    // The skipped disk comes and goes; both reads stay hung.
    h.state.mounts = mountsText([
      ["/dev/a", "/a"],
      ["/dev/b", "/b"],
    ]);
    await h.tick();
    h.state.mounts = three;
    await h.tick();
    const saturated = () => h.warns.filter((w) => w.msg === "disk reads saturated");
    const over = () => h.infos.filter((i) => i.msg === "disk reads no longer saturated");
    expect([saturated().length, over().length]).toEqual([1, 0]);
    // A slot frees for good: the episode ends once, a period after the slow read settled.
    h.state.hang.delete("/a");
    h.release("/a");
    await flush();
    await h.tick();
    expect([saturated().length, over().length]).toEqual([1, 0]);
    await h.tick();
    expect([saturated().length, over().length]).toEqual([1, 1]);
  });

  it("R3-N1 reads that take 15 s every time are one saturation episode, not a toggle", async () => {
    const h = harness(
      mountsText([
        ["/dev/a", "/a\\040$x"],
        ["/dev/b", "/-b|*"],
        ["/dev/c", "/c"],
      ]),
      { hang: ["/a $x", "/-b|*"] },
    );
    await flush();
    const saturated = () => h.warns.filter((w) => w.msg === "disk reads saturated");
    const over = () => h.infos.filter((i) => i.msg === "disk reads no longer saturated");
    /** Each slow read settles 15 s after it started; refreshes come every 10 s. */
    const settleAt = async (mono: number) => {
      h.state.mono = mono;
      h.state.epoch = 1_782_000_000_000 + mono;
      h.release("/a $x");
      h.release("/-b|*");
      await flush();
    };
    await h.tick(); // 10 s: both slots held a period, /c skipped
    await settleAt(15_000);
    await h.tick(5_000); // 20 s: fresh reads in the slots
    await h.tick(); // 30 s
    await settleAt(35_000);
    await h.tick(5_000); // 40 s
    await h.tick(); // 50 s
    expect(saturated().map((w) => w.data)).toEqual([
      { inFlight: ["/a $x", "/-b|*"], skipped: ["/dev/c"] },
    ]);
    expect(over()).toEqual([]);
    // The disks speed up: the episode ends once, a period after the last slow read settled.
    h.state.hang.clear();
    await settleAt(55_000);
    await h.tick(5_000); // 60 s
    expect(over()).toEqual([]);
    await h.tick(); // 70 s
    expect([saturated().length, over().length]).toEqual([1, 1]);
  });

  it("darwin reads one data volume row", async () => {
    const paths: string[] = [];
    const make = (exists: boolean) =>
      makeHostDisks({
        statfs: async (path) => {
          paths.push(path);
          return STAT;
        },
        readMounts: () => {
          throw new Error("not on darwin");
        },
        monoNow: () => 0,
        epochNow: () => 0,
        log: { warn: () => {}, info: () => {} },
        platform: "darwin",
        stat: statDir,
        exists: (path) => path === "/System/Volumes/Data" && exists,
      });
    const withData = make(true);
    const without = make(false);
    await flush();
    expect(paths).toEqual(["/System/Volumes/Data", "/"]);
    expect(withData.snapshot()?.map((d) => d.mount)).toEqual(["/"]);
    expect(without.snapshot()?.map((d) => d.mount)).toEqual(["/"]);
  });

  it("an unsupported platform never reports disks", async () => {
    const reader = makeHostDisks({
      statfs: async () => STAT,
      readMounts: () => FOUR,
      monoNow: () => 0,
      epochNow: () => 0,
      log: { warn: () => {}, info: () => {} },
      platform: "win32",
      stat: statDir,
      exists: () => false,
    });
    await flush();
    expect(reader.snapshot()).toBeUndefined();
  });
});
