import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import * as path from "node:path";
import { acquireLock, type LockHandle } from "../src/storage/lock";

let dir: string;
const locks: LockHandle[] = [];
const children: ReturnType<typeof contender>[] = [];

function contender(directory: string) {
  const module = path.resolve(import.meta.dir, "../src/storage/lock.ts");
  const child = Bun.spawn([process.execPath, "--eval", `
    import { acquireLock } from ${JSON.stringify(module)};
    const input = Bun.stdin.stream().getReader();
    console.log("ready");
    await input.read();
    try {
      const lock = await acquireLock(${JSON.stringify(directory)});
      console.log("held");
      await input.read();
      await lock.release();
    } catch (error) {
      if (error.message.startsWith("second writer:")) console.log("blocked");
      else { console.error(error.message); process.exitCode = 1; }
    }
  `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const output = child.stdout.getReader();
  let buffer = "";
  return {
    child,
    async status(): Promise<string> {
      while (!buffer.includes("\n")) {
        const chunk = await output.read();
        if (chunk.done) throw new Error("lock contender exited before reporting");
        buffer += new TextDecoder().decode(chunk.value);
      }
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      return line;
    },
  };
}

async function crashWriter() {
  const writer = contender(dir);
  children.push(writer);
  expect(await writer.status()).toBe("ready");
  writer.child.stdin.write("go\n");
  expect(await writer.status()).toBe("held");
  writer.child.kill("SIGKILL");
  await writer.child.exited;
}
beforeEach(async () => {
  dir = await mkdtemp("/tmp/opencode/optchat-lock-");
});
afterEach(async () => {
  await Promise.all(children.splice(0).map(async ({ child }) => {
    child.kill("SIGKILL");
    await child.exited;
  }));
  await Promise.all(locks.splice(0).map((lock) => lock.release()));
  await rm(dir, { recursive: true, force: true });
});

describe("single writer lock", () => {
  test.skipIf(process.platform !== "linux")("creates private lock directories, including new parents", async () => {
    const parent = path.join(dir, "private");
    const directory = path.join(parent, "nested");
    locks.push(await acquireLock(directory));
    expect(await Promise.all([parent, directory].map(async (file) => (await stat(file)).mode & 0o777)))
      .toEqual([0o700, 0o700]);
  });

  test.skipIf(process.platform !== "linux")("does not change an existing lock directory's permissions", async () => {
    const directory = path.join(dir, "existing");
    await mkdir(directory, { mode: 0o750 });
    const before = (await stat(directory)).mode & 0o777;
    locks.push(await acquireLock(directory));
    expect((await stat(directory)).mode & 0o777).toBe(before);
  });

  test("refuses an active writer", async () => {
    locks.push(await acquireLock(dir));
    await expect(acquireLock(dir)).rejects.toThrow("second writer:");
  });

  test("takes over a crashed writer's stale socket", async () => {
    await crashWriter();
    locks.push(await acquireLock(dir));
    await expect(acquireLock(dir)).rejects.toThrow("second writer:");
  });

  test("only one concurrent stale-socket contender becomes a writer", async () => {
    await crashWriter();
    const racers = Array.from({ length: 6 }, () => contender(dir));
    children.push(...racers);
    expect(await Promise.all(racers.map((racer) => racer.status()))).toEqual([
      "ready", "ready", "ready", "ready", "ready", "ready",
    ]);
    for (const racer of racers) racer.child.stdin.write("go\n");
    const statuses = await Promise.all(racers.map((racer) => racer.status()));
    expect(statuses.filter((status) => status === "held")).toHaveLength(1);
    expect(statuses.filter((status) => status === "blocked")).toHaveLength(5);
  });

  test("does not delete an unrelated file at the socket path", async () => {
    const file = path.join(dir, "lock.sock");
    await writeFile(file, "not a socket\n");
    await expect(acquireLock(dir)).rejects.toThrow("not a socket");
    expect(await readFile(file, "utf8")).toBe("not a socket\n");
    await rm(file);
    locks.push(await acquireLock(dir));
  });

  test("idle probe connections do not prevent release", async () => {
    const lock = await acquireLock(dir);
    locks.push(lock);
    const client = connect(path.join(dir, "lock.sock"));
    try {
      await new Promise<void>((resolve, reject) => {
        client.once("connect", resolve);
        client.once("error", reject);
      });
      await lock.release();
      locks.push(await acquireLock(dir));
    } finally {
      client.destroy();
    }
  });

  test("releasing an old handle never removes its successor", async () => {
    for (let round = 0; round < 10; round++) {
      const old = await acquireLock(dir);
      locks.push(old);
      await Promise.all([old.release(), old.release()]);
      const successor = await acquireLock(dir);
      locks.push(successor);
      await old.release();
      await expect(acquireLock(dir)).rejects.toThrow("second writer:");
      await successor.release();
    }
  });

  test("all release callers wait for the same completed release", async () => {
    const lock = await acquireLock(dir);
    locks.push(lock);
    let finished = false;
    const first = lock.release().then(() => {
      finished = true;
    });
    await lock.release();
    expect(finished).toBe(true);
    await first;
    const next = await acquireLock(dir);
    locks.push(next);
  });
});
