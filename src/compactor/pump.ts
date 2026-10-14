// Compactor pump: pure ordering logic (which tree node to build next, kept
// in ready queues) plus an async runner skeleton. No I/O here except the
// injected model adapter; storage, view and persistence stay with the caller
// (turn/cli).
import { JOBS, NODE, RETRY_MS, TRIES, byteLen } from "../constants";
import type { CompactionAdapter } from "../model/adapter";
import { nodeKey } from "../tree/address";
import type { IsBuilt, Part } from "../view/fold";
import { SHARED_SYSTEM, buildCompressStep, buildMergeStep } from "./prompts";
import { buildRetryMessage, cutAtBytes, shortestUnder } from "./size";

export type { IsBuilt, Part } from "../view/fold";
export { nodeKey } from "../tree/address";

export interface Candidate {
  l: number;
  i: number;
}

// First message whose view line is unbuilt; T (total messages) when every
// line is built. The view tiles [0, T) oldest first, so T = last.id + last.n.
export function firstUnbuilt(view: Part[], isBuilt: IsBuilt): number {
  for (const part of view) if (!isBuilt(part.l, part.i)) return part.id;
  if (view.length === 0) return 0;
  const last = view[view.length - 1];
  return last.id + last.n;
}

// Buildable nodes, in the reference order (leaves oldest first, then each
// merge level):
//   not built, not busy, sources ready (level 0: the message exists;
//   level > 0: both children built), and end <= first so that every view
//   line before the node's end is already a built summary.
// `end` is i for level 0 (its message) and (i+1)*2^l for a merge (exclusive).
// The caller passes first = firstUnbuilt(...); the default T means "no
// frontier" and returns every buildable node.
// This runs exactly once per load, in initReady, to seed the ready queues.
// The pump itself pops those queues, so it never enumerates levels or
// indices on each pump; the per-pump scan was the spec's O(N^2) mistake.
export function candidates(T: number, isBuilt: IsBuilt, busy: Set<string>, first: number = T): Candidate[] {
  const out: Candidate[] = [];
  for (let l = 0; 2 ** l <= T; l++) {
    const span = 2 ** l;
    for (let i = 0; (i + 1) * span <= T; i++) {
      if (isBuilt(l, i) || busy.has(nodeKey(l, i))) continue;
      if (l > 0 && !(isBuilt(l - 1, 2 * i) && isBuilt(l - 1, 2 * i + 1))) continue;
      const end = l === 0 ? i : (i + 1) * span;
      if (end > first) continue;
      out.push({ l, i });
    }
  }
  return out;
}

// --- ready queues ------------------------------------------------------------
// The spec's scheduler: keep the nodes that are ready to build in queues and
// never scan the tree for work. A leaf enters when its message arrives and
// the frontier already reaches it (every view line before it built); a merge
// enters when its second child is saved; a failed node re-enters when its
// retry delay releases the busy slot. A merge's frontier rule holds by
// construction: a built node implies every leaf before its end is built, so
// the frontier has already passed any parent whose second half just finished.

/** FIFO with a head cursor: pops and stale drops are O(1). */
export interface Queue {
  items: number[];
  head: number;
}

/** The ready nodes: `leaves` holds the frontier leaf, `parents[l]` level-l merges. */
export interface ReadyQueues {
  /** Messages seen; arrivals are the only way it grows. */
  T: number;
  /** First message with no built leaf yet (the frontier). */
  nextLeaf: number;
  /** Frontier leaf, when its message has arrived. At most one entry. */
  leaves: Queue;
  /** Ready merges, oldest first within each level. */
  parents: (Queue | undefined)[];
}

function queue(): Queue {
  return { items: [], head: 0 };
}

function push(q: Queue, i: number): void {
  q.items.push(i);
}

// Next index, or undefined when the queue is empty. The head cursor keeps
// pops O(1); slicing occasionally stops a long-lived queue from carrying a
// growing dead prefix.
function shift(q: Queue): number | undefined {
  if (q.head >= q.items.length) {
    q.items.length = 0;
    q.head = 0;
    return undefined;
  }
  const i = q.items[q.head]!;
  q.head++;
  if (q.head > 64 && q.head * 2 >= q.items.length) {
    q.items = q.items.slice(q.head);
    q.head = 0;
  }
  return i;
}

