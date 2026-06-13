import { describe, expect, it } from "vite-plus/test";
import { stripAnsi } from "./SidebarDetailPanel";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe("stripAnsi", () => {
  it("removes CSI color/cursor sequences", () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe("red");
    expect(stripAnsi(`a${ESC}[2Kb`)).toBe("ab");
  });

  it("removes OSC title sequences terminated by BEL or ST", () => {
    expect(stripAnsi(`${ESC}]0;my title${BEL}done`)).toBe("done");
    expect(stripAnsi(`${ESC}]0;t${ESC}\\done`)).toBe("done");
  });

  it("leaves plain bracketed text untouched", () => {
    expect(stripAnsi("arr[0] = items[1]")).toBe("arr[0] = items[1]");
    expect(stripAnsi("[INFO] build ok")).toBe("[INFO] build ok");
  });
});
