import { describe, expect, test } from "bun:test";
import { candidates, initReady, nodeKey, pumpOnce, type PumpOptions } from "../src/compactor/pump";
import { NODE, byteLen } from "../src/constants";

function harness(messages: { kind: string; text: string }[]) {
  const stored = new Map<string, string>();
  const reports: unknown[] = [];
  const opened: { context: string[]; step: string; system: string; signal?: AbortSignal }[] = [];
  const replies = ["user: summary"];
  const feedback: (string | undefined)[] = [];
  const view = messages.map((_, i) => ({ l: 0, i, id: i, n: 1 }));
  const isBuilt = (l: number, i: number) => stored.has(nodeKey(l, i));
  const opts: PumpOptions = {
    ready: initReady(view, isBuilt, messages.length),
    isBuilt,
    busy: new Set(),
    reported: new Set(),
    adapter: {
      openCompaction(context, step, system, signal) {
        opened.push({ context, step, system, signal });
        let attempt = 0;
        return { reply: async (text) => {
          feedback.push(text);
          return replies[attempt++] ?? replies[replies.length - 1]!;
        } };
      },
    },
    message: (i) => messages[i]!,
    children: (l, i) => [stored.get(nodeKey(l - 1, 2 * i))!, stored.get(nodeKey(l - 1, 2 * i + 1))!],
    // Lines up to the node's end, cut at the first unbuilt line (no hole is skipped).
    context: (l, i) => {
      const end = l === 0 ? i : (i + 1) * 2 ** l;
      const context: string[] = [];
      for (const part of view) {
        if (part.id + part.n > end) break;
        const text = stored.get(nodeKey(part.l, part.i));
        if (text === undefined) break;
        context.push(text);
      }
      return context;
    },
    save: async (l, i, text) => { stored.set(nodeKey(l, i), text); },
    report: (_l, _i, err) => { reports.push(err); },
    sleep: async () => {},
  };
  /** Re-seed the ready queues, as a restart would after nodes were persisted. */
  const reinit = () => { opts.ready = initReady(view, isBuilt, messages.length); };
  return { opts, reinit, stored, reports, opened, replies, feedback };
}

describe("free nodes", () => {
  test("short leaves retain kind and whole source with zero model calls", async () => {
    const h = harness([{ kind: "user", text: "short\n原文 😀" }]);
    expect(await pumpOnce(h.opts)).toBe(1);
    expect(h.stored.get("0:0")).toBe("user: short\n原文 😀");
    expect(h.opened).toEqual([]);
    expect(h.reports).toEqual([]);
    expect(h.opts.busy.size).toBe(0);
  });

  test("short parents retain both complete children and original newlines", async () => {
    const h = harness([{ kind: "user", text: "one\nline" }, { kind: "talk", text: "two" }]);
    await pumpOnce(h.opts);
    await pumpOnce(h.opts);
    await pumpOnce(h.opts);
    expect(h.stored.get("1:0")).toBe("user: one\nline\ntalk: two");
    expect(h.opened).toEqual([]);
    expect(h.reports).toEqual([]);
  });

  test("a 512-byte leaf is free but a 513-byte leaf needs compression", async () => {
    const h = harness([{ kind: "user", text: "x".repeat(506) }, { kind: "user", text: "x".repeat(507) }]);
    await pumpOnce(h.opts);
    expect(byteLen(h.stored.get("0:0")!)).toBe(NODE);
    expect(h.opened).toEqual([]);
    await pumpOnce(h.opts);
    expect(h.opened.length).toBe(1);
    expect(h.stored.get("0:1")).toBe("user: summary");
  });

  test("a parent includes its joining newline in the 512-byte free-node limit", async () => {
    const h = harness([{ kind: "note", text: "" }, { kind: "note", text: "" }]);
    h.stored.set("0:0", "a".repeat(255));
    h.stored.set("0:1", "b".repeat(256));
    h.reinit();
    await pumpOnce(h.opts);
    expect(h.stored.get("1:0")).toBe("a".repeat(255) + "\n" + "b".repeat(256));
    expect(h.opened).toEqual([]);
  });
});

