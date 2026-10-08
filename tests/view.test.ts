import { describe, expect, test } from "bun:test";
import { appendAndFit, fit, foldAll, initialView, type Part } from "../src/view/fold";
import { renderBefore, renderView } from "../src/view/render";

describe("incremental view fitting", () => {
  test("late parents never split existing 2+2 parts into leaves", () => {
    const view: Part[] = [
      { l: 1, i: 0, id: 0, n: 2 },
      { l: 1, i: 1, id: 2, n: 2 },
    ];
    expect(fit(view, 4, () => 100, () => true)).toEqual(view);
    expect(view).toEqual([
      { l: 1, i: 0, id: 0, n: 2 },
      { l: 1, i: 1, id: 2, n: 2 },
    ]);
  });

  test("most-due siblings merge before an older but coarser pair", () => {
    const view: Part[] = [
      { l: 1, i: 0, id: 0, n: 2 },
      { l: 1, i: 1, id: 2, n: 2 },
      { l: 0, i: 4, id: 4, n: 1 },
      { l: 0, i: 5, id: 5, n: 1 },
      { l: 0, i: 6, id: 6, n: 1 },
      { l: 0, i: 7, id: 7, n: 1 },
      { l: 0, i: 8, id: 8, n: 1 },
      { l: 0, i: 9, id: 9, n: 1 },
      { l: 0, i: 10, id: 10, n: 1 },
      { l: 0, i: 11, id: 11, n: 1 },
    ];
    // At T=12, due(0+4)=12/8=1.5, due(4+2)=8/4=2.
    // One replacement brings 130000 bytes down to 99000 bytes.
    const result = fit(view, 12, (l) => l === 0 ? 16000 : l === 1 ? 1000 : 500, () => true);
    expect(result).toEqual([
      { l: 1, i: 0, id: 0, n: 2 },
      { l: 1, i: 1, id: 2, n: 2 },
      { l: 1, i: 2, id: 4, n: 2 },
      { l: 0, i: 6, id: 6, n: 1 },
      { l: 0, i: 7, id: 7, n: 1 },
      { l: 0, i: 8, id: 8, n: 1 },
      { l: 0, i: 9, id: 9, n: 1 },
      { l: 0, i: 10, id: 10, n: 1 },
      { l: 0, i: 11, id: 11, n: 1 },
    ]);
  });

  test("overbudget view waits for the needed parent instead of splitting or cutting", () => {
    const view: Part[] = [
      { l: 0, i: 0, id: 0, n: 1 },
      { l: 0, i: 1, id: 1, n: 1 },
    ];
    const waiting = fit(view, 2, (l) => l === 0 ? 65000 : 512, () => false);
    expect(waiting).toEqual(view);
    expect(fit(waiting, 2, (l) => l === 0 ? 65000 : 512, () => true)).toEqual([
      { l: 1, i: 0, id: 0, n: 2 },
    ]);
  });

  test("unbuilt oldest parent is skipped for the next built sibling pair", () => {
    const view: Part[] = [
      { l: 0, i: 0, id: 0, n: 1 },
      { l: 0, i: 1, id: 1, n: 1 },
      { l: 0, i: 2, id: 2, n: 1 },
      { l: 0, i: 3, id: 3, n: 1 },
    ];
    expect(fit(view, 4, (l) => l === 0 ? 33000 : 512, (l, i) => l === 1 && i === 1)).toEqual([
      { l: 0, i: 0, id: 0, n: 1 },
      { l: 0, i: 1, id: 1, n: 1 },
      { l: 1, i: 1, id: 2, n: 2 },
    ]);
  });

  test("append adds only the newest leaf after the existing coarser prefix", () => {
    const view: Part[] = [{ l: 2, i: 0, id: 0, n: 4 }];
    expect(appendAndFit(view, 5, () => 512, () => true)).toEqual([
      { l: 2, i: 0, id: 0, n: 4 },
      { l: 0, i: 4, id: 4, n: 1 },
    ]);
    expect(view).toEqual([{ l: 2, i: 0, id: 0, n: 4 }]);
    expect(initialView()).toEqual([]);
    expect(appendAndFit([], 0, () => 512, () => true)).toEqual([]);
  });

  test("startup replay tiles 512 messages and incremental refits only coarsen", () => {
    let view = foldAll(512, () => 512, () => true);
    expect(view.reduce((total, part) => total + part.n, 0)).toBe(512);
    expect(view.length).toBeLessThanOrEqual(250);
    for (let T = 513; T <= 520; T++) {
      const previous = view;
      view = appendAndFit(view, T, () => 512, () => true);
      let end = 0;
      for (const part of view) {
        expect(part.id).toBe(end);
        expect(part.i * part.n).toBe(part.id);
        expect(part.n).toBe(2 ** part.l);
        end += part.n;
      }
      expect(end).toBe(T);
      for (const old of previous) {
        const covering = view.find((part) => part.id <= old.id && part.id + part.n >= old.id + old.n);
        expect(covering).toBeDefined();
      }
    }
  });
});

describe("view rendering", () => {
  const parts: Part[] = [
    { l: 2, i: 0, id: 0, n: 4 },
    { l: 1, i: 2, id: 4, n: 2 },
    { l: 0, i: 6, id: 6, n: 1 },
  ];

  test("view addresses and placeholders render without cutting summary text", () => {
    const text = (part: Part) => part.id === 0 ? "user: first\nsecond" : part.id === 4 ? "echo: done\r\nnext" : undefined;
    expect(renderView(parts, text)).toBe("<chat>\n0+4|user: first second\n4+2|echo: done next\n6+1|(not summarized yet: zoom it)\n</chat>");
    expect(renderView([], text)).toBe("<chat>\n</chat>");
  });

  test("prefix rendering never exposes a partial 4+2 summary", () => {
    expect(renderBefore(parts, 5, () => "whole summary")).toBe("0+4|whole summary");
    expect(renderBefore(parts, 6, () => "whole summary")).toBe("0+4|whole summary\n4+2|whole summary");
    expect(renderBefore(parts, 3, () => "whole summary")).toBe("");
  });

  test("bare carriage returns flatten in summaries but stored source stays unchanged", () => {
    const source = "user: first\rsecond";
    expect(renderView(parts.slice(0, 1), () => source)).toBe("<chat>\n0+4|user: first second\n</chat>");
    expect(source).toBe("user: first\rsecond");
  });
});
