import { appendFile, mkdir, open, readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import {
  messageSize,
  type Kind,
  type LogMessage,
} from "../constants";

const DAY_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** Directory holding the chat log for a scope: <base>/chat/<scope>/main */
export function logDir(base: string, scope: string): string {
  return path.join(base, "chat", scope, "main");
}

/** Day file for an ISO date or time: <base>/chat/<scope>/main/YYYY-MM-DD.jsonl */
export function dayFile(base: string, scope: string, dateISO: string): string {
  return path.join(logDir(base, scope), dateISO.slice(0, 10) + ".jsonl");
}

/** Number of valid (non-torn) messages currently persisted. */
export async function count(base: string, scope: string): Promise<number> {
  return (await loadAll(base, scope)).length;
}

/** Append one message, fsync, return it. i = current message count. */
export async function appendMessage(
  base: string,
  scope: string,
  kind: Kind,
  text: string,
  dateISO?: string,
): Promise<LogMessage> {
  const date = dateISO ?? new Date().toISOString();
  const dir = logDir(base, scope);
  await mkdir(dir, { recursive: true });
  const msg: LogMessage = {
    i: await count(base, scope),
    kind,
    text,
    size: messageSize(kind, text),
    date,
  };
  const line = JSON.stringify(msg) + "\n";
  const fh = await open(dayFile(base, scope, date), "a");
  try {
    await fh.write(line);
    await fh.sync();
  } finally {
    await fh.close();
  }
  return msg;
}

/** Read all day files in date order. Skip torn lines; repair a missing trailing newline. */
export async function loadAll(base: string, scope: string): Promise<LogMessage[]> {
  const dir = logDir(base, scope);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: LogMessage[] = [];
  for (const name of names.filter((n) => DAY_RE.test(n)).sort()) {
    const file = path.join(dir, name);
    let raw = await readFile(file, "utf8");
    if (raw.length > 0 && !raw.endsWith("\n")) {
      await appendFile(file, "\n");
      raw += "\n";
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as LogMessage);
      } catch {
        console.warn(`optchat: skipping torn line in ${file}`);
      }
    }
  }
  return out;
}