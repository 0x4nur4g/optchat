import * as path from "node:path";
import {
  CAP,
  messageSize,
  type Kind,
  type LogMessage,
} from "../constants";
import { appendRecord, dayName, readRecords, validateScope } from "./jsonl";

const KINDS: readonly string[] = ["user", "talk", "tool", "echo", "note"];

function isMessage(value: unknown): value is LogMessage {
  if (value === null || typeof value !== "object") return false;
  const message = value as Partial<LogMessage>;
  return typeof message.i === "number" && Number.isSafeInteger(message.i) && message.i >= 0 &&
    typeof message.kind === "string" && KINDS.includes(message.kind) &&
    typeof message.text === "string" && message.size === messageSize(message.kind, message.text) &&
    typeof message.date === "string" && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(message.date) &&
    Number.isFinite(Date.parse(message.date));
}

/** Directory holding the chat log for a scope: <base>/chat/<scope>/main */
export function logDir(base: string, scope: string): string {
  validateScope(scope);
  return path.join(base, "chat", scope, "main");
}

/** Local write-day file: <base>/chat/<scope>/main/YYYY-MM-DD.jsonl */
export function dayFile(base: string, scope: string, dateISO: string): string {
  return path.join(logDir(base, scope), dayName(dateISO));
}

export interface LogWriter {
  readonly messages: LogMessage[];
  readonly nextId: number;
  append(kind: Kind, text: string, dateISO?: string): Promise<LogMessage[]>;
}

/** Lossless character-bounded pieces. Keep line endings with their lines. */
export function splitLogText(text: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (text.length - start > CAP) {
    let end = start + CAP;
    const newline = text.lastIndexOf("\n", end - 1);
    if (newline >= start) end = newline + 1;
    else {
      const high = text.charCodeAt(end - 1);
      const low = text.charCodeAt(end);
      if ((high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) ||
          (text[end - 1] === "\r" && text[end] === "\n")) end--;
    }
    pieces.push(text.slice(start, end));
    start = end;
  }
  pieces.push(text.slice(start));
  return pieces;
}

/** Load once; serialize durable appends and keep the public messages reference. */
export async function openLog(base: string, scope: string): Promise<LogWriter> {
  const loaded = await readLog(base, scope);
  const messages = loaded.messages;
  let nextID = loaded.nextID;
  let pending = Promise.resolve();
  return {
    messages,
    get nextId() { return nextID; },
    async append(kind, text, dateISO) {
      const date = dateISO ?? new Date().toISOString();
      if (typeof kind !== "string" || !KINDS.includes(kind) || typeof text !== "string") {
        throw new Error("optchat: invalid log message");
      }
      const size = messageSize(kind, text);
      if (!isMessage({ i: 0, kind, text, size, date })) {
        throw new Error("optchat: invalid message date");
      }
      const result = pending.then(async () => {
        // Tool results (echo) are clipped to CAP at their source, never split.
        // Every other long text is logged as several messages in a row.
        const texts = kind === "echo" ? [text] : splitLogText(text);
        // Exact comparison: adding texts.length to nextID could round at 2^53.
        if (nextID > Number.MAX_SAFE_INTEGER - texts.length + 1) {
          throw new Error("optchat: log IDs exhausted");
        }
        const added: LogMessage[] = [];
        for (const part of texts) {
          const message: LogMessage = {
            i: nextID,
            kind,
            text: part,
            size: messageSize(kind, part),
            date,
          };
          await appendRecord(dayFile(base, scope, new Date().toISOString()), message);
          messages.push(message);
          nextID++;
          added.push(message);
        }
        return added;
      });
      pending = result.then(() => {});
      // A failed disk write blocks later appends until the writer is reopened.
      void pending.catch(() => {});
      return result;
    },
  };
}

/** Keep stored IDs in ID order. Skip corrupt records; repair missing final newlines. */
export async function loadAll(base: string, scope: string): Promise<LogMessage[]> {
  return (await readLog(base, scope)).messages;
}

async function readLog(base: string, scope: string): Promise<{
  messages: LogMessage[];
  nextID: number;
}> {
  const byID = new Map<number, LogMessage>();
  let maxID = -1;
  for await (const { value, file, line } of readRecords(logDir(base, scope))) {
    if (value !== null && typeof value === "object") {
      const id = (value as { i?: unknown }).i;
      if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) {
        maxID = Math.max(maxID, id);
      }
    }
    if (!isMessage(value)) {
      console.warn(`optchat: skipping invalid log record in ${file}:${line}`);
      continue;
    }
    if (byID.has(value.i)) {
      console.warn(`optchat: skipping duplicate log ID ${value.i} in ${file}:${line}`);
      continue;
    }
    byID.set(value.i, value);
  }
  const messages = [...byID.values()].sort((a, b) => a.i - b.i);
  let expected = 0;
  for (const message of messages) {
    if (message.i > expected) console.warn(`optchat: log ID gap ${expected}..${message.i - 1}`);
    expected = message.i + 1;
  }
  if (maxID >= expected) console.warn(`optchat: log ID gap ${expected}..${maxID}`);
  return { messages, nextID: maxID + 1 };
}
