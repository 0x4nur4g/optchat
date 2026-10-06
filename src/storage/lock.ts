import { mkdir, rm } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import * as path from "node:path";

export interface LockHandle {
  release(): Promise<void>;
}

/** True when a live server answers on the socket; false for stale or no socket. */
function probe(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = connect(sock);
    let settled = false;
    const finish = (live: boolean) => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(live);
    };
    client.once("connect", () => finish(true));
    client.once("error", () => finish(false));
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

/**
 * Single-writer lock over a Unix socket at <dir>/lock.sock.
 * Bind first; on EADDRINUSE probe: a live server means refuse, a stale
 * socket file is removed and binding is retried exactly once.
 * Throws if a live writer holds it. No PID files.
 */
export async function acquireLock(dir: string): Promise<LockHandle> {
  await mkdir(dir, { recursive: true });
  const sock = path.join(dir, "lock.sock");
  let server = createServer();
  try {
    await listenOn(server, sock);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    if (await probe(sock)) throw secondWriter(sock);
    // Stale socket file: remove and retry bind once.
    await rm(sock, { force: true });
    server = createServer();
    try {
      await listenOn(server, sock);
    } catch (err2) {
      if ((err2 as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw secondWriter(sock);
      }
      throw err2;
    }
  }
  server.unref();
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(sock, { force: true });
    },
  };
}