import { describe, expect, test } from "bun:test";
import {
  arrive,
  initReady,
  nodeKey,
  pumpOnce,
  queued,
  requeue,
  type IsBuilt,
  type PumpOptions,
  type ReadyQueues,
} from "../src/compactor/pump";

/** Minimal pump wiring over a stored-node map, with message fixtures. */
function stubs(
  ready: ReadyQueues,
  stored: Map<string, string>,
  isBuilt: IsBuilt,
  messages: { kind: string; text: string }[] = [],
) {
  const savedNodes: string[] = [];
  const steps: string[] = [];
  const opts: PumpOptions = {
    ready,
    isBuilt,
    busy: new Set(),
    reported: new Set(),
    failedAt: new Map(),
    adapter: {
      openCompaction(_context, step) {
        steps.push(step);
        return { reply: async () => "user: summary" };
      },
    },
    message: (i) => {
      const m = messages[i];
      if (m === undefined) throw new Error(`missing message ${i}`);
      return { kind: m.kind, text: m.text };
    },
    children: (l, i) => [stored.get(nodeKey(l - 1, 2 * i)) ?? "", stored.get(nodeKey(l - 1, 2 * i + 1)) ?? ""],
    context: () => [],
    save: async (l, i, text) => {
      stored.set(nodeKey(l, i), text);
      savedNodes.push(nodeKey(l, i));
    },
    report: () => {},
  };
  return { opts, savedNodes, steps };
}

