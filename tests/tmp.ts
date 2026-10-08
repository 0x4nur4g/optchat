import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFERRED = "/tmp/opencode";

/**
 * Temp root for test fixtures. Prefers the sanctioned /tmp/opencode root and
 * creates it when absent, so tests never depend on a pre-existing directory;
 * falls back to the OS temp dir when that path is not writable.
 */
export function tempRoot(): string {
  try {
    mkdirSync(PREFERRED, { recursive: true });
    return PREFERRED;
  } catch {
    return tmpdir();
  }
}

/** mkdtemp prefix under the temp root: tempPath("optchat-cli-"). */
export function tempPath(prefix: string): string {
  return join(tempRoot(), prefix);
}
