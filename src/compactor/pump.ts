// Compactor pump: pure ordering logic (which tree node to build next, kept
// in ready queues) plus an async runner skeleton. No I/O here except the
// injected model adapter; storage, view and persistence stay with the caller
// (turn/cli).
import { JOBS, NODE, TRIES, byteLen } from "../constants";
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
  /** i for level 0 (its message); (i+1)*2^l for a merge (exclusive end). */
  end: number;
}

// First message whose view line is unbuilt once `allowance` unbuilt lines
// are tolerated (default 0: the first unbuilt line); T (total messages)
// when fewer unbuilt lines remain. The view tiles [0, T) oldest first,
// so T = last.id + last.n.
export function firstUnbuilt(view: Part[], isBuilt: IsBuilt, allowance = 0): number {
  for (const part of view) {
    if (!isBuilt(part.l, part.i) && allowance-- === 0) return part.id;
  }
  if (view.length === 0) return 0;
  const last = view[view.length - 1];
  return last.id + last.n;
}

// Buildable nodes, in the reference order (leaves oldest first, then each
// merge level):
//   not built, not busy, sources ready (level 0: the message exists;
//   level > 0: both children built). A leaf only needs end <= leafFirst: up
//   to 7 unbuilt view lines may precede its message; a merge may build
//   across earlier view holes.
// `end` is i for level 0 (its message) and (i+1)*2^l for a merge (exclusive).
// The caller passes leafFirst = firstUnbuilt(..., 7); the default T means
// "no frontier" and returns every buildable node.
// This runs exactly once per load, in initReady, to seed the ready queues.
// The pump itself pops those queues, so it never enumerates levels or
// indices on each pump; the per-pump scan was the spec's O(N^2) mistake.
export function candidates(T: number, isBuilt: IsBuilt, busy: Set<string>, leafFirst: number = T): Candidate[] {
  const out: Candidate[] = [];
  for (let l = 0; 2 ** l <= T; l++) {
    const span = 2 ** l;
    for (let i = 0; (i + 1) * span <= T; i++) {
      if (isBuilt(l, i) || busy.has(nodeKey(l, i))) continue;
      if (l > 0 && !(isBuilt(l - 1, 2 * i) && isBuilt(l - 1, 2 * i + 1))) continue;
      const end = l === 0 ? i : (i + 1) * span;
      if (l === 0 && end > leafFirst) continue;
      out.push({ l, i, end });
    }
  }
  return out;
}

// --- ready queues ------------------------------------------------------------
// The spec's scheduler: keep the nodes that are ready to build in queues and
// never scan the tree for work. A leaf enters when its message arrives with
// fewer than 8 unbuilt view lines before it; a merge
// enters when its second child is saved; a failed node re-enters when the
// chat advances past its failed attempt, never on a timer. A merge's
// frontier rule holds by
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
  // A leaf may start with up to 7 unbuilt view lines before it.
  for (const c of candidates(T, isBuilt, new Set(), firstUnbuilt(view, isBuilt, 7))) {
    push(c.l === 0 ? ready.leaves : mergeQueue(ready, c.l), c.i);
  }
  return ready;
}

/**
 * Message i arrived. Its leaf is ready once fewer than 8 unbuilt view lines
 * precede it; a message arriving behind a larger gap enters through the
 * window pushes in saved() once enough of them build.
 */
export function arrive(ready: ReadyQueues, i: number): void {
  ready.T = Math.max(ready.T, i + 1);
  if (i - ready.nextLeaf < 8) push(ready.leaves, i);
}

/**
 * A node's save just completed, so isBuilt(l, i) is now true. A saved leaf
 * moves the frontier past every already-built leaf and re-offers the
 * arrived leaves now inside the 7-unbuilt-line window; any save makes the
 * parent whose second half it completed ready.
 */