describe("ready queues", () => {
  test("a leaf enters the queue on arrival, within the 7-line allowance", async () => {
    const stored = new Map<string, string>();
    const isBuilt = (l: number, i: number) => stored.has(nodeKey(l, i));
    const messages: { kind: string; text: string }[] = [];
    const ready = initReady([], isBuilt, 0); // fresh chat: nothing arrived yet
    const { opts, savedNodes } = stubs(ready, stored, isBuilt, messages);
    expect(await pumpOnce(opts)).toBe(0); // no work, and no scan to find that out
    arrive(ready, 0);
    expect(queued(ready.leaves)).toEqual([0]); // first message: nothing before it
    messages.push({ kind: "user", text: "m0" });
    messages.push({ kind: "user", text: "m1" });
    arrive(ready, 1);
    expect(queued(ready.leaves)).toEqual([0, 1]); // one unbuilt line before it: within the allowance
    expect(await pumpOnce(opts)).toBe(2); // both leaves build together
    expect(savedNodes).toEqual(["0:0", "0:1"]);
    expect(queued(ready.leaves)).toEqual([]); // parked past the last message
    // Both same-pump children announced (1,0); the duplicate is dropped at
    // the next pop, when it is already built.
    expect([...new Set(queued(ready.parents[1]))]).toEqual([0]); // the first merge became ready
    expect(await pumpOnce(opts)).toBe(1);
    expect(savedNodes).toEqual(["0:0", "0:1", "1:0"]);
    expect(opts.busy.size).toBe(0);
  });

  test("a merge enters its queue when its second child is built", async () => {
    // 4 messages; leaves 0-1 are built, so their merge is ready at load; the
    // later leaves enter together within the allowance.
    const stored = new Map<string, string>([["0:0", "a"], ["0:1", "b"]]);
    const isBuilt = (l: number, i: number) => stored.has(nodeKey(l, i));
    const messages = Array.from({ length: 4 }, () => ({ kind: "note", text: "" }));
    const view = [0, 1, 2, 3].map((i) => ({ l: 0, i, id: i, n: 1 }));
    const ready = initReady(view, isBuilt, 4);
    expect(queued(ready.leaves)).toEqual([2, 3]); // both within the leaf window
    expect(queued(ready.parents[1])).toEqual([0]); // leaves 0-1 finished before the load
    const { opts, savedNodes } = stubs(ready, stored, isBuilt, messages);
    expect(await pumpOnce(opts)).toBe(3); // the two leaves, then the ready merge
    expect(savedNodes).toEqual(["0:2", "0:3", "1:0"]);
    expect(queued(ready.leaves)).toEqual([]); // parked at the end
    expect(ready.nextLeaf).toBe(4);
    // Both children of the same-pump pair announced (1,1); the duplicate
    // entry is dropped at the next pop, when it is already built.
    expect([...new Set(queued(ready.parents[1]))]).toEqual([1]); // leaf 3 was (1,1)'s second half
    expect(await pumpOnce(opts)).toBe(1);
    expect(savedNodes).toEqual(["0:2", "0:3", "1:0", "1:1"]);
    expect(queued(ready.parents[2])).toEqual([0]); // its save completed the root's halves
    expect(await pumpOnce(opts)).toBe(1);
    expect(savedNodes).toEqual(["0:2", "0:3", "1:0", "1:1", "2:0"]);
    expect(stored.get("2:0")).toBe("a\nb\nnote: \nnote: ");
    expect(opts.busy.size).toBe(0);
  });

  test("a restart seeds ready deep merges the queue must not miss", async () => {
    // Crash state: every leaf and both level-1 merges are stored; the root is
    // not. The saved view shows only leaves, so the queues must look past it.
    const stored = new Map<string, string>([
      ["0:0", "A"], ["0:1", "B"], ["0:2", "C"], ["0:3", "D"],
      ["1:0", "P"], ["1:1", "Q"],
    ]);
    const isBuilt = (l: number, i: number) => stored.has(nodeKey(l, i));
    const view = [0, 1, 2, 3].map((i) => ({ l: 0, i, id: i, n: 1 }));
    const ready = initReady(view, isBuilt, 4);
    expect(queued(ready.leaves)).toEqual([]); // every leaf is built
    expect(ready.nextLeaf).toBe(4);
    expect(queued(ready.parents[2])).toEqual([0]); // the root was ready before the crash
    const { opts, savedNodes } = stubs(ready, stored, isBuilt);
    expect(await pumpOnce(opts)).toBe(1);
    expect(savedNodes).toEqual(["2:0"]);
    expect(stored.get("2:0")).toBe("P\nQ");
  });

  test("a pump consumes in reference order: the frontier leaf, then merges", async () => {
    // 5 messages; leaves 0-3 and both level-1 merges are built; leaf 4 is the
    // frontier, and the level-2 root over messages 0-3 is ready with it.
    const big = (c: string) => c.repeat(600);
    const stored = new Map<string, string>([
      [nodeKey(0, 0), big("A")], [nodeKey(0, 1), big("B")],
      [nodeKey(0, 2), big("C")], [nodeKey(0, 3), big("D")],
      [nodeKey(1, 0), big("P")], [nodeKey(1, 1), big("Q")],
    ]);
    const isBuilt = (l: number, i: number) => stored.has(nodeKey(l, i));
    const messages = [
      ...Array.from({ length: 4 }, (_, i) => ({ kind: "note", text: big(String(i)) })),
      { kind: "user", text: big("L") },
    ];
    const view = [0, 1, 2, 3, 4].map((i) => ({ l: 0, i, id: i, n: 1 }));
    const ready = initReady(view, isBuilt, 5);
    expect(queued(ready.leaves)).toEqual([4]);
    expect(queued(ready.parents[2])).toEqual([0]);
    const { opts, steps, savedNodes } = stubs(ready, stored, isBuilt, messages);
    expect(await pumpOnce(opts)).toBe(2);
    expect(steps.length).toBe(2);
    expect(steps[0]!.endsWith("<input>\nuser: " + big("L") + "\n</input>")).toBe(true); // the leaf runs first
    expect(steps[1]!.endsWith("<input>\n" + big("P") + "\n" + big("Q") + "\n</input>")).toBe(true); // then the merge
    expect(savedNodes).toHaveLength(2);
    expect(savedNodes).toContain("0:4");
    expect(savedNodes).toContain("2:0");
  });

  test("queued entries that are built or busy are skipped, not run", async () => {
    const stored = new Map<string, string>([["0:0", "a"], ["0:1", "b"]]);
    const isBuilt = (l: number, i: number) => stored.has(nodeKey(l, i));
    const view = [0, 1].map((i) => ({ l: 0, i, id: i, n: 1 }));
    const ready = initReady(view, isBuilt, 2);
    const { opts, savedNodes, steps } = stubs(ready, stored, isBuilt);
    requeue(ready, 0, 0); // stale: this leaf is already built
    opts.busy.add(nodeKey(1, 0)); // a busy merge is not runnable either
    expect(await pumpOnce(opts)).toBe(0);
    expect(savedNodes).toEqual([]);
    expect(steps).toEqual([]);
    expect(queued(ready.leaves)).toEqual([]); // both stale entries were dropped
    expect(queued(ready.parents[1])).toEqual([]);
    opts.busy.delete(nodeKey(1, 0));
    requeue(ready, 1, 0); // retry re-entry once the busy slot is free
    expect(await pumpOnce(opts)).toBe(1);
    expect(savedNodes).toEqual(["1:0"]);
    expect(stored.get("1:0")).toBe("a\nb");
  });

  test("a full pump probes isBuilt per picked node, not per tree cell", async () => {
    const stored = new Map<string, string>();
    for (let i = 0; i < 512; i++) stored.set(nodeKey(0, i), "user: x");
    let probes = 0;
    const isBuilt = (l: number, i: number): boolean => {
      probes++;
      return stored.has(nodeKey(l, i));
    };
    const view = Array.from({ length: 512 }, (_, i) => ({ l: 0, i, id: i, n: 1 }));
    const ready = initReady(view, isBuilt, 512); // the one-time load pass
    const seeded = probes;
    expect(queued(ready.parents[1])).toHaveLength(256);
    const { opts, savedNodes } = stubs(ready, stored, isBuilt);
    expect(await pumpOnce(opts)).toBe(8);
    expect(savedNodes).toEqual(Array.from({ length: 8 }, (_, k) => nodeKey(1, k)));
    // The old scheduler walked every level and index on each pump (~1500
    // probes for this state); the queues touch each picked node a bounded
    // number of times, whatever T is.
    expect(probes - seeded).toBeGreaterThanOrEqual(8);
    expect(probes - seeded).toBeLessThanOrEqual(48);
    // Both children of a same-pump pair announce their parent, so a duplicate
    // entry can wait in the queue; the pop drops it as built.
    expect([...new Set(queued(ready.parents[2]))].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
});