describe("compaction sessions", () => {
  test("five replies share one session and retain the shortest over-target candidate", async () => {
    const source = "原".repeat(600) + "\nkeep this final line 😀";
    const h = harness([{ kind: "user", text: source }]);
    h.replies.splice(0, 1, "  " + "a".repeat(534) + "\n", "b".repeat(520), "c".repeat(650), "d".repeat(515), "e".repeat(600));
    await pumpOnce(h.opts);
    expect(h.opened.length).toBe(1);
    expect(h.opened[0]!.step.endsWith("<input>\nuser: " + source + "\n</input>")).toBe(true);
    expect(h.feedback).toEqual([
      undefined,
      "That line is 534 bytes; limit 512. It must end where cut here: " + "a".repeat(512) + "| <- LIMIT",
      "That line is 520 bytes; limit 512. It must end where cut here: " + "b".repeat(512) + "| <- LIMIT",
      "That line is 650 bytes; limit 512. It must end where cut here: " + "c".repeat(512) + "| <- LIMIT",
      "That line is 515 bytes; limit 512. It must end where cut here: " + "d".repeat(512) + "| <- LIMIT",
    ]);
    expect(h.stored.get("0:0")).toBe("d".repeat(515));
    expect(h.reports).toEqual([]);
  });

  test("model context flattens free summaries while preserving complete source text", async () => {
    const h = harness([{ kind: "user", text: "first\r\nsecond" }, { kind: "echo", text: "原".repeat(600) + "\nlast" }]);
    await pumpOnce(h.opts);
    await pumpOnce(h.opts);
    expect(h.opened[0]!.context).toEqual(["user: first second"]);
    expect(h.opened[0]!.step.endsWith("<input>\necho: " + "原".repeat(600) + "\nlast\n</input>")).toBe(true);
  });

  test("retries stop as soon as a normalized reply fits the target", async () => {
    const h = harness([{ kind: "user", text: "x".repeat(600) }]);
    h.replies.splice(0, 1, "x".repeat(600), "  user: first\r\nsecond\rthird\n  ", "never used");
    await pumpOnce(h.opts);
    expect(h.opened.length).toBe(1);
    expect(h.feedback.length).toBe(2);
    expect(h.stored.get("0:0")).toBe("user: first second third");
    expect(h.reports).toEqual([]);
  });

  test("an empty retry fails the node instead of keeping an earlier candidate", async () => {
    const h = harness([{ kind: "user", text: "x".repeat(600) }]);
    h.replies.splice(0, 1, "x".repeat(600), " \r\n ");
    await pumpOnce(h.opts);
    expect(h.feedback.length).toBe(2);
    expect(h.stored.size).toBe(0);
    expect(h.reports.length).toBe(1);
    expect(h.reports[0]).toEqual(new Error("compactor returned an empty line"));
  });

  test("source address mentions remain data rather than being stripped", async () => {
    const source = "Read 2184+8 exactly.\n" + "x".repeat(600);
    const h = harness([{ kind: "user", text: "already saw 2184+8" }, { kind: "user", text: source }]);
    await pumpOnce(h.opts);
    await pumpOnce(h.opts);
    expect(h.opened[0]!.context).toEqual(["user: already saw 2184+8"]);
    expect(h.opened[0]!.step.endsWith("<input>\nuser: " + source + "\n</input>")).toBe(true);
  });
});

