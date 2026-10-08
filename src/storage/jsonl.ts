import { mkdir, open, readdir, type FileHandle } from "node:fs/promises";
import * as path from "node:path";

const DAY_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** Scope is one plain path segment, never an absolute or relative path. */
export function validateScope(scope: string): void {
  if (typeof scope !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(scope)) {
    throw new Error("optchat: invalid scope");
  }
}

/** Local calendar day for a timestamp; the filename never uses raw input text. */
export function dayName(dateISO: string): string {
  const date = new Date(dateISO);
  const year = date.getFullYear();
  if (!Number.isFinite(date.getTime()) || year < 0 || year > 9999) {
    throw new Error("optchat: invalid date");
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.jsonl`;
}

/** Separate a crash tail from any later record, durably, without editing it. */
async function repairTail(fh: FileHandle): Promise<void> {
  const size = (await fh.stat()).size;
  if (size === 0) return;
  const last = Buffer.alloc(1);
  const { bytesRead } = await fh.read(last, 0, 1, size - 1);
  if (bytesRead !== 1) throw new Error("optchat: could not read JSONL tail");
  if (last[0] === 10) return;
  await fh.write("\n");
  await fh.sync();
}

/** One record write plus fsync. Only the final byte is read before appending. */
export async function appendRecord(file: string, value: unknown): Promise<void> {
  const line = JSON.stringify(value) + "\n";
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const fh = await open(file, "a+", 0o600);
  try {
    await repairTail(fh);
    const { bytesWritten } = await fh.write(line);
    if (bytesWritten !== Buffer.byteLength(line, "utf8")) {
      throw new Error(`optchat: incomplete JSONL write in ${file}`);
    }
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Read day files in order; report malformed JSON without including its text. */
export async function* readRecords(dir: string): AsyncGenerator<{
  value: unknown;
  file: string;
  line: number;
}> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const name of names.filter((name) => DAY_RE.test(name)).sort()) {
    const file = path.join(dir, name);
    const fh = await open(file, "a+", 0o600);
    let raw: string;
    try {
      raw = await fh.readFile("utf8");
      await repairTail(fh);
    } finally {
      await fh.close();
    }
    const lines = raw.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (line.trim() === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        console.warn(`optchat: skipping torn line in ${file}:${index + 1}`);
        continue;
      }
      yield { value, file, line: index + 1 };
    }
  }
}