/** Live contents of a queue, drained end first: for tests and diagnostics. */
export function queued(q: Queue | undefined): number[] {
  return q === undefined ? [] : q.items.slice(q.head);
}

function mergeQueue(ready: ReadyQueues, l: number): Queue {
  return (ready.parents[l] ??= queue());
}

/**
 * Seed the ready queues once at load. The single candidates() pass here is
 * the only place the whole tree is walked for work.
 */
export function initReady(view: Part[], isBuilt: IsBuilt, T: number): ReadyQueues {
  const first = firstUnbuilt(view, isBuilt);
  const ready: ReadyQueues = { T, nextLeaf: first, leaves: queue(), parents: [] };
  for (const c of candidates(T, isBuilt, new Set(), first)) {
    push(c.l === 0 ? ready.leaves : mergeQueue(ready, c.l), c.i);
  }
  return ready;
}

/**
 * Message i arrived. Its leaf is ready only under the frontier rule, which
 * for the newest message means the frontier is parked exactly at it; a later
 * message whose predecessor is still unbuilt enters through saved() instead.
 */
export function arrive(ready: ReadyQueues, i: number): void {
  ready.T = Math.max(ready.T, i + 1);
  if (ready.nextLeaf === i) push(ready.leaves, i);
}

/**
 * A node's save just completed, so isBuilt(l, i) is now true. A saved leaf
 * moves the frontier past every already-built leaf; any save makes the
 * parent whose second half it completed ready.
 */
export function saved(ready: ReadyQueues, isBuilt: IsBuilt, l: number, i: number): void {
  if (l === 0) {
    ready.nextLeaf = Math.max(ready.nextLeaf, i + 1);
    while (ready.nextLeaf < ready.T && isBuilt(0, ready.nextLeaf)) ready.nextLeaf++;
    if (ready.nextLeaf < ready.T) push(ready.leaves, ready.nextLeaf);
  }
  const parent = i >> 1;
  if (isBuilt(l, i ^ 1) && !isBuilt(l + 1, parent)) push(mergeQueue(ready, l + 1), parent);
}

/** Re-enter a node whose retry delay just released its busy slot. */
export function requeue(ready: ReadyQueues, l: number, i: number): void {
  push(l === 0 ? ready.leaves : mergeQueue(ready, l), i);
}

/**
 * Next ready node in the reference order: the frontier leaf first, then
 * merges level by level, oldest first within a level. Entries that are
 * already built or busy are stale and dropped; their own events re-add them
 * when they are ready again.
 */
function popReady(ready: ReadyQueues, isBuilt: IsBuilt, busy: Set<string>): Candidate | undefined {
  for (let i = shift(ready.leaves); i !== undefined; i = shift(ready.leaves)) {
    if (!isBuilt(0, i) && !busy.has(nodeKey(0, i))) return { l: 0, i };
  }
  for (let l = 1; l < ready.parents.length; l++) {
    const bucket = ready.parents[l];
    if (bucket === undefined) continue;
    for (let i = shift(bucket); i !== undefined; i = shift(bucket)) {
      if (!isBuilt(l, i) && !busy.has(nodeKey(l, i))) return { l, i };
    }
  }
  return undefined;
}

export interface PumpOptions {
  ready: ReadyQueues; // ready queues; kept by the caller
  isBuilt: IsBuilt;
  busy: Set<string>; // keys of nodes running now; kept by the caller
  reported: Set<string>; // keys whose first failure was reported; kept by the caller
  adapter: CompactionAdapter;
  // Level 0: the message's bare kind and its whole text.
  message: (i: number) => { kind: string; text: string };
  // Level > 0: the two child lines, text only, oldest first.
  children: (l: number, i: number) => [string, string];
  // View lines (text only) lying before the node's end, oldest first.
  context: (l: number, i: number) => string[];
  // Persist the accepted source/line (fsync and in-memory update are the caller's).
  save: (l: number, i: number, text: string) => Promise<void>;
  // First failure of a node; the caller logs it.
  report: (l: number, i: number, err: unknown) => void;
  signal?: AbortSignal;
  // Wake the caller whenever a running or delayed node releases its busy slot.
  onSettled?: () => void;
  // Test hook; defaults to a real timer.
  sleep?: (ms: number) => Promise<void>;
}

