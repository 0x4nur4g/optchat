import { describe, expect, test } from "bun:test";
import {
  COMPACT_SYSTEM,
  SCALE_LINE,
  buildCompressStep,
  buildMergeStep,
} from "../src/compactor/prompts";
import { pumpOnce } from "../src/compactor/pump";
import { NODE, byteLen } from "../src/constants";

const ID_MARK = /\d+\+\d+\|/;

describe("AGENTS.md rule 5: compactor input has no IDs", () => {
  test("SCALE_LINE carries no id+n marker", () => {
    expect(SCALE_LINE).not.toMatch(ID_MARK);
  });
  test("COMPACT_SYSTEM carries no id+n marker", () => {
    expect(COMPACT_SYSTEM).not.toMatch(ID_MARK);
  });
  test("buildCompressStep adds no IDs", () => {
    const step = buildCompressStep("user", "fix the merge order");
    expect(step).not.toMatch(ID_MARK);
    expect(step).toContain("user: fix the merge order");
  });
  test("buildMergeStep flattens newlines and adds no IDs", () => {
    const step = buildMergeStep("first line\nsecond line", "plain child");
    expect(step).not.toMatch(ID_MARK);
    expect(step).toContain("first line second line");
    expect(step).not.toContain("first line\nsecond line");
  });
  test("pump sends context and step without ID markers", async () => {
    const seen: { context: string[]; step: string }[] = [];
    const busy = new Set<string>();
    const reported = new Set<string>();
    const saved: string[] = [];
    await pumpOnce({
      T: 1,
      view: [{ l: 0, i: 0, id: 0, n: 1 }],
      isBuilt: () => false,
      startOf: (p) => p.id,
      busy,
      reported,
      adapter: {
        async compress(context, step) {
          seen.push({ context, step });
          return "a short single line";
        },
      },
      message: () => ({ kind: "user", text: "hello world" }),
      children: () => ["a", "b"],
      context: () => ["plain context line, no marker"],
      save: async (_l, _i, text) => {
        saved.push(text);
      },
      report: () => {},
      sleep: async () => {},
    });
    expect(seen.length).toBe(1);
    expect(seen[0]!.context.join("\n")).not.toMatch(ID_MARK);
    expect(seen[0]!.step).not.toMatch(ID_MARK);
  });
});

describe("AGENTS.md rule 5: compactor output is one line only", () => {
  test("multi-line model reply is saved as a single line", async () => {
    const busy = new Set<string>();
    const reported = new Set<string>();
    const saved: string[] = [];
    await pumpOnce({
      T: 1,
      view: [{ l: 0, i: 0, id: 0, n: 1 }],
      isBuilt: () => false,
      startOf: (p) => p.id,
      busy,
      reported,
      adapter: {
        async compress() {
          return "first line\nsecond line\nthird line";
        },
      },
      message: () => ({ kind: "user", text: "hello" }),
      children: () => ["a", "b"],
      context: () => [],
      save: async (_l, _i, text) => {
        saved.push(text);
      },
      report: () => {},
      sleep: async () => {},
    });
    expect(saved.length).toBe(1);
    expect(saved[0]).not.toContain("\n");
    expect(saved[0]).not.toContain("\r");
    expect(byteLen(saved[0]!)).toBeLessThanOrEqual(NODE);
  });
});
