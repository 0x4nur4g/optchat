import { describe, expect, test } from "bun:test";
import { zoom, type ZoomStore } from "../src/tools/zoom";
import { dateOf, lookup } from "../src/tools/date";
import { formatAddress, nodeKey } from "../src/tree/address";

const store: ZoomStore = {
  getMessage: () => "user: original\nwhole text",
  getNodeChildren: () => ["left", "right"],
};

describe("zoom", () => {
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