describe("build order and readiness", () => {
  test("stored children unlock every merge level across view holes in level/age order", () => {
    // Leaves 2..15 and the merges above them (1:2..1:7, 2:2, 2:3) are built;
    // every built subtree is complete. Lines 0 and 1 are the unbuilt hole, so
    // first = 0 and only leaf 0:0 clears the frontier. 1:1, 2:1 and 3:1 have
    // both halves stored, so every merge level is ready across the hole; 4:0
    // still waits for its unbuilt left half 3:0.
    const built = new Set<string>();
    for (let i = 2; i < 16; i++) built.add(nodeKey(0, i));
    for (let i = 2; i < 8; i++) built.add(nodeKey(1, i));
    built.add(nodeKey(2, 2));
    built.add(nodeKey(2, 3));
    const isBuilt = (l: number, i: number) => built.has(nodeKey(l, i));
    expect(candidates(16, isBuilt, new Set(), 0)).toEqual([
      { l: 0, i: 0, end: 0 },
      { l: 1, i: 1, end: 4 },
      { l: 2, i: 1, end: 8 },
      { l: 3, i: 1, end: 16 },
    ]);
    expect(candidates(16, isBuilt, new Set(["0:0", "1:1"]), 0)).toEqual([
      { l: 2, i: 1, end: 8 }, { l: 3, i: 1, end: 16 },
    ]);
  });

  test("missing or merely busy children never unlock a merge and ranges stay within T", () => {
    const built = new Set(["0:2", "0:3", "0:4", "0:5", "1:2"]);
    const isBuilt = (l: number, i: number) => built.has(nodeKey(l, i));
    expect(candidates(5, isBuilt, new Set(["0:0", "0:1", "1:3"]), 0)).toEqual([
      { l: 1, i: 1, end: 4 },
    ]);
    expect(candidates(0, isBuilt, new Set(), 0)).toEqual([]);
    expect(candidates(1, isBuilt, new Set(), 0)).toEqual([{ l: 0, i: 0, end: 0 }]);
    built.delete("0:3");
    expect(candidates(5, isBuilt, new Set(["0:0", "0:3"]), 0)).toEqual([]);
  });

  test("pump merges across an earlier busy hole with only the built context prefix", async () => {
    const h = harness(Array.from({ length: 6 }, () => ({ kind: "user", text: "" })));
    h.stored.set("0:0", "user: prefix\nline");
    h.opts.busy.add("0:1");
    for (let i = 2; i < 6; i++) h.stored.set(nodeKey(0, i), "user: " + "x".repeat(300));
    h.reinit(); // the queues must be seeded from the persisted nodes, as at load
    expect(await pumpOnce(h.opts)).toBe(2);
    expect(h.opened.map((call) => call.context)).toEqual([
      ["user: prefix line"], ["user: prefix line"],
    ]);
    expect(h.stored.get("1:1")).toBe("user: summary");
    expect(h.stored.get("1:2")).toBe("user: summary");
    expect(h.stored.has("0:1")).toBe(false);
    expect(h.stored.has("1:0")).toBe(false);
    expect([...h.opts.busy]).toEqual(["0:1"]);
    expect(h.reports).toEqual([]);
  });

  test("hole-crossing merges reserve remaining JOBS slots before overlapping pumps", async () => {
    const h = harness(Array.from({ length: 22 }, () => ({ kind: "user", text: "" })));
    h.opts.busy.add("0:0");
    h.opts.busy.add("0:1");
    for (let i = 2; i < 22; i++) h.stored.set(nodeKey(0, i), "x".repeat(300));
    h.reinit(); // the queues must be seeded from the persisted nodes, as at load
    const replies: ((text: string) => void)[] = [];
    h.opts.adapter = { openCompaction() {
      return { reply: () => new Promise<string>((resolve) => { replies.push(resolve); }) };
    } };
    const running = pumpOnce(h.opts);
    expect([...h.opts.busy]).toEqual(["0:0", "0:1", "1:1", "1:2", "1:3", "1:4", "1:5", "1:6"]);
    expect(replies.length).toBe(6);
    expect(await pumpOnce(h.opts)).toBe(0);
    for (const reply of replies) reply("merged");
    expect(await running).toBe(6);
    expect([...h.opts.busy]).toEqual(["0:0", "0:1"]);
    expect(h.reports).toEqual([]);
  });
  test("leaves build sequentially with only complete preceding summary context", async () => {
    const h = harness([
      { kind: "user", text: "first\n" + "a".repeat(600) },
      { kind: "talk", text: "second\n" + "b".repeat(600) },
      { kind: "echo", text: "third\n" + "c".repeat(600) },
    ]);
    expect(await pumpOnce(h.opts)).toBe(1);
    expect([...h.stored.keys()]).toEqual(["0:0"]);
    expect(await pumpOnce(h.opts)).toBe(1);
    expect([...h.stored.keys()]).toEqual(["0:0", "0:1"]);
    expect(await pumpOnce(h.opts)).toBe(2); // newest leaf and the first ready parent
    expect(h.opened.map((call) => call.context)).toEqual([
      [], ["user: summary"], ["user: summary", "user: summary"],
    ]);
    expect(h.stored.get("1:0")).toBe("user: summary\nuser: summary");
    expect(h.reports).toEqual([]);
  });

  test("a merge receives both complete children and context through their end", async () => {
    const h = harness([{ kind: "user", text: "" }, { kind: "echo", text: "" }]);
    const left = "user: " + "原".repeat(100) + "\nleft end";
    const right = "echo: " + "文".repeat(100) + "\r\nright end";
    h.stored.set("0:0", left);
    h.stored.set("0:1", right);
    h.reinit();
    await pumpOnce(h.opts);
    expect(h.opened.length).toBe(1);
    expect(h.opened[0]!.context).toEqual([
      "user: " + "原".repeat(100) + " left end",
      "echo: " + "文".repeat(100) + " right end",
    ]);
    expect(h.opened[0]!.step.endsWith("<input>\nuser: " + "原".repeat(100) + " left end\necho: " + "文".repeat(100) + " right end\n</input>")).toBe(true);
    expect(h.opened[0]!.step).not.toMatch(/\d+\+\d+\|/);
    expect(h.stored.get("1:0")).toBe("user: summary");
    expect(h.reports).toEqual([]);
  });

  test("ready merges never exceed eight running jobs across overlapping pumps", async () => {
    const h = harness(Array.from({ length: 20 }, () => ({ kind: "user", text: "" })));
    for (let i = 0; i < 20; i++) h.stored.set(nodeKey(0, i), "user: " + "x".repeat(500));
    h.reinit();
    const replies: ((text: string) => void)[] = [];
    let started = 0;
    h.opts.adapter = { openCompaction() {
      started++;
      return { reply: () => new Promise<string>((resolve) => { replies.push(resolve); }) };
    } };
    const busyAfterCleanup: number[] = [];
    h.opts.onSettled = () => { busyAfterCleanup.push(h.opts.busy.size); };
    const running = pumpOnce(h.opts);
    expect(started).toBe(8);
    expect(h.opts.busy.size).toBe(8);
    expect(await pumpOnce(h.opts)).toBe(0);
    expect(started).toBe(8);
    for (const reply of replies) reply("user: merged");
    expect(await running).toBe(8);
    expect(h.opts.busy.size).toBe(0);
    expect(busyAfterCleanup).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    expect(h.reports).toEqual([]);
  });

  test("512 short messages build all 1023 binary nodes without losing readiness", async () => {
    const h = harness(Array.from({ length: 512 }, () => ({ kind: "note", text: "" })));
    let total = 0;
    let settled = 0;
    h.opts.onSettled = () => { settled++; };
    for (let pass = 0; pass < 1024; pass++) {
      const count = await pumpOnce(h.opts);
      if (count === 0) break;
      expect(count).toBeLessThanOrEqual(8);
      total += count;
    }
    expect(total).toBe(1023);
    expect(h.stored.size).toBe(1023);
    expect(h.stored.get("9:0")).toBe("user: summary\nuser: summary\nuser: summary\nuser: summary");
    expect(h.opened.length).toBe(4);
    expect(settled).toBe(1023);
    expect(h.opts.busy.size).toBe(0);
    expect(h.reports).toEqual([]);
  });
});

