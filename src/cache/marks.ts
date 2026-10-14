// Cut a rendered view into four-line blocks for prompt caching. Marks are
// character offsets (UTF-16, not bytes) into the message the caller assembles
// from the view and its tail, the new user text that follows the view: one on
// the end of the last whole block, one on the request end after the tail. A
// line ends at its newline, so a cut never splits a surrogate pair. The <chat>
// header line opens the first block without counting as one of its lines.
// These pieces preserve request prefixes; they set no vendor cache flags and
// prove no cache hit.

import { OPEN } from "../view/render";

const BLOCK_LINES = 4; // view lines per cache block
const HEADER = `${OPEN}\n`; // shared with the renderer, never re-typed

export function splitViewForCache(
  rendered: string,
  tail: string,
): { pieces: string[]; marks: number[] } {
  const end = rendered.length + tail.length; // the request end, after the tail
  if (rendered === "") return { pieces: [rendered], marks: end > 0 ? [end] : [] };
  // Line counting starts after the header: it opens the first block but is
  // not one of its four lines.
  const from = rendered.startsWith(HEADER) ? HEADER.length : 0;
  const pieces: string[] = [];
  let wholeEnd = -1; // end of the last whole block, -1 when there is none
  let prev = 0;
  let lines = 0;
  for (let nl = rendered.indexOf("\n", from); nl !== -1; nl = rendered.indexOf("\n", nl + 1)) {
    if (++lines < BLOCK_LINES) continue;
    pieces.push(rendered.slice(prev, nl + 1)); // a newline ends its piece
    prev = wholeEnd = nl + 1;
    lines = 0;
  }
  if (pieces.length === 0) return { pieces: [rendered], marks: [end] };
  if (prev < rendered.length) pieces.push(rendered.slice(prev));
  // One mark on the last whole block and one on the request end; a request
  // that ends exactly at a block end carries a single mark.
  return { pieces, marks: wholeEnd < end ? [wholeEnd, end] : [end] };
}
