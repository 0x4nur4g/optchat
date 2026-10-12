/**
 * zoom tool: read one range of the chat log out of memory.
 *
 * n is the range size in lines. n must be a power of two, id must be aligned
 * to n, and the range must fit inside the log (id + n <= T). A range of one
 * returns the raw message line; a bigger range returns its two child nodes.
 * Any invalid or missing range answers "No line id+n." so the model can
 * correct itself and try again.
 */

import { formatAddress, nodeKey } from "../tree/address";
import type { LogMessage, TreeNode } from "../constants";

export interface ZoomStore {
  /** Raw message at id as "kind: text", or null when absent. */
  getMessage(id: number): string | null;
  /** Compressed node covering [id, id+n) as its two child texts, or null. */
  getNodeChildren(id: number, n: number): [string, string] | null;
}

/**
 * ZoomStore over a loaded log and node map. Both surfaces (a native turn and
 * the read-only MCP server) share this, so the address math has one owner.
 */
export function memoryZoomStore(
  messages: LogMessage[],
  nodes: Map<string, TreeNode>,
): ZoomStore {
  return {
    getMessage(id: number): string | null {
      const m = messages[id];
      return m !== undefined && m.i === id ? `${m.kind}: ${m.text}` : null;
    },
    getNodeChildren(id: number, n: number): [string, string] | null {
      const l = Math.log2(n);
      const i = id / n;
      if (!Number.isInteger(l) || !Number.isInteger(i)) return null;
      const a = nodes.get(nodeKey(l - 1, 2 * i));
      const b = nodes.get(nodeKey(l - 1, 2 * i + 1));
      if (a === undefined || b === undefined) return null;
      return [a.text, b.text];
    },
  };
}

export function zoom(store: ZoomStore, id: number, n: number, T: number): string {
  const noLine = `No line ${formatAddress(id, n)}.`;

  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(n)) return noLine;
  if (!Number.isSafeInteger(T) || T < 0) return noLine;
  if (n < 1 || 2 ** Math.floor(Math.log2(n)) !== n) return noLine;
  if (id < 0 || id % n !== 0) return noLine; // ranges are aligned
  if (id > T - n) return noLine; // range must fit inside the log

  if (n === 1) {
    const msg = store.getMessage(id);
    if (msg === null) return noLine;
    return `${formatAddress(id, 0)}|${msg}`;
  }

  const kids = store.getNodeChildren(id, n);
  if (kids === null) return noLine;
  const half = n / 2;
  return `${formatAddress(id, half)}|${kids[0]}\n${formatAddress(id + half, half)}|${kids[1]}`;
}
