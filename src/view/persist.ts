import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Part } from "./fold";

/**
 * The live view is persisted and reloaded, never rebuilt from the log. A
 * rebuilt tiling differs from the live one, and that difference is enough to
 * invalidate every cached prefix the caller has already paid for.
 */

export function viewFile(dir: string, scope: string): string {
  return path.join(dir, "view", `${scope}.json`);
}

function isPart(value: unknown): value is Part {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Partial<Part>;
  return Number.isInteger(p.l) && (p.l as number) >= 0 &&
    Number.isInteger(p.i) && (p.i as number) >= 0 &&
    Number.isInteger(p.id) && (p.id as number) >= 0 &&
    Number.isInteger(p.n) && (p.n as number) === 2 ** (p.l as number) &&
    (p.id as number) === (p.i as number) * (p.n as number);
}

/** Serialises writes per file so a concurrent save cannot land out of order. */
const writing = new Map<string, Promise<void>>();

/** Persist the view atomically. A crash leaves the previous view intact. */
export async function saveView(dir: string, scope: string, parts: readonly Part[]): Promise<void> {
  const file = viewFile(dir, scope);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });

  // A turn awaits its own save while a node save fires one in the background.
  // Both must not race: the older view could win, and a shared temp name makes
  // the second rename fail outright.
  const previous = writing.get(file) ?? Promise.resolve();
  const run = previous.then(async () => {
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, `${JSON.stringify(parts)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  });
  writing.set(file, run.catch(() => {}));
  return run;
}

/**
 * Load the saved view, or null when it is missing or malformed. A malformed
 * file is a reason to rebuild, not to refuse to start.
 */
export async function loadView(dir: string, scope: string): Promise<Part[] | null> {
  let raw: string;
  try {
    raw = await readFile(viewFile(dir, scope), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every(isPart)) return null;
  return parsed as Part[];
}
