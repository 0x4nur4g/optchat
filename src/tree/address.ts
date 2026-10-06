// Address math for the summary tree. A node at level `l`, index `i` covers
// messages [id, id+n), where id = i*2^l and n = 2^l. Nodes are named `id+n`.

export interface Address {
  id: number;
  n: number;
}

/** Half-open message range [start, end) covered by node (l, i). */
export function covers(l: number, i: number): [number, number] {
  const n = 2 ** l;
  return [i * n, (i + 1) * n];
}

/** Name of node (l, i) in storage/tool addresses: `id+n`, id = i*2^l, n = 2^l. */
export function name(l: number, i: number): string {
  const id = i * 2 ** l;
  const n = 2 ** l;
  return `${id}+${n}`;
}

/**
 * Inverse of `name`. Null unless n is a power of two and n divides id.
 * Returns the level/index address: { l: log2(n), i: id/n }.
 */
export function parse(id: number, n: number): { l: number; i: number } | null {
  if (!isPowerOfTwo(n)) return null;
  if (id % n !== 0) return null;
  return { l: Math.log2(n), i: id / n };
}

/** Two children of (id, n), left then right. Null at the leaf level n == 1. */
export function children(id: number, n: number): Address[] | null {
  if (n === 1) return null;
  const half = n / 2;
  return [
    { id, n: half },
    { id: id + half, n: half },
  ];
}

/** Parent of (id, n): start rounded down to a 2n boundary, double width. */
export function parentOf(id: number, n: number): Address {
  return { id: id - (id % (n * 2)), n: n * 2 };
}

function isPowerOfTwo(n: number): boolean {
  if (!Number.isInteger(n) || n <= 0) return false;
  return Number.isInteger(Math.log2(n));
}