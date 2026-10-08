import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import * as path from "node:path";

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
 * A Linux abstract Unix socket serializes stale-file takeover across processes.
 * Its kernel lifetime needs no cleanup after a crash, PID file, or timeout.
 * The filesystem socket remains held for the writer's lifetime.
 */
export async function acquireLock(dir: string): Promise<LockHandle> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const sock = path.join(dir, "lock.sock");
  const identity = createHash("sha256").update(await realpath(dir)).digest("hex");
  const guard = createServer((client) => client.destroy());
  try {
    await listenOn(guard, `\0optchat-lock-${identity}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") throw secondWriter(sock);
    throw err;
  }
  guard.unref();
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
    await closeServer(guard);
    throw err;
  }
  server.unref();
  let release: Promise<void> | undefined;
  return {
    // Closing the server unlinks its own socket. A later rm could remove a successor.
    release: () => (release ??= closeServer(server).then(() => closeServer(guard))),
  };
}
