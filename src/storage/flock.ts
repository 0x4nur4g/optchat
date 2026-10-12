import { closeSync, openSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";

// Advisory file locking. flock(2) is the one POSIX primitive whose holder is
// unambiguous after a crash: the kernel drops the lock when the owning process
// dies, leaving nothing behind to delete and nothing for a second process to
// mistake for its own. A lock file or a filesystem socket leaves a stale
// artifact that must be removed, and removing it is the race that a live owner
// can lose.

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

type Flock = (fd: number, operation: number) => number;

let resolved: Flock | null = null;

function loadFlock(): Flock {
  if (resolved !== null) return resolved;
  // libc is named differently per platform; flock itself is in all of them.
  const candidates = process.platform === "darwin"
    ? ["libSystem.B.dylib", "libSystem.dylib", "libc.dylib"]
    : ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1", "libc.so"];
  for (const path of candidates) {
    try {
      const library = dlopen(path, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      resolved = (fd, operation) => library.symbols.flock(fd, operation);
      return resolved;
    } catch {
      // Not this libc; try the next name.
    }
  }
  throw new Error("optchat: this platform provides no flock(2)");
}

export interface FileLock {
  release(): void;
}

/**
 * Hold an exclusive lock on `file` for the life of this process. Throws
 * `busy` when another process holds it. `release` is idempotent, and the lock
 * goes with the process even without it.
 */
export function lockFile(file: string, busy: Error): FileLock {
  const flock = loadFlock();
  const fd = openSync(file, "a+", 0o600);
  if (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(fd);
    throw busy;
  }
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      flock(fd, LOCK_UN);
      closeSync(fd);
    },
  };
}
