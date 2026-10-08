// Address math for the summary tree. A node at level `l`, index `i` covers
// messages [id, id+n), where id = i*2^l and n = 2^l. Nodes are named `id+n`.

/** Map key for a node's level and index. */
export function nodeKey(l: number, i: number): string {
  return `${l}:${i}`;
}

/** Literal range address, not the arithmetic sum of its parts. */
export function formatAddress(id: number, n: number): string {
  return `${id}+${n}`;
}
