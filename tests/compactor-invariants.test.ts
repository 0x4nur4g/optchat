import { describe, expect, test } from "bun:test";
import {
  COMPACT_SYSTEM,
  SCALE_LINE,
  buildCompressStep,
  buildMergeStep,
  capToolResult,
} from "../src/compactor/prompts";
import { pumpOnce } from "../src/compactor/pump";
import { cutAtBytes, shortestUnder } from "../src/compactor/size";
import { CAP, NODE, byteLen } from "../src/constants";

const ID_MARK = /\d+\+\d+\|/;

describe("AGENTS.md rule 5: compactor input adds no node IDs", () => {
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
  test("merge steps flatten carriage returns without dropping any source text", () => {
    expect(buildMergeStep("user: first\rsecond", "echo: third\r\nfourth").endsWith("user: first second\necho: third fourth")).toBe(true);
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
      busy,
      reported,
      adapter: {
        openCompaction(context, step) {
          seen.push({ context, step });
          return { reply: async () => "a short single line" };
        },
      },
      message: () => ({ kind: "user", text: "hello world".repeat(100) }),
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

describe("AGENTS.md rule 5: model compactor output is one line only", () => {
  test("multi-line model reply is saved as a single line", async () => {
    const busy = new Set<string>();
    const reported = new Set<string>();
    const saved: string[] = [];
    await pumpOnce({
      T: 1,
      view: [{ l: 0, i: 0, id: 0, n: 1 }],
      isBuilt: () => false,
      busy,
      reported,
      adapter: {
        openCompaction() {
          return { reply: async () => "first line\nsecond line\nthird line" };
        },
      },
      message: () => ({ kind: "user", text: "hello".repeat(200) }),
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

describe("compactor Unicode and size limits", () => {
  test("scale line is exactly 512 UTF-8 bytes", () => {
    expect(byteLen(SCALE_LINE)).toBe(512);
  });

  test("byte cuts preserve a genuine complete replacement character", () => {
    expect(cutAtBytes("A\uFFFDB", 4)).toBe("A\uFFFD");
    expect(cutAtBytes("A\uFFFDB", 3)).toBe("A");
  });

  test("byte cuts never split emoji or CJK", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((limit) => cutAtBytes("😀漢Z", limit))).toEqual([
      "", "", "", "", "😀", "😀", "😀", "😀漢", "😀漢Z",
    ]);
    expect(cutAtBytes("😀漢Z", -1)).toBe("");
  });

  test("shortest nonempty candidate wins by bytes even when all exceed the target", () => {
    expect(shortestUnder(["", "😀", "abc"], 2)).toBe("abc");
    expect(shortestUnder(["ä", "ab", "long"], 512)).toBe("ä");
    expect(shortestUnder(["", ""], 512)).toBe("");
    expect(shortestUnder([], 512)).toBe("");
  });

  test("tool caps return one string with literal head, cut count, and tail", () => {
    const capped = capToolResult("HEAD" + "a".repeat(39992) + "TAIL");
    expect(typeof capped).toBe("string");
    expect(capped).toBe("HEAD" + "a".repeat(14980) + "\n[... 10032 characters cut ...]\n" + "a".repeat(14980) + "TAIL");
    expect(capped.length).toBe(CAP);
  });

  test("character caps preserve emoji boundaries and count the actual removed units", () => {
    const capped = capToolResult("H" + "😀".repeat(20000) + "T");
    expect(typeof capped).toBe("string");
    expect(capped.startsWith("H😀")).toBe(true);
    expect(capped.endsWith("😀T")).toBe(true);
    expect(capped).toContain("\n[... 10036 characters cut ...]\n");
    expect(capped.length).toBe(29998);
    expect(Buffer.from(capped, "utf8").toString("utf8")).toBe(capped);
  });

  test("short CJK or emoji tool results stay whole despite exceeding CAP bytes", () => {
    const cjk = "漢".repeat(20000);
    const emoji = "😀".repeat(10000);
    expect(capToolResult(cjk)).toBe(cjk);
    expect(capToolResult(emoji)).toBe(emoji);
    expect(capToolResult("a".repeat(CAP)).length).toBe(CAP);
    expect(capToolResult("")).toBe("");
  });

  test("capped CJK tool results use a character limit rather than a byte limit", () => {
    const capped = capToolResult("漢".repeat(40000));
    expect(capped).toBe("漢".repeat(14984) + "\n[... 10032 characters cut ...]\n" + "漢".repeat(14984));
    expect(capped.length).toBe(30000);
    expect(byteLen(capped)).toBe(89936);
  });
});
