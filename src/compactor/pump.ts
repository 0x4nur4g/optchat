// Compactor pump: pure ordering logic (which tree node to build next) plus
// an async runner skeleton. No I/O here except the injected model adapter;
// storage, view and persistence stay with the caller (turn/cli).
import { JOBS, NODE, RETRY_MS, TRIES, byteLen } from "../constants";
import { COMPACT_SYSTEM, buildCompressStep, buildMergeStep } from "./prompts";
import { buildRetryMessage, cutAtBytes, shortestUnder } from "./size";

// One part of the view: tree node (l, i), named "id+n" where n is how many
// messages it covers (n = 2^l) and id is its first message. Kept structurally
// compatible with view/fold's Part.
export interface Part {
  l: number;
  i: number;
  id: number;
  n: number;
}

export type IsBuilt = (l: number, i: number) => boolean;

export interface Candidate {
  l: number;
  i: number;
  end: number;
}

// Stable key for one tree node, used in the busy and reported sets.
export function nodeKey(l: number, i: number): string {
  return `${l}:${i}`;
}

// First message whose view line is unbuilt; T (total messages) when every
// line is built. The view tiles [0, T) oldest first and startOf(part) is the
// part's first message, so T = startOf(last) + last.n.
export function firstUnbuilt(view: Part[], isBuilt: IsBuilt, startOf: (p: Part) => number): number {
  for (const part of view) if (!isBuilt(part.l, part.i)) return startOf(part);
  if (view.length === 0) return 0;
  const last = view[view.length - 1];
  return startOf(last) + last.n;
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

// The cheap model, injected. One call gets the view lines before the node,
// the step text, and the constant system prompt; it resolves to the raw reply.
export interface ModelAdapter {
  compress(contextLines: string[], step: string, system: string): Promise<string>;
}

export interface PumpOptions {
  T: number; // total messages (len(root))
  view: Part[];
  isBuilt: IsBuilt;
  startOf: (p: Part) => number;
  busy: Set<string>; // keys of nodes running now; kept by the caller
  reported: Set<string>; // keys whose first failure was reported; kept by the caller
  adapter: ModelAdapter;
  // Level 0: the message's bare kind and its whole text.
  message: (i: number) => { kind: string; text: string };
  // Level > 0: the two child lines, text only, oldest first.
  children: (l: number, i: number) => [string, string];
  // View lines (text only) lying before the node's end, oldest first.
  context: (l: number, i: number) => string[];
  // Persist the accepted line (fsync and in-memory update are the caller's).
  save: (l: number, i: number, text: string) => Promise<void>;
  // First failure of a node; the caller logs it.
  report: (l: number, i: number, err: unknown) => void;
  // Test hook; defaults to a real timer.
  sleep?: (ms: number) => Promise<void>;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Start up to JOBS nodes and resolve when those runs end; the caller
// re-invokes while it returns a positive count. A failed node keeps its
// busy slot until RETRY_MS passes, then frees for another try; only its
// first failure is reported.
export async function pumpOnce(opts: PumpOptions): Promise<number> {
  const first = firstUnbuilt(opts.view, opts.isBuilt, opts.startOf);
  const free = JOBS - opts.busy.size;
  if (free <= 0) return 0;
  const picked = candidates(opts.T, opts.isBuilt, opts.busy, first).slice(0, free);
  for (const c of picked) opts.busy.add(nodeKey(c.l, c.i));
  await Promise.allSettled(picked.map((c) => runNode(opts, c)));
  return picked.length;
}

async function runNode(opts: PumpOptions, c: Candidate): Promise<void> {
  const key = nodeKey(c.l, c.i);
  try {
    let step: string;
    if (c.l === 0) {
      const m = opts.message(c.i);
      step = buildCompressStep(m.kind, m.text);
    } else {
      step = buildMergeStep(...opts.children(c.l, c.i));
    }
    const context = opts.context(c.l, c.i);

    // One call, then up to TRIES size retries. The retry is sent on top of
    // the step so a stateless adapter sees the whole exchange.
    // AGENTS.md rule 5: compactor output is one line only. Normalize any
    // model newlines to spaces before the size loop, so every try and the
    // saved line stay single-line.
    let line = (await opts.adapter.compress(context, step, COMPACT_SYSTEM)).trim().replace(/\r?\n+/g, " ");
    const tries: string[] = [];
    for (;;) {
      if (line === "") throw new Error("compactor returned an empty line");
      tries.push(line);
      if (byteLen(line) <= NODE || tries.length >= TRIES) break;
      const retry = buildRetryMessage(byteLen(line), NODE, cutAtBytes(line, NODE));
      line = (await opts.adapter.compress(context, `${step}\n\n${retry}`, COMPACT_SYSTEM)).trim().replace(/\r?\n+/g, " ");
    }

    await opts.save(c.l, c.i, shortestUnder(tries, NODE));
    opts.busy.delete(key);
    opts.reported.delete(key); // a later failure is reported again
  } catch (err) {
    if (!opts.reported.has(key)) {
      opts.reported.add(key);
      opts.report(c.l, c.i, err);
    }
    const sleep = opts.sleep ?? delay;
    void (async () => {
      try {
        await sleep(RETRY_MS);
      } catch {
        // retry regardless
      }
      opts.busy.delete(key);
    })();
  }
}