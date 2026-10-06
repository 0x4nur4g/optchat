import { messageSize } from "./constants";

/**
 * Import helpers: turn pasted history into log lines. Storage assigns the
 * real line id when a note is appended, so ImportedNote has no i field.
 */

/** LogMessage-shaped note. */
export interface ImportedNote {
  kind: "note";
  text: string;
  size: number;
  date: string;
}

export function toNote(text: string, date: string): ImportedNote {
  return { kind: "note", text, size: messageSize("note", text), date };
}

const TOOL_NOISE: RegExp[] = [/^\s*tool:/i, /^\s*\[tool\]/i, /^\s*assistant to=/i];

/**
 * Drop repeated pastes and obvious tool noise from an imported session.
 * Stub heuristic for phase 1; refine against real transcripts later.
 */
export function cleanSession(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (TOOL_NOISE.some((re) => re.test(line))) continue;
    if (line.length > 120) {
      if (seen.has(line)) continue; // repeated paste: keep only the first
      seen.add(line);
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}