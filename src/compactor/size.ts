// Size helpers for the compactor: cut a line at a byte limit without
// splitting a UTF-8 character, pick the best try, and build the retry
// message that shows the model where the limit falls.
import { byteLen } from "../constants";

// Longest prefix of `s` that fits in `limit` UTF-8 bytes. Never splits a
// character: a partial sequence at the cut is dropped, not kept as U+FFFD.
export function cutAtBytes(s: string, limit: number): string {
  if (limit <= 0) return "";
  if (byteLen(s) <= limit) return s;
  const buf = Buffer.from(s, "utf8");
  let cut = buf.subarray(0, limit).toString("utf8");
  if (cut.endsWith("\uFFFD")) cut = cut.slice(0, -1); // cut fell inside a character
  return cut;
}

// Shortest line by UTF-8 bytes that stays within `limit`. If every line is
// over, returns the shortest one anyway: a stubborn node keeps its best try.
// Empty entries are ignored (an empty line fails the node elsewhere).
export function shortestUnder(lines: string[], limit: number): string {
  if (lines.length === 0) return "";
  const nonEmpty = lines.filter((l) => l.length > 0);
  const pool = nonEmpty.length > 0 ? nonEmpty : lines;
  const under = pool.filter((l) => byteLen(l) <= limit);
  const pick = under.length > 0 ? under : pool;
  let best = pick[0]!;
  for (const line of pick) if (byteLen(line) < byteLen(best)) best = line;
  return best;
}

// Sent back for another try when a line overshoots `limit`; `cut` is the
// line cut exactly where the limit falls.
export function buildRetryMessage(actual: number, limit: number, cut: string): string {
  return `That line is ${actual} bytes; limit ${limit}. It must end where cut here: ${cut}| <- LIMIT`;
}