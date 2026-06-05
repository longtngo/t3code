import { ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { recallAccountModel, rememberAccountModel } from "./accountModelMemory";

const STORAGE_KEY = "t3code:account-model-memory:v1";
const work = ProviderInstanceId.make("claudeAgent");
const personal = ProviderInstanceId.make("claude_personal");

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

describe("accountModelMemory", () => {
  let stub: Storage;

  beforeEach(() => {
    stub = createLocalStorageStub();
    vi.stubGlobal("localStorage", stub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips a remembered model per instance", () => {
    rememberAccountModel(work, "claude-opus-4-8");
    rememberAccountModel(personal, "claude-sonnet-4-6");
    expect(recallAccountModel(work)).toBe("claude-opus-4-8");
    expect(recallAccountModel(personal)).toBe("claude-sonnet-4-6");
  });

  it("returns undefined for an unknown instance", () => {
    expect(recallAccountModel(work)).toBeUndefined();
  });

  it("trims surrounding whitespace before storing", () => {
    rememberAccountModel(work, "  claude-opus-4-8  ");
    expect(recallAccountModel(work)).toBe("claude-opus-4-8");
  });

  it("ignores empty / whitespace-only models", () => {
    rememberAccountModel(work, "");
    rememberAccountModel(work, "   ");
    expect(recallAccountModel(work)).toBeUndefined();
  });

  it("overwrites a prior model for the same instance", () => {
    rememberAccountModel(work, "claude-sonnet-4-6");
    rememberAccountModel(work, "claude-opus-4-8");
    expect(recallAccountModel(work)).toBe("claude-opus-4-8");
  });

  it("recovers from corrupt persisted JSON", () => {
    stub.setItem(STORAGE_KEY, "{not json");
    expect(recallAccountModel(work)).toBeUndefined();
    // and a subsequent write still succeeds
    rememberAccountModel(work, "claude-opus-4-8");
    expect(recallAccountModel(work)).toBe("claude-opus-4-8");
  });

  it("filters non-string persisted values", () => {
    stub.setItem(STORAGE_KEY, JSON.stringify({ [work]: 42, [personal]: "claude-sonnet-4-6" }));
    expect(recallAccountModel(work)).toBeUndefined();
    expect(recallAccountModel(personal)).toBe("claude-sonnet-4-6");
  });

  it("does not throw when localStorage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => rememberAccountModel(work, "claude-opus-4-8")).not.toThrow();
    expect(recallAccountModel(work)).toBeUndefined();
  });

  it("swallows setItem failures (quota) without throwing", () => {
    vi.stubGlobal("localStorage", {
      ...createLocalStorageStub(),
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(() => rememberAccountModel(work, "claude-opus-4-8")).not.toThrow();
  });
});
