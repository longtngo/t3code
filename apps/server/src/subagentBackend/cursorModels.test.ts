import { describe, expect, it } from "@effect/vitest";

import { parseCursorModelList } from "./cursorModels.ts";

const SAMPLE = `Available models

auto - Auto (default)
composer-2.5 - Composer 2.5 (current)
cursor-grok-4.6-high - Cursor Grok 4.6
`;

describe("parseCursorModelList", () => {
  it("parses id and label pairs, ignoring the banner", () => {
    const models = parseCursorModelList(SAMPLE);
    expect(models).toEqual([
      { id: "auto", label: "Auto" },
      { id: "composer-2.5", label: "Composer 2.5" },
      { id: "cursor-grok-4.6-high", label: "Cursor Grok 4.6" },
    ]);
  });

  it("returns nothing for unparseable output rather than inventing ids", () => {
    expect(parseCursorModelList("command not found")).toEqual([]);
  });
});
