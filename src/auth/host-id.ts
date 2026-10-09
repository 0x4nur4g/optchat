import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "node:path";

/**
 * Stable identifier for this host, required on every authorization request.
 * It is an opaque URN by design: the docs require that it never encode an
 * email, user id, or any other identifying value. Generated once per host and
 * reused for every later sign-in, so plan usage stays tied to one host.
 *
 * Accepts the three documented formats (urn:uuid, jwk-thumbprint URN, did:key)
 * so a hand-provided id is preserved rather than replaced.
 */
function isUsable(value: string): boolean {
  return value.length > 0 && !/\s/.test(value);
}

/** Existing id, or null when missing, empty, or torn by a crash. */
async function readHostId(file: string): Promise<string | null> {
  try {
    const value = (await readFile(file, "utf8")).trim();
    return isUsable(value) ? value : null;
  } catch {
    return null;
  }
}

export async function loadOrCreateHostId(dir: string): Promise<string> {
  const file = path.join(dir, "host-id");
  await mkdir(dir, { recursive: true, mode: 0o700 });

  // Bounded repair loop. An empty or truncated file must never be returned:
  // it would be sent as ext_agent_host_id on every authorization request.
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await readHostId(file);
    if (existing !== null) return existing;

    const id = `urn:uuid:${randomUUID()}`;
    try {
      // Exclusive create is race-safe: a second process gets EEXIST and reads
      // the winner's id instead of replacing it with its own.
      await writeFile(file, id, { mode: 0o600, flag: "wx" });
      return id;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Lost the create race. Keep a valid id another process just wrote;
      // remove only an unusable one and try to repair it.
      const raced = await readHostId(file);
      if (raced !== null) return raced;
      await rm(file, { force: true });
    }
  }
  throw new Error("optchat: could not establish a host id");
}
