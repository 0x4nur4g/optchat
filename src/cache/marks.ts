// Split a rendered view at cache breakpoints. Each breakpoint is a character
// offset; a cut lands on the last line end before its mark, so no cached piece
// ends mid-line. A mark at or past the end of the text is skipped.

import { MARKS } from "../constants";

export { MARKS };

export function splitViewForCache(rendered: string): { pieces: string[]; marks: number[] } {
  const cuts: number[] = [];
  for (const m of MARKS) {
    if (m >= rendered.length) continue; // mark past the end: nothing to cut
    const nl = rendered.lastIndexOf("\n", m - 1);
    if (nl < 0) continue; // no line end before this mark: skip it
    const cut = nl + 1; // newline belongs to the leading piece
    if (cuts.length > 0 && cut <= cuts[cuts.length - 1]) continue; // cuts stay increasing
    cuts.push(cut);
  }
  if (cuts.length === 0) return { pieces: [rendered], marks: [] };
  const pieces: string[] = [];
  let prev = 0;
  for (const cut of cuts) {
    pieces.push(rendered.slice(prev, cut));
    prev = cut;
  }
  if (prev < rendered.length) pieces.push(rendered.slice(prev));
  return { pieces, marks: cuts };
}