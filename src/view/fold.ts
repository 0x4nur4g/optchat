// Incremental view fold. The view is a list of parts tiling [0, T): each part
// is a tree node (l, i) covering messages [id, id+n), with id = i*2^l and
// n = 2^l. Leaves (n = 1) summarize one message. A parent may replace two adjacent
// same-level parts only once its summary is built. Pure module: no I/O.

import { VIEW } from "../constants";

export interface Part {
  l: number;
  i: number;
  id: number;
  n: number;
}

/** Rendered byte length of node (l, i): summary size if built, placeholder size if not. */
export type SizeOf = (l: number, i: number) => number;

/** True once node (l, i) has a stored summary that can enter the view. */
export type IsBuilt = (l: number, i: number) => boolean;

/** Empty view. */
export function initialView(): Part[] {
  return [];
}

/**
 * Append the leaf for message T-1, then merge while the view exceeds VIEW bytes.
 * `view` must tile [0, T-1); use initialView() before the first message.
 * Merging replaces two adjacent same-level parts by their parent, largest
 * due first, as long as the parent is built. Stops when no merge is possible.
 */
export function appendAndFit(view: Part[], T: number, sizes: SizeOf, isBuilt: IsBuilt): Part[] {
  if (T <= 0) return view.slice();
  return fit([...view, { l: 0, i: T - 1, id: T - 1, n: 1 }], T, sizes, isBuilt);
}

/** Fit an existing view by merging only; never append, replay or split parts. */
export function fit(view: Part[], T: number, sizes: SizeOf, isBuilt: IsBuilt): Part[] {
  const parts = view.slice();
  while (sumBytes(parts, sizes) > VIEW) {
    const k = bestPair(parts, T, isBuilt);
    if (k < 0) break;
    const a = parts[k];
    parts.splice(k, 2, { l: a.l + 1, i: a.i / 2, id: a.id, n: a.n * 2 });
  }
  return parts;
}

/** Load-time fold: replay messages 0..T-1, folding as each one arrives. */
export function foldAll(T: number, sizes: SizeOf, isBuilt: IsBuilt): Part[] {
  let view = initialView();
  for (let t = 1; t <= T; t++) view = appendAndFit(view, t, sizes, isBuilt);
  return view;
}

/**
 * Index of the adjacent pair to merge, or -1 when nothing can merge.
 * Pair (a, b) is mergeable when a.l == b.l, a.i is even, b.i == a.i + 1, and
 * parent (a.l+1, a.i/2) is built. Largest due wins:
 *   due = (T - a.id) / 2^(a.l + 2)
 * due * 4 == (T - a.id) / 2^a.l, and the constant factor 4 never changes the
 * argmax, so ranking by due is the same as ranking by (T - a.id) / 2^a.l.
 */
function bestPair(parts: Part[], T: number, isBuilt: IsBuilt): number {
  let best = -1;
  let bestDue = -1;
  for (let k = 0; k + 1 < parts.length; k++) {
    const a = parts[k];
    const b = parts[k + 1];
    if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue;
    if (!isBuilt(a.l + 1, a.i / 2)) continue;
    const due = (T - a.id) / 2 ** (a.l + 2);
    if (due > bestDue) {
      bestDue = due;
      best = k;
    }
  }
  return best;
}

function sumBytes(parts: Part[], sizes: SizeOf): number {
  let total = 0;
  for (const p of parts) total += sizes(p.l, p.i);
  return total;
}
