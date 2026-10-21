import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  update: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock(import("../../hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () =>
    ({
      theme: "system",
      followSystem: true,
      themeHalves: null,
      setTheme: vi.fn(),
      setFollowSystem: vi.fn(),
      setThemeHalf: vi.fn(),
      clearThemeHalves: vi.fn(),
    }) as never,
  readThemePreference: () => "system",
  readThemeHalves: () => null,
  readAppearanceModePreference: () => "system",
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => state.settings!) as never,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }) as never,
}));

import { useSettingsRestore } from "./SettingsPanels";

let restore: ReturnType<typeof useSettingsRestore>;

function Probe() {
  const result = useSettingsRestore();
  useEffect(() => {
    restore = result;
  });
  return null;
}

describe("restoring V2 settings", () => {
  it.each([
    ["threadDetailsSectionRowLimit", 10, "Thread details rows"],
    ["usagePaceTolerance", 30, "Pace tolerance"],
  ] as const)(
    "lists %s once it changes after the first render, and restores it",
    async (key, value, label) => {
      state.settings = { ...DEFAULT_UNIFIED_SETTINGS };
      state.update.mockClear();
      state.confirm.mockReset().mockResolvedValue(true);
      await using screen = await render(<Probe />, { router: false });
      expect(restore.changedSettingLabels).toEqual([]);

      state.settings = { ...DEFAULT_UNIFIED_SETTINGS, [key]: value };
      await screen.rerender(<Probe />);

      expect(restore.changedSettingLabels).toEqual([label]);
      await act(() => restore.restoreDefaults());
      expect(state.update.mock.calls[0]?.[0][key]).toBe(DEFAULT_UNIFIED_SETTINGS[key]);
    },
  );
});
