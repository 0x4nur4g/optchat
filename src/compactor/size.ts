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
  let end = Math.floor(limit);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

// Shortest line by UTF-8 bytes, including when every line exceeds the target.
// A shortest line is always under the target whenever any candidate is.
// Empty entries are ignored (an empty line fails the node elsewhere).
export function shortestUnder(lines: string[], _limit: number): string {
  let best = "";
  for (const line of lines) {
    if (line !== "" && (best === "" || byteLen(line) < byteLen(best))) best = line;
  }
  return best;
}

// Sent back for another try when a line overshoots `limit`; `cut` is the
// line cut exactly where the limit falls.
export function buildRetryMessage(actual: number, limit: number, cut: string): string {
  return `That line is ${actual} bytes; limit ${limit}. It must end where cut here: ${cut}| <- LIMIT`;
}
