// Render the view as the <chat> block of a fresh call.
// One row per part: `id+n|text`. A row is a summary, a raw message (leaf), or
// a placeholder when the node is not built yet. Newlines inside text become
// single spaces so every row stays one line.

import type { Part } from "./fold";

/** Text of a part, or null/undefined when the node has no summary yet. */
export type GetText = (part: Part) => string | undefined | null;

const OPEN = "<chat>";
const CLOSE = "</chat>";
const NOT_BUILT = "(not summarized yet: zoom it)";

export function renderView(parts: Part[], getText: GetText): string {
  if (parts.length === 0) return `${OPEN}\n${CLOSE}`;
  return `${OPEN}\n${parts.map((p) => row(p, getText)).join("\n")}\n${CLOSE}`;
}

/**
 * Rule for rendering the prefix of the view before message `count`:
 * a part is shown only if its whole range [id, id+n) lies before `count`.
 * A part that straddles `count` is never shown cut, and since parts are
 * ordered by id, scanning stops there. Returns the rows, no <chat> wrapper.
 */
export function renderBefore(parts: Part[], count: number, getText: GetText): string {
  const rows: string[] = [];
  for (const p of parts) {
    if (p.id >= count) break;
    if (p.id + p.n > count) break; // straddles count: never show cut text
    rows.push(row(p, getText));
  }
  return rows.join("\n");
}

function row(part: Part, getText: GetText): string {
  const text = getText(part);
  const body = text === undefined || text === null ? NOT_BUILT : squeeze(text);
  // In a valid view an unbuilt part is always a leaf (n = 1), so its
  // placeholder row reads `id+1|...` like a raw message row.
  return `${part.id}+${part.n}|${body}`;
}

function squeeze(text: string): string {
  return text.replace(/\r?\n/g, " ");
}