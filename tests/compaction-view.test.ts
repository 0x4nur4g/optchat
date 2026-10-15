import { expect, test } from "bun:test";
import { byteLen } from "../src/constants";
import { CompactionView } from "../src/view/compaction";
import { fit, type Part } from "../src/view/fold";

const leaves = (n: number): Part[] => Array.from({ length: n }, (_, i) => ({ l: 0, i, id: i, n: 1 }));
const textOf = (p: Part) => `${p.l}:${p.i}`.padEnd(500, "é");
const sizes = (l: number, i: number) => byteLen(textOf({ l, i, id: i * 2 ** l, n: 2 ** l }));
const built = () => true;
const lines = (view: CompactionView) => view.contextOf(0, Infinity, textOf);
const bytes = (view: CompactionView) => lines(view).reduce((n, text) => n + byteLen(text), 0);

// Exactly 1000 stored UTF-8 bytes, but 500 UTF-16 characters, per node.
const unicodeText = (p: Part) => "é".repeat(500 - `${p.l}:${p.i}`.length) + `${p.l}:${p.i}`.repeat(2);
const unicodeSizes = (l: number, i: number) => byteLen(unicodeText({ l, i, id: i * 2 ** l, n: 2 ** l }));

test("initial fit uses stored UTF-8 bytes and the exact 16000 boundary", () => {
  const view = new CompactionView();
  view.update(leaves(16), 16, unicodeSizes, built);
  expect(view.contextOf(0, Infinity, unicodeText)).toHaveLength(16);
  expect(unicodeSizes(0, 0)).toBe(1000);
  const fitted = new CompactionView();
  const master = leaves(17);
  fitted.update(master, 17, unicodeSizes, built);
  expect(fitted.contextOf(0, Infinity, unicodeText)).toEqual(fit(master, 17, unicodeSizes, built, 16000).map(unicodeText));
  expect(fitted.contextOf(0, Infinity, unicodeText)).toHaveLength(16);
  expect(master).toEqual(leaves(17));
});

test("append preserves the exact prefix through 32000, then fits to 16000", () => {
  const view = new CompactionView();
  view.update(leaves(16), 16, unicodeSizes, built);
  for (let T = 17; T <= 32; T++) {
    const previous = view.contextOf(0, Infinity, unicodeText);
    view.update(leaves(T), T, unicodeSizes, built);
    const next = view.contextOf(0, Infinity, unicodeText);
    expect(next.slice(0, previous.length)).toEqual(previous);
    expect(next).toHaveLength(T);
  }
  expect(view.contextOf(0, Infinity, unicodeText).reduce((n, s) => n + byteLen(s), 0)).toBe(32000);
  view.update(leaves(33), 33, unicodeSizes, built);
  expect(view.contextOf(0, Infinity, unicodeText)).toEqual(fit(leaves(33), 33, unicodeSizes, built, 16000).map(unicodeText));
  expect(view.contextOf(0, Infinity, unicodeText)).toHaveLength(16);
});

test("master merges rederive to low budget without splitting master parts", () => {
  const view = new CompactionView();
  view.update(leaves(16), 16, unicodeSizes, built);
  view.update(leaves(24), 24, unicodeSizes, built);
  const master = [{ l: 3, i: 0, id: 0, n: 8 }, ...leaves(24).slice(8)];
  view.update(master, 24, unicodeSizes, built);
  expect(view.contextOf(0, Infinity, unicodeText)).toEqual(fit(master, 24, unicodeSizes, built, 16000).map(unicodeText));
  expect(view.contextOf(0, 7, unicodeText)).toEqual([]);
  expect(view.contextOf(0, 8, unicodeText)).toEqual([unicodeText(master[0]!)]);
  expect(master[0]).toEqual({ l: 3, i: 0, id: 0, n: 8 });
});

test("stop at the first unbuilt master line, append only after the hole fills", () => {
  const view = new CompactionView();
  const master = leaves(5);
  view.update(master, 5, sizes, (_l, i) => i !== 1);
  expect(lines(view)).toEqual([textOf(master[0]!)]);
  expect(view.contextOf(2, 0, textOf)).toEqual([textOf(master[0]!)]);
  expect(view.contextOf(0, 0, textOf)).toEqual([]);
  view.update(master, 5, sizes, built);
  expect(lines(view)).toEqual(master.map(textOf));
  expect(view.contextOf(0, 3, textOf)).toEqual(master.slice(0, 3).map(textOf));
  expect(view.contextOf(1, 0, textOf)).toEqual(master.slice(0, 2).map(textOf));
  expect(view.contextOf(2, 0, (p) => p.i === 1 ? undefined : "line\r\nfull\rtext\nend")).toEqual(["line full text end"]);
});

test("unavailable parents wait without cutting text or mutating the master", () => {
  const view = new CompactionView();
  const master = leaves(40);
  view.update(master, 40, unicodeSizes, (l) => l === 0);
  expect(view.contextOf(0, Infinity, unicodeText)).toEqual(master.map(unicodeText));
  view.update(master, 40, unicodeSizes, built);
  expect(view.contextOf(0, Infinity, unicodeText)).toHaveLength(16);
  expect(master).toEqual(leaves(40));
});