describe("compactor cancellation", () => {
  test("already aborted pumps start no work", async () => {
    const h = harness([{ kind: "user", text: "short" }]);
    h.opts.signal = AbortSignal.abort();
    expect(await pumpOnce(h.opts)).toBe(0);
    expect(h.stored.size).toBe(0);
    expect(h.opts.busy.size).toBe(0);
    expect(h.reports).toEqual([]);
  });

  test("cancellation after a reply stops saving and wakes the caller after cleanup", async () => {
    const h = harness([{ kind: "user", text: "x".repeat(600) }]);
    const controller = new AbortController();
    h.opts.signal = controller.signal;
    let settled = 0;
    let received: AbortSignal | undefined;
    h.opts.onSettled = () => { settled++; };
    h.opts.adapter = { openCompaction(_context, _step, _system, signal) {
      received = signal;
      return { async reply() {
        controller.abort();
        return "user: summary";
      } };
    } };
    await pumpOnce(h.opts);
    expect(received).toBe(controller.signal);
    expect(h.stored.size).toBe(0);
    expect(h.opts.busy.size).toBe(0);
    expect(settled).toBe(1);
    expect(h.reports).toEqual([]);
  });

  test("an aborted model request releases its busy slot without reporting failure", async () => {
    const h = harness([{ kind: "user", text: "x".repeat(600) }]);
    const controller = new AbortController();
    h.opts.signal = controller.signal;
    let entered!: () => void;
    const requested = new Promise<void>((resolve) => { entered = resolve; });
    h.opts.adapter = { openCompaction(_context, _step, _system, signal) {
      return { reply: () => new Promise<string>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        entered();
      }) };
    } };
    let settled = 0;
    h.opts.onSettled = () => { settled++; };
    const running = pumpOnce(h.opts);
    await requested;
    expect(h.opts.busy.size).toBe(1);
    controller.abort();
    await running;
    expect(h.opts.busy.size).toBe(0);
    expect(settled).toBe(1);
    expect(h.stored.size).toBe(0);
    expect(h.reports).toEqual([]);
  });

  test("cancellation waits for an already started durable save", async () => {
    const h = harness([{ kind: "user", text: "short" }]);
    const controller = new AbortController();
    h.opts.signal = controller.signal;
    let entered!: () => void;
    const saving = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const saved = new Promise<void>((resolve) => { finish = resolve; });
    let settled = 0;
    h.opts.onSettled = () => { settled++; };
    h.opts.save = async (l, i, text) => {
      entered();
      await saved;
      h.stored.set(nodeKey(l, i), text);
    };
    let completed = false;
    const run = pumpOnce(h.opts).then((count) => { completed = true; return count; });
    await saving;
    controller.abort();
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(h.opts.busy.size).toBe(1);
    expect(settled).toBe(0);
    finish();
    await run;
    expect(h.stored.get("0:0")).toBe("user: short");
    expect(h.opts.busy.size).toBe(0);
    expect(settled).toBe(1);
    expect(h.reports).toEqual([]);
  });

  test("cancellation releases a delayed retry without waiting for its clock", async () => {
    const h = harness([{ kind: "user", text: "x".repeat(600) }]);
    h.replies[0] = "";
    const controller = new AbortController();
    h.opts.signal = controller.signal;
    let finish!: () => void;
    const delayed = new Promise<void>((resolve) => { finish = resolve; });
    const delays: number[] = [];
    h.opts.sleep = (ms) => { delays.push(ms); return delayed; };
    let wake!: () => void;
    const released = new Promise<void>((resolve) => { wake = resolve; });
    let settled = 0;
    h.opts.onSettled = () => { settled++; wake(); };
    await pumpOnce(h.opts);
    expect(delays).toEqual([10000]);
    expect(h.opts.busy.size).toBe(1);
    expect(settled).toBe(0);
    controller.abort();
    await released;
    expect(h.opts.busy.size).toBe(0);
    expect(settled).toBe(1);
    expect(h.reports.length).toBe(1);
    finish();
    await delayed;
    await Promise.resolve();
    expect(settled).toBe(1);
    expect(await pumpOnce(h.opts)).toBe(0);
  });

  test("cancellation clears a real retry timer and wakes immediately", async () => {
    const h = harness([{ kind: "user", text: "x".repeat(600) }]);
    h.replies[0] = "";
    delete h.opts.sleep;
    const controller = new AbortController();
    h.opts.signal = controller.signal;
    let wake!: () => void;
    const released = new Promise<void>((resolve) => { wake = resolve; });
    h.opts.onSettled = wake;
    await pumpOnce(h.opts);
    expect(h.opts.busy.size).toBe(1);
    controller.abort();
    await released;
    expect(h.opts.busy.size).toBe(0);
    expect(h.reports.length).toBe(1);
  });

  test("a save failure remains reported even when shutdown began during the save", async () => {
    const h = harness([{ kind: "user", text: "short" }]);
    const controller = new AbortController();
    h.opts.signal = controller.signal;
    const failure = new Error("durable save failed");
    h.opts.save = async () => { controller.abort(); throw failure; };
    let settled = 0;
    h.opts.onSettled = () => { settled++; };
    await pumpOnce(h.opts);
    expect(h.reports).toEqual([failure]);
    expect(h.stored.size).toBe(0);
    expect(h.opts.busy.size).toBe(0);
    expect(settled).toBe(1);
  });
});