function delay(ms: number, signal?: AbortSignal, sleep?: PumpOptions["sleep"]): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    if (signal?.aborted) return done();
    signal?.addEventListener("abort", done, { once: true });
    if (sleep) void Promise.resolve().then(() => sleep(ms)).then(done, done);
    else timer = setTimeout(done, ms);
  });
}

// Start up to JOBS nodes from the ready queues and resolve when those runs
// end; the caller re-invokes while it returns a positive count. A failed node
// keeps its busy slot until RETRY_MS passes, then re-enters its queue for
// another try; only its first failure is reported.
export async function pumpOnce(opts: PumpOptions): Promise<number> {
  if (opts.signal?.aborted) return 0;
  const free = JOBS - opts.busy.size;
  if (free <= 0) return 0;
  const picked: Candidate[] = [];
  while (picked.length < free) {
    const c = popReady(opts.ready, opts.isBuilt, opts.busy);
    if (c === undefined) break;
    opts.busy.add(nodeKey(c.l, c.i));
    picked.push(c);
  }
  await Promise.allSettled(picked.map((c) => runNode(opts, c)));
  return picked.length;
}

async function runNode(opts: PumpOptions, c: Candidate): Promise<void> {
  const key = nodeKey(c.l, c.i);
  const settled = () => {
    opts.busy.delete(key);
    opts.onSettled?.();
  };
  const retry = () => {
    opts.busy.delete(key);
    requeue(opts.ready, c.l, c.i); // the node re-enters for another try
    opts.onSettled?.();
  };
  let delayed = false;
  let saving = false;
  try {
    opts.signal?.throwIfAborted();
    let step: string;
    let source: string;
    if (c.l === 0) {
      const m = opts.message(c.i);
      source = `${m.kind}: ${m.text}`;
      step = buildCompressStep(m.kind, m.text);
    } else {
      const children = opts.children(c.l, c.i);
      source = children.join("\n");
      step = buildMergeStep(...children);
    }
    let accepted = source;
    if (byteLen(source) > NODE) {
      const context = opts.context(c.l, c.i).map((line) => line.replace(/\r\n?|\n/g, " "));
      // One session retains raw replies. Only model output is flattened;
      // free sources keep their original newlines.
      // Same system text as a turn, so this reads the turns' cached prefix.
      const session = opts.adapter.openCompaction(context, step, SHARED_SYSTEM, opts.signal);
      const tries: string[] = [];
      let feedback: string | undefined;
      for (;;) {
        opts.signal?.throwIfAborted();
        const line = (await session.reply(feedback)).trim().replace(/\r\n?|\n/g, " ");
        opts.signal?.throwIfAborted();
        if (line === "") throw new Error("compactor returned an empty line");
        tries.push(line);
        if (byteLen(line) <= NODE || tries.length >= TRIES) break;
        feedback = buildRetryMessage(byteLen(line), NODE, cutAtBytes(line, NODE));
      }
      accepted = shortestUnder(tries, NODE);
    }

    opts.signal?.throwIfAborted();
    saving = true;
    // Never race a durable save against cancellation; shutdown must await it.
    await opts.save(c.l, c.i, accepted);
    saved(opts.ready, opts.isBuilt, c.l, c.i); // frontier + parent readiness
    opts.reported.delete(key); // a later failure is reported again
  } catch (err) {
    if (opts.signal?.aborted && !saving) return;
    if (!opts.reported.has(key)) {
      opts.reported.add(key);
      opts.report(c.l, c.i, err);
    }
    if (!opts.signal?.aborted) {
      delayed = true;
      void delay(RETRY_MS, opts.signal, opts.sleep).then(retry);
    }
  } finally {
    if (!delayed) settled();
  }
}
