import { describe, expect, it } from "vite-plus/test";

import {
  addArg,
  bytesToGb,
  gbToBytes,
  removeArgAt,
  removePerModel,
  renamePerModelKey,
  setPerModelArgs,
} from "./LocalModelsSettings.logic";

describe("bytes <-> GB", () => {
  it("maps 0 (auto sentinel) both ways", () => {
    expect(bytesToGb(0)).toBe(0);
    expect(gbToBytes(0)).toBe(0);
  });
  it("rounds bytes to one decimal GB and back", () => {
    expect(bytesToGb(91_000_000_000)).toBe(91);
    expect(bytesToGb(10_500_000_000)).toBe(10.5);
    expect(gbToBytes(102)).toBe(102_000_000_000);
  });
  it("clamps negatives / NaN to 0 (auto)", () => {
    expect(bytesToGb(-5)).toBe(0);
    expect(gbToBytes(-1)).toBe(0);
    expect(gbToBytes(Number.NaN)).toBe(0);
  });
});

describe("arg list edits", () => {
  it("appends a trimmed token, ignoring blanks", () => {
    expect(addArg(["--a"], " --b ")).toEqual(["--a", "--b"]);
    expect(addArg(["--a"], "   ")).toEqual(["--a"]);
  });
  it("removes by index, no-op out of range", () => {
    expect(removeArgAt(["--a", "0", "--b"], 1)).toEqual(["--a", "--b"]);
    expect(removeArgAt(["--a"], 5)).toEqual(["--a"]);
  });
});

describe("perModel record edits", () => {
  it("sets, renames, and removes overrides without mutating", () => {
    const base = { "model-a": { args: ["--x"] } };
    const withB = setPerModelArgs(base, "model-b", ["--y", "1"]);
    expect(withB).toEqual({ "model-a": { args: ["--x"] }, "model-b": { args: ["--y", "1"] } });
    expect(base).toEqual({ "model-a": { args: ["--x"] } }); // unmutated

    const renamed = renamePerModelKey(withB, "model-a", "model-z");
    expect(Object.keys(renamed).sort()).toEqual(["model-b", "model-z"]);
    expect(renamed["model-z"]).toEqual({ args: ["--x"] });

    expect(removePerModel(renamed, "model-b")).toEqual({ "model-z": { args: ["--x"] } });
  });

  it("rename is a no-op on collision / blank / unchanged (never loses an override)", () => {
    const base = { a: { args: ["--x"] }, b: { args: ["--y"] } };
    expect(renamePerModelKey(base, "a", "b")).toEqual(base); // collision → unchanged
    expect(renamePerModelKey(base, "a", "")).toEqual(base); // blank → unchanged
    expect(renamePerModelKey(base, "a", "a")).toEqual(base); // unchanged
  });
});
