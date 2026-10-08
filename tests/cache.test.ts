import { describe, expect, test } from "bun:test";
import { splitViewForCache } from "../src/cache/marks";

describe("cache view pieces", () => {
  test("character marks keep complete Unicode lines, not byte-sized pieces", () => {
    const first = "😀".repeat(24_999) + "\n";
    const second = "é".repeat(29_999) + "\n";
    const third = "界".repeat(19_999) + "\n";
    const last = "𐐀".repeat(500) + "fin";
    const rendered = first + second + third + last;
    const split = splitViewForCache(rendered);
    expect(split.marks).toEqual([49_999, 79_999, 99_999]);
    expect(split.pieces).toEqual([first, second, third, last]);
    expect(split.pieces.join("")).toBe(rendered);
    for (const piece of split.pieces) {
      expect(new TextDecoder().decode(new TextEncoder().encode(piece))).toBe(piece);
    }
  });

  test("marks inside surrogate pairs reuse the earlier complete line only once", () => {
    const tail = "😀".repeat(60_000);
    expect(splitViewForCache("x\n" + tail)).toEqual({ pieces: ["x\n", tail], marks: [2] });
  });

  test("long unbroken lines and empty views remain whole", () => {
    const line = "界".repeat(110_000);
    expect(splitViewForCache(line)).toEqual({ pieces: [line], marks: [] });
    expect(splitViewForCache("")).toEqual({ pieces: [""], marks: [] });
  });

  test("marks at the end do not add empty pieces", () => {
    const text = "x\n" + "a".repeat(49_998);
    expect(splitViewForCache(text)).toEqual({ pieces: [text], marks: [] });
  });
});