describe("failure retries", () => {
  test("every failure holds its busy slot for 10 seconds and only the first is reported", async () => {
    const h = harness([{ kind: "user", text: "x".repeat(600) }]);
    h.replies[0] = "";
    const delays: number[] = [];
    let release!: () => void;
    h.opts.sleep = (ms) => {
      delays.push(ms);
      return new Promise<void>((resolve) => { release = resolve; });
    };
    let wake!: () => void;
    let settled = 0;
    h.opts.onSettled = () => { settled++; wake(); };
    for (let failure = 0; failure < 2; failure++) {
      const released = new Promise<void>((resolve) => { wake = resolve; });
      expect(await pumpOnce(h.opts)).toBe(1);
      expect(h.opts.busy.has("0:0")).toBe(true);
      expect(h.opts.reported.has("0:0")).toBe(true);
      expect(h.reports.length).toBe(1);
      expect(h.stored.size).toBe(0);
      expect(settled).toBe(failure);
      expect(await pumpOnce(h.opts)).toBe(0);
      release();
      await released;
      expect(h.opts.busy.size).toBe(0);
    }
    expect(delays).toEqual([10000, 10000]);
    h.replies[0] = "user: recovered";
    expect(await pumpOnce(h.opts)).toBe(1);
    expect(h.stored.get("0:0")).toBe("user: recovered");
    expect(h.opts.reported.size).toBe(0);
    expect(h.reports.length).toBe(1);
    expect(settled).toBe(3);
  });
});
