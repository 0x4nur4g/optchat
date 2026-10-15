import { describe, expect, test } from "bun:test";
import { zoom, type ZoomStore } from "../src/tools/zoom";
import { dateOf, lookup } from "../src/tools/date";
import { formatAddress, nodeKey } from "../src/tree/address";
import { CAP } from "../src/constants";
import { capToolResult } from "../src/compactor/prompts";

/** True when text holds no lone surrogate halves. */
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

const store: ZoomStore = {
  getMessage: () => "user: original\nwhole text",
  getNodeChildren: () => ["left", "right"],
};

describe("zoom", () => {
  test("pages are bounded, surrogate-safe, contiguous and losslessly reconstructable", () => {
    for (const msg of ["a".repeat(CAP - 4), "a".repeat(CAP - 3),
      "a".repeat(CAP - 101) + "😀" + "中\n😀".repeat(20000)]) {
      const source: ZoomStore = { ...store, getMessage: () => msg };
      const first = zoom(source, 0, 1, 1);
      expect(first.length).toBeLessThanOrEqual(CAP);
      expect(capToolResult(first)).toBe(first);
      if (!first.startsWith("0+0|page ")) {
        expect(first).toBe(`0+0|${msg}`);
        continue;
      }
      const count = Number(first.match(/page 1\/(\d+)/)![1]);
      let restored = "";
      for (let page = 1; page <= count; page++) {
        const result = zoom(source, 0, 1, 1, page);
        expect(result.length).toBeLessThanOrEqual(CAP);
        expect(capToolResult(result)).toBe(result);
        const [header, ...body] = result.split("\n");
        const offsets = header!.match(/chars (\d+):(\d+)$/)!;
        expect(Number(offsets[1])).toBe(restored.length);
        const payload = body.join("\n");
        expect(wellFormed(payload)).toBe(true);
        restored += payload;
        expect(Number(offsets[2])).toBe(restored.length);
      }
      expect(restored).toBe(msg);
      expect(zoom(source, 0, 1, 1, count + 1)).toStartWith("No page:");
    }
    expect(zoom(store, 8, 1, 16, 1)).toBe(zoom(store, 8, 1, 16));
    expect(zoom(store, 8, 1, 16, 2)).toStartWith("No page:");
  });

  test.each([0, -1, 1.5, NaN, Infinity, 2 ** 53, "1", null, true])("rejects invalid page %s before reading", (page) => {
    const unread: ZoomStore = {
      getMessage: () => { throw new Error("must not read"); },
      getNodeChildren: () => { throw new Error("must not read"); },
    };
    expect(zoom(unread, 0, 1, 1, page)).toStartWith("Invalid page:");
    expect(zoom(unread, 0, 2, 2, 1)).toStartWith("Invalid page:");
  });
  test("names the two children by their actual ranges", () => {
    expect(zoom(store, 8, 8, 16)).toBe("8+4|left\n12+4|right");
  });

  test("reads a whole original message at its leaf+0 address", () => {
    expect(zoom(store, 8, 1, 16)).toBe("8+0|user: original\nwhole text");
  });

  test("allows safe power-of-two ranges wider than 32 bits", () => {
    expect(zoom(store, 0, 2 ** 40, 2 ** 40)).toBe("0+549755813888|left\n549755813888+549755813888|right");
  });

  test("missing messages and nodes name the literal requested range", () => {
    const missing: ZoomStore = { getMessage: () => null, getNodeChildren: () => null };
    expect(zoom(missing, 8, 1, 16)).toBe("No line 8+1.");
    expect(zoom(missing, 8, 8, 16)).toBe("No line 8+8.");
  });

  test.each([
    [-1, 1, 16], [1, 2, 16], [0, 3, 16], [8, 8, 15],
    [0.5, 1, 16], [0, 1.5, 16], [0, 0, 16], [0, -2, 16],
    [NaN, 1, 16], [Infinity, 1, 16], [0, Infinity, 16],
    [0, 1, Infinity], [0, 1, 1.5], [0, 1, -1],
    [0, 2 ** 32 + 1, Number.MAX_SAFE_INTEGER],
    [0, 2 ** 52 - 1, Number.MAX_SAFE_INTEGER],
    [Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER],
    [2 ** 53, 1, 2 ** 53],
  ])("rejects invalid address %s+%s within T=%s without reading", (id, n, T) => {
    let read = false;
    const unread: ZoomStore = {
      getMessage: () => { read = true; return "unexpected"; },
      getNodeChildren: () => { read = true; return ["unexpected", "unexpected"]; },
    };
    expect(zoom(unread, id, n, T)).toBe(`No line ${id}+${n}.`);
    expect(read).toBe(false);
  });
});

describe("date", () => {
  test("renders the stored timestamp in local time", () => {
    const iso = new Date(2026, 9, 7, 14, 21, 7).toISOString();
    expect(dateOf(iso)).toBe("2026-10-07 14:21:07");
    expect(lookup(() => iso, 8)).toBe("2026-10-07 14:21:07");
    expect(dateOf("invalid")).toBe("invalid date");
    expect(lookup(() => null, 8)).toBe("No line 8.");
  });

  test.each([-1, 1.5, NaN, Infinity, 2 ** 53])("rejects invalid ID %s before reading", (id) => {
    let read = false;
    expect(lookup(() => { read = true; return "2026-10-06T12:00:00Z"; }, id)).toBe(`No line ${id}.`);
    expect(read).toBe(false);
  });
});

test("canonical helpers keep node keys separate from literal range addresses", () => {
  expect(nodeKey(3, 2)).toBe("3:2");
  expect(formatAddress(8, 4)).toBe("8+4");
});
