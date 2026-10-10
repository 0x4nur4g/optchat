// Compactor pump: pure ordering logic (which tree node to build next) plus
// an async runner skeleton. No I/O here except the injected model adapter;
// storage, view and persistence stay with the caller (turn/cli).
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
  end: number;
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
export function candidates(T: number, isBuilt: IsBuilt, busy: Set<string>, first: number = T): Candidate[] {
  const out: Candidate[] = [];
  for (let l = 0; 2 ** l <= T; l++) {
    const span = 2 ** l;
    for (let i = 0; (i + 1) * span <= T; i++) {
      if (isBuilt(l, i) || busy.has(nodeKey(l, i))) continue;
      if (l > 0 && !(isBuilt(l - 1, 2 * i) && isBuilt(l - 1, 2 * i + 1))) continue;
      const end = l === 0 ? i : (i + 1) * span;
      if (end > first) continue;
      out.push({ l, i, end });
    }
  }
  return out;
}

export interface PumpOptions {
  T: number; // total messages (len(root))
  view: Part[];
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

// Start up to JOBS nodes and resolve when those runs end; the caller
// re-invokes while it returns a positive count. A failed node keeps its
// busy slot until RETRY_MS passes, then frees for another try; only its
// first failure is reported.
export async function pumpOnce(opts: PumpOptions): Promise<number> {
  if (opts.signal?.aborted) return 0;
  const first = firstUnbuilt(opts.view, opts.isBuilt);
  const free = JOBS - opts.busy.size;
  if (free <= 0) return 0;
  const picked = candidates(opts.T, opts.isBuilt, opts.busy, first).slice(0, free);
  for (const c of picked) opts.busy.add(nodeKey(c.l, c.i));
  await Promise.allSettled(picked.map((c) => runNode(opts, c)));
  return picked.length;
}

async function runNode(opts: PumpOptions, c: Candidate): Promise<void> {
  const key = nodeKey(c.l, c.i);
  const settled = () => {
    opts.busy.delete(key);
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
    opts.reported.delete(key); // a later failure is reported again
  } catch (err) {
    if (opts.signal?.aborted && !saving) return;
    if (!opts.reported.has(key)) {
      opts.reported.add(key);
      opts.report(c.l, c.i, err);
    }
    if (!opts.signal?.aborted) {
      delayed = true;
      void delay(RETRY_MS, opts.signal, opts.sleep).then(settled);
    }
  } finally {
    if (!delayed) settled();
  }
}
