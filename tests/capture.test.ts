import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { tempPath } from "./tmp";
import { capture } from "../src/storage/capture";
import { dayFile, loadAll, openLog } from "../src/storage/log";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const fixtures: string[] = [];

async function fixture(): Promise<string> {
  const dir = await mkdtemp(tempPath("optchat-capture-"));
  fixtures.push(dir);
  return dir;
}

afterEach(async () => {
  while (fixtures.length > 0) await rm(fixtures.pop()!, { recursive: true, force: true });
});

describe("capture module", () => {
  test("appends a durable message and returns it", async () => {
    const dir = await fixture();
    const message = await capture(dir, "global", "user", "hello");
    expect(message.i).toBe(0);
    expect(message.kind).toBe("user");
    expect(message.text).toBe("hello");
    expect((await loadAll(dir, "global")).map((m) => m.text)).toEqual(["hello"]);
  });

  test("keeps the exact text, including newlines and surrounding spaces", async () => {
    const dir = await fixture();
    await capture(dir, "global", "user", "  line one\nline two  ");
    const stored = await loadAll(dir, "global");
    expect(stored[0]!.text).toBe("  line one\nline two  ");
    expect(stored[0]!.size).toBe(Buffer.byteLength("user:   line one\nline two  ", "utf8"));
  });

  test("assigns contiguous IDs across repeated captures", async () => {
    const dir = await fixture();
    await capture(dir, "global", "user", "one");
    await capture(dir, "global", "talk", "two");
    await capture(dir, "global", "user", "three");
    expect((await loadAll(dir, "global")).map((m) => m.i)).toEqual([0, 1, 2]);
  });

  test("rejects an unknown kind without writing", async () => {
    const dir = await fixture();
    await expect(capture(dir, "global", "thought" as never, "x")).rejects.toThrow();
    expect(await loadAll(dir, "global")).toEqual([]);
  });

  test("rejects empty text without writing", async () => {
    const dir = await fixture();
    await expect(capture(dir, "global", "user", "")).rejects.toThrow();
    expect(await loadAll(dir, "global")).toEqual([]);
  });

  test("capture is a no-op for reasoning kinds by design", async () => {
    const dir = await fixture();
    for (const kind of ["user", "talk", "note"] as const) {
      await capture(dir, "global", kind, `text for ${kind}`);
    }
    expect((await loadAll(dir, "global")).map((m) => m.kind)).toEqual(["user", "talk", "note"]);
  });
});

describe("capture CLI", () => {
  function run(dir: string, args: string[], stdin = "") {
    const child = Bun.spawn([process.execPath, cli, "--dir", dir, "--capture", ...args], {
      cwd: dir,
      env: { ...process.env, OPENAI_BASE_URL: "", OPENAI_API_KEY: "", OPENAI_MODEL: "" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
    return Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]).then(([code, stdout, stderr]) => ({ code, stdout, stderr }));
  }

  test("captures without any model configuration", async () => {
    const dir = await fixture();
    const out = await run(dir, ["--kind", "user", "--text", "remember this"]);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe("");
    const stored = await loadAll(dir, "global");
    expect(stored.map((m) => m.text)).toEqual(["remember this"]);
  });

  test("reads the message from stdin when --text is absent", async () => {
    const dir = await fixture();
    const out = await run(dir, ["--kind", "user"], "from stdin\nsecond line\n");
    expect(out.code).toBe(0);
    expect((await loadAll(dir, "global"))[0]!.text).toBe("from stdin\nsecond line\n");
  });

  test("an invalid kind exits non-zero and writes nothing", async () => {
    const dir = await fixture();
    const out = await run(dir, ["--kind", "bogus", "--text", "x"]);
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain("kind");
    expect(await loadAll(dir, "global")).toEqual([]);
    expect(existsSync(path.join(dir, "chat"))).toBe(false);
  });

  test("empty input exits non-zero and creates no data", async () => {
    const dir = await fixture();
    const out = await run(dir, ["--kind", "user", "--text", ""]);
    expect(out.code).not.toBe(0);
    expect(existsSync(path.join(dir, "chat"))).toBe(false);
  });

  test("captures land in the same store the reader loads", async () => {
    const dir = await fixture();
    await run(dir, ["--kind", "user", "--text", "first"]);
    await run(dir, ["--kind", "talk", "--text", "second"]);
    const writer = await openLog(dir, "global");
    expect(writer.messages.map((m) => [m.i, m.kind, m.text])).toEqual([
      [0, "user", "first"],
      [1, "talk", "second"],
    ]);
    // And the on-disk record is a complete, parseable line.
    const raw = await readFile(dayFile(dir, "global", writer.messages[0]!.date), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
    expect(JSON.parse(raw.trim().split("\n")[0]!)).toMatchObject({ i: 0, kind: "user" });
  });

  test("does not require the writer lock to be held forever", async () => {
    const dir = await fixture();
    await run(dir, ["--kind", "user", "--text", "released"]);
    expect(existsSync(path.join(dir, "lock.sock"))).toBe(false);
  });

  test("appending to an existing log continues the ID sequence", async () => {
    const dir = await fixture();
    const writer = await openLog(dir, "global");
    await writer.append("note", "preexisting");
    await rm(path.join(dir, "lock.sock"), { force: true });
    const out = await run(dir, ["--kind", "user", "--text", "added later"]);
    expect(out.code).toBe(0);
    expect((await loadAll(dir, "global")).map((m) => m.i)).toEqual([0, 1]);
  });
});
