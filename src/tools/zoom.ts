/**
 * zoom tool: read one range of the chat log out of memory.
 *
 * n is the range size in lines. n must be a power of two, id must be aligned
 * to n, and the range must fit inside the log (id + n <= T). A range of one
 * returns the raw message line; a bigger range returns the compressed node.
 * Any invalid or missing range answers "No line id+n." so the model can
 * correct itself and try again.
 */

export interface ZoomStore {
  /** Raw message at id as "kind: text", or null when absent. */
  getMessage(id: number): string | null;
  /** Compressed node covering [id, id+n) as its two child texts, or null. */
  getNodeChildren(id: number, n: number): [string, string] | null;
}

export function zoom(store: ZoomStore, id: number, n: number, T: number): string {
  const noLine = `No line ${id + n}.`;

  if (!Number.isInteger(id) || !Number.isInteger(n)) return noLine;
  if (n < 1 || (n & (n - 1)) !== 0) return noLine; // n must be a power of two
  if (id < 0 || id % n !== 0) return noLine; // ranges are aligned
  if (id + n > T) return noLine; // range must fit inside the log

  if (n === 1) {
    const msg = store.getMessage(id);
    if (msg === null) return noLine;
    return `${id}|${msg}`;
  }

  const kids = store.getNodeChildren(id, n);
  if (kids === null) return noLine;
  return `${id + n}|${kids[0]}\n${id + n}|${kids[1]}`;
}