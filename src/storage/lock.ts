import { lstat, mkdir, rm } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import * as path from "node:path";
import { lockFile } from "./flock";

export interface LockHandle {
  release(): Promise<void>;
}

/** True when a live server answers on the socket; false for stale or no socket. */
function probe(sock: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const client = connect(sock);
    let settled = false;
    const finish = (live: boolean) => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(live);
    };
    client.once("connect", () => finish(true));
    client.once("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      if (err.code === "ECONNREFUSED" || err.code === "ENOENT") finish(false);
      else {
        settled = true;
        client.destroy();
        reject(err);
      }
    });
  });
}

/** Resolve once the server is bound to the socket; reject with the raw error. */
function listenOn(server: Server, sock: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(sock);
  });
}

function secondWriter(sock: string): Error {
  return new Error(`second writer: lock already held at ${sock}`);
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

/**
 * Single-writer lock over a Unix socket at <dir>/lock.sock.
 *
 * An advisory flock serializes stale-file takeover across processes. Its
 * kernel lifetime needs no cleanup after a crash, no PID file and no timeout:
 * the lock goes with the owning process. That matters because replacing a
 * dead owner's socket means deleting a file first, and a second process that
 * deletes at the wrong moment can remove a live owner's socket instead. The
 * flock makes that sequence single-file, so it cannot happen. The filesystem
 * socket stays bound for the writer's lifetime as the visible marker.
 */
export async function acquireLock(dir: string): Promise<LockHandle> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const sock = path.join(dir, "lock.sock");
  const guard = lockFile(path.join(dir, "lock.guard"), secondWriter(sock));
  let server = createServer((client) => client.destroy());
  try {
    try {
      await listenOn(server, sock);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      if (await probe(sock)) throw secondWriter(sock);
      const entry = await lstat(sock).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (entry && !entry.isSocket()) throw new Error(`optchat: lock path is not a socket: ${sock}`);
      // Only the guard owner may remove a stale socket or bind its replacement.
      await rm(sock, { force: true });
      server = createServer((client) => client.destroy());
      try {
        await listenOn(server, sock);
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code === "EADDRINUSE") {
          throw secondWriter(sock);
        }
        throw retryError;
      }
    }
  } catch (err) {
    await closeServer(server);
    guard.release();
    throw err;
  }
  server.unref();
  let release: Promise<void> | undefined;
  return {
    // Closing the server unlinks its own socket. A later rm could remove a successor.
    release: () => (release ??= closeServer(server).then(() => guard.release())),
  };
}