export function saved(ready: ReadyQueues, isBuilt: IsBuilt, busy: Set<string>, l: number, i: number): void {
  if (l === 0) {
    while (ready.nextLeaf < ready.T && isBuilt(0, ready.nextLeaf)) ready.nextLeaf++;
    for (let j = ready.nextLeaf; j < ready.T && j - ready.nextLeaf < 8; j++) {
      if (!isBuilt(0, j) && !busy.has(nodeKey(0, j))) push(ready.leaves, j);
    }
  }
  const parent = i >> 1;
  if (isBuilt(l, i ^ 1) && !isBuilt(l + 1, parent)) push(mergeQueue(ready, l + 1), parent);
}

/** Re-enter a node unlocked by a chat advance after a failure. */
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
    if (!isBuilt(0, i) && !busy.has(nodeKey(0, i))) return { l: 0, i, end: i };
  }
  for (let l = 1; l < ready.parents.length; l++) {
    const bucket = ready.parents[l];
    if (bucket === undefined) continue;
    for (let i = shift(bucket); i !== undefined; i = shift(bucket)) {
      if (!isBuilt(l, i) && !busy.has(nodeKey(l, i))) return { l, i, end: (i + 1) * 2 ** l };
    }
  }
  return undefined;
}

export interface PumpOptions {
  ready: ReadyQueues; // ready queues; kept by the caller
  isBuilt: IsBuilt;
  busy: Set<string>; // keys of nodes running now; kept by the caller
  reported: Set<string>; // keys whose first failure was reported; kept by the caller
  failedAt: Map<string, number>; // failed attempt's starting generation; kept by the caller
  // Retry generation: how far the chat has advanced. Defaults to T, so a failed
  // node is retried at the next appended message. A caller that settles before
  // it can append may advance it earlier, on input that will become a message.
  epoch?: number;
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
  // Wake the caller whenever a running node releases its busy slot.
  onSettled?: () => void;
}

// Start up to JOBS nodes from the ready queues and resolve when those runs
// end; the caller re-invokes while it returns a positive count. Failures
// release capacity immediately, but only a greater retry generation permits
// another attempt: the chat advances when a message is appended, or earlier
// on input that will become one. Record the generation at dispatch, so chat
// advancing during the call also unlocks a retry.
/**
 * Unlock every node whose failure predates the chat's current advance: each
 * re-enters its queue, one more attempt per advance; no timer ever runs.
 */
function requeueFailed(opts: PumpOptions, at: number): void {
  for (const [key, gen] of opts.failedAt) {
    if (gen >= at) continue;
    opts.failedAt.delete(key);
    const [l, i] = key.split(":").map(Number) as [number, number];
    requeue(opts.ready, l, i);
  }
}

export async function pumpOnce(opts: PumpOptions): Promise<number> {
  if (opts.signal?.aborted) return 0;
  const at = opts.epoch ?? opts.ready.T;
  requeueFailed(opts, at);
  const free = JOBS - opts.busy.size;
  if (free <= 0) return 0;
  const picked: Candidate[] = [];
  while (picked.length < free) {
    const c = popReady(opts.ready, opts.isBuilt, opts.busy);
    if (c === undefined) break;
    // A node that already failed this epoch waits for a chat advance.
    if ((opts.failedAt.get(nodeKey(c.l, c.i)) ?? -1) >= at) continue;
    opts.busy.add(nodeKey(c.l, c.i));
    picked.push(c);
  }
  await Promise.allSettled(picked.map((c) => runNode(opts, c, at)));
  return picked.length;
}

async function runNode(opts: PumpOptions, c: Candidate, at: number): Promise<void> {
  const key = nodeKey(c.l, c.i);
  const settled = () => {
    opts.busy.delete(key);
    opts.onSettled?.();
  };
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
    saved(opts.ready, opts.isBuilt, opts.busy, c.l, c.i); // frontier + parent readiness
    opts.failedAt.delete(key);
    opts.reported.delete(key); // a later failure is reported again
  } catch (err) {
    if (opts.signal?.aborted && !saving) return;
    opts.failedAt.set(key, at);
    if (!opts.reported.has(key)) {
      opts.reported.add(key);
      opts.report(c.l, c.i, err);
    }
  } finally {
    settled();
  }
}
