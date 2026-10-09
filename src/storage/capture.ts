import { acquireLock } from "./lock";
import { openLog } from "./log";
import type { Kind, LogMessage } from "../constants";

// Kinds a capture hook may write. Reasoning is deliberately absent: capture
// records what was said, never a model's hidden working.
const CAPTURE_KINDS: readonly string[] = ["user", "talk", "tool", "echo", "note"];

/**
 * Append one message that arrived outside the interactive loop, then release
 * the writer lock. Hooks in other tools call this. Nothing here consults a
 * model, so capture stays deterministic and never depends on the model
 * choosing to remember.
 */
export async function capture(
  base: string,
  scope: string,
  kind: Kind,
  text: string,
): Promise<LogMessage> {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("optchat: capture needs non-empty text");
  }
  if (typeof kind !== "string" || !CAPTURE_KINDS.includes(kind)) {
    throw new Error("optchat: capture kind must be one of user, talk, tool, echo, note");
  }
  const lock = await acquireLock(base);
  try {
    const writer = await openLog(base, scope);
    return await writer.append(kind, text);
  } finally {
    await lock.release();
  }
}
