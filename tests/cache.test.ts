import { describe, expect, test } from "bun:test";
import { splitViewForCache } from "../src/cache/marks";

function view(n: number): string {
  return `<chat>\n${Array.from({ length: n }, (_, i) => `${i}+1|😀é界𐐀`).join("\n")}${n ? "\n" : ""}</chat>`;
}

describe("cache view pieces", () => {
  for (const n of [0, 1, 3, 4, 5, 7, 8, 9, 12]) {
    test(`${n} summary lines keep four-line blocks and an end mark`, () => {
      const rendered = view(n);
      const split = splitViewForCache(rendered, "");
      expect(split.pieces.join("")).toBe(rendered);
      expect(split.pieces.every(Boolean)).toBe(true);
      const full = Math.floor(n / 4);
      expect(split.pieces.length).toBe(full + 1);
      let offset = 0;
      const ends = split.pieces.map((piece) => offset += piece.length);
      expect(split.marks).toEqual(full ? [ends[full - 1], rendered.length] : [rendered.length]);
      for (let i = 0; i < full; i++) {
        const rows = split.pieces[i]!.split("\n").filter((line) => line && line !== "<chat>");
        expect(rows.length).toBe(4);
      }
      for (const piece of split.pieces) {
        expect(new TextDecoder().decode(new TextEncoder().encode(piece))).toBe(piece);
      }
    });
  }

  test("unframed lines preserve delimiters, final line and long Unicode text", () => {
    const block = "😀".repeat(60_000) + "\né\n界\n𐐀\n";
    const tail = "last"; // the request tail: after the view, so the end mark follows it
    expect(splitViewForCache(block, tail)).toEqual({ pieces: [block], marks: [block.length, block.length + tail.length] });
    expect(splitViewForCache(block.slice(0, -1), "")).toEqual({ pieces: [block.slice(0, -1)], marks: [block.length - 1] });
  });

  test("empty text has no content to mark and a single line is never cut", () => {
    expect(splitViewForCache("", "")).toEqual({ pieces: [""], marks: [] });
    const line = "界".repeat(110_000);
    expect(splitViewForCache(line, "")).toEqual({ pieces: [line], marks: [line.length] });
  });

  test("growing a framed view retains prior whole blocks byte for byte", () => {
    expect(splitViewForCache(view(9), "").pieces.slice(0, 2)).toEqual(splitViewForCache(view(8), "").pieces.slice(0, 2));
  });
});
