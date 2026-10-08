import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { type LogMessage } from "../src/constants";
import { dayFile, loadAll, openLog } from "../src/storage/log";
import { loadAllNodes, saveNode } from "../src/storage/tree-store";

let base: string;
beforeEach(async () => {
  base = await mkdtemp("/tmp/opencode/optchat-storage-");
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("durable log writer", () => {
  test("parallel appends keep unique IDs and the same messages array", async () => {
    const writer = await openLog(base, "global");
    const messages = writer.messages;
    const date = "2026-10-06T12:00:00.000Z";
    const added = await Promise.all([
      writer.append("user", "🙂é\n", date),
      writer.append("talk", "second", date),
      writer.append("tool", "third", date),
      writer.append("echo", "fourth", date),
    ]);
    expect(added.map((message) => message.i)).toEqual([0, 1, 2, 3]);
    expect(added[0]!.size).toBe(13);
    expect(writer.messages).toBe(messages);
    expect(messages).toEqual(added);
    expect(await loadAll(base, "global")).toEqual(added);
    const reopened = await openLog(base, "global");
    expect((await reopened.append("note", "next", date)).i).toBe(4);
    expect(reopened.messages).toHaveLength(5);
  });

  test("reopens a torn tail without joining the next record to it", async () => {
    const date = "2026-10-06T12:00:00.000Z";
    const file = dayFile(base, "global", new Date().toISOString());
    await mkdir(path.dirname(file), { recursive: true });
    const kept: LogMessage = { i: 0, kind: "user", text: "kept", size: 10, date };
    const original = JSON.stringify(kept) + '\n{"i":1';
    await writeFile(file, original);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const writer = await openLog(base, "global");
      expect(writer.messages).toEqual([kept]);
      const added = await writer.append("talk", "after", date);
      expect(added.i).toBe(1);
      expect(await readFile(file, "utf8")).toBe(original + "\n" + JSON.stringify(added) + "\n");
      expect(await loadAll(base, "global")).toEqual([kept, added]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("keeps permanent IDs and reserves IDs from malformed records", async () => {
    const date = "2026-10-06T12:00:00.000Z";
    const file = dayFile(base, "global", new Date().toISOString());
    await mkdir(path.dirname(file), { recursive: true });
    const zero: LogMessage = { i: 0, kind: "user", text: "zero", size: 10, date };
    const three: LogMessage = { i: 3, kind: "talk", text: "three", size: 11, date };
    const original = [
      three, zero,
      { i: 5, kind: "user", text: "wrong size", size: 1, date },
      { i: 3, kind: "note", text: "duplicate", size: 15, date },
      { i: -1, kind: "user", text: "negative", size: 14, date },
      null,
    ].map((record) => JSON.stringify(record)).join("\n") + "\n";
    await writeFile(file, original);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const writer = await openLog(base, "global");
      expect(writer.messages).toEqual([zero, three]);
      expect((await writer.append("note", "next", date)).i).toBe(6);
      expect((await loadAll(base, "global")).map((message) => message.i)).toEqual([0, 3, 6]);
      expect((await readFile(file, "utf8")).startsWith(original)).toBe(true);
      expect(warn.mock.calls.some(([message]) => String(message).includes("gap"))).toBe(true);
      expect(warn.mock.calls.some(([message]) => String(message).includes("duplicate"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("exposes trailing reserved IDs and advances nextId only after durable append", async () => {
    const date = "2026-10-06T12:00:00.000Z";
    const file = dayFile(base, "global", new Date().toISOString());
    await mkdir(path.dirname(file), { recursive: true });
    const kept: LogMessage = { i: 0, kind: "user", text: "kept", size: 10, date };
    await writeFile(file, [
      kept, { i: 1, kind: "user", text: "bad size", size: 0, date },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const writer = await openLog(base, "global");
      expect(writer.messages).toEqual([kept]);
      expect(writer.nextId).toBe(2);
      const pending = writer.append("talk", "next", date);
      expect(writer.nextId).toBe(2);
      const added = await pending;
      expect(added.i).toBe(2);
      expect(writer.nextId).toBe(3);
      expect(await loadAll(base, "global")).toEqual([kept, added]);
      expect((await openLog(base, "global")).nextId).toBe(3);
    } finally {
      warn.mockRestore();
    }
  });

  test("rejects invalid dates without poisoning the next append", async () => {
    const writer = await openLog(base, "global");
    await expect(writer.append("user", "bad", "../../escape")).rejects.toThrow("date");
    expect(writer.messages).toEqual([]);
    expect((await writer.append("user", "valid", "2026-10-06T12:00:00Z")).i).toBe(0);
  });

  test("preserves a complete final record that lacks its newline", async () => {
    const date = "2026-10-06T12:00:00.000Z";
    const file = dayFile(base, "global", new Date().toISOString());
    await mkdir(path.dirname(file), { recursive: true });
    const kept: LogMessage = { i: 0, kind: "user", text: "kept", size: 10, date };
    const original = JSON.stringify(kept);
    await writeFile(file, original);
    const writer = await openLog(base, "global");
    expect(writer.messages).toEqual([kept]);
    expect(await readFile(file, "utf8")).toBe(original + "\n");
    expect((await writer.append("talk", "next", date)).i).toBe(1);
    expect((await loadAll(base, "global")).map((message) => message.i)).toEqual([0, 1]);
  });

  test("blocks after failed fsync and recovers a possibly written ID only on reopen", async () => {
    const writer = await openLog(base, "global");
    const date = "2026-10-06T12:00:00.000Z";
    const file = dayFile(base, "global", new Date().toISOString());
    await mkdir(path.dirname(file), { recursive: true });
    // The device accepts the complete write but rejects fsync, without a mocked filesystem.
    await symlink("/dev/null", file);
    await expect(writer.append("user", "written", date)).rejects.toMatchObject({ code: "EINVAL" });
    expect(writer.messages).toEqual([]);
    await rm(file);
    // A failed fsync can leave a complete record. Reopen must reserve that ID.
    const possible: LogMessage = { i: 0, kind: "user", text: "written", size: 13, date };
    const original = JSON.stringify(possible) + "\n";
    await writeFile(file, original);
    await expect(writer.append("user", "must not reuse ID", date)).rejects.toMatchObject({ code: "EINVAL" });
    expect(await readFile(file, "utf8")).toBe(original);
    const reopened = await openLog(base, "global");
    expect(reopened.messages).toEqual([possible]);
    expect((await reopened.append("user", "next", date)).i).toBe(1);
  });

  test("refuses to overflow the largest known safe ID", async () => {
    const date = "2026-10-06T12:00:00.000Z";
    const file = dayFile(base, "global", new Date().toISOString());
    await mkdir(path.dirname(file), { recursive: true });
    const original = JSON.stringify({ i: Number.MAX_SAFE_INTEGER, kind: "user", text: "end", size: 9, date }) + "\n";
    await writeFile(file, original);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const writer = await openLog(base, "global");
      await expect(writer.append("user", "overflow", date)).rejects.toThrow("IDs exhausted");
      expect(await readFile(file, "utf8")).toBe(original);
    } finally {
      warn.mockRestore();
    }
  });

  test.each(["", ".", "..", "../outside", "/outside", "a/b", "a\\b", "a\0b"])(
    "rejects unsafe scope %s", async (scope) => {
      await expect(openLog(base, scope)).rejects.toThrow("scope");
      await expect(loadAll(base, scope)).rejects.toThrow("scope");
      await expect(loadAllNodes(base, scope)).rejects.toThrow("scope");
      await expect(saveNode(base, scope, { l: 0, i: 0, text: "ok", size: 2 })).rejects.toThrow("scope");
    },
  );

  test("splits both streams by local day, not UTC day", async () => {
    const logModule = path.resolve(import.meta.dir, "../src/storage/log.ts");
    const treeModule = path.resolve(import.meta.dir, "../src/storage/tree-store.ts");
    const child = Bun.spawn([process.execPath, "--eval", `
      import { setSystemTime } from "bun:test";
      import { readdir } from "node:fs/promises";
      import { openLog } from ${JSON.stringify(logModule)};
      import { saveNode } from ${JSON.stringify(treeModule)};
      const base = ${JSON.stringify(base)};
      const date = "2021-02-03T15:04:05.000Z";
      setSystemTime(new Date("2026-10-07T00:30:00.000Z"));
      const writer = await openLog(base, "global");
      await writer.append("user", "local", date);
      await saveNode(base, "global", { l: 0, i: 0, text: "local", size: 5 });
      console.log(JSON.stringify([
        await readdir(base + "/chat/global/main"),
        await readdir(base + "/tree/global"),
        writer.messages[0].date,
      ]));
    `], { env: { ...process.env, TZ: "America/Los_Angeles" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      ["2026-10-06.jsonl"], ["2026-10-06.jsonl"], "2021-02-03T15:04:05.000Z",
    ]);
  });
});

describe("durable tree store", () => {
  test("reopens a torn tail before appending a fresh node", async () => {
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const file = path.join(base, "tree", "global", day + ".jsonl");
    await mkdir(path.dirname(file), { recursive: true });
    const kept = { l: 0, i: 0, text: "🙂é", size: 6 };
    const original = JSON.stringify(kept) + '\n{"l":1';
    await writeFile(file, original);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await loadAllNodes(base, "global")).toEqual(new Map([["0:0", kept]]));
      expect(await readFile(file, "utf8")).toBe(original + "\n");
      const added = { l: 0, i: 1, text: "next", size: 4 };
      await saveNode(base, "global", added);
      expect(await loadAllNodes(base, "global")).toEqual(new Map([["0:0", kept], ["0:1", added]]));
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("skips corrupt records and preserves valid multibyte sizes", async () => {
    const file = path.join(base, "tree", "global", "2026-10-06.jsonl");
    await mkdir(path.dirname(file), { recursive: true });
    const valid = { l: 0, i: 2, text: "🙂é", size: 6 };
    const original = [
      { l: -1, i: 0, text: "bad", size: 3 },
      { l: 0, i: -1, text: "bad", size: 3 },
      { l: 53, i: 0, text: "bad", size: 3 },
      { l: 0, i: 0, text: "🙂é", size: 3 },
      null, valid,
    ].map((record) => JSON.stringify(record)).join("\n");
    await writeFile(file, original);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await loadAllNodes(base, "global")).toEqual(new Map([["0:2", valid]]));
      expect(await readFile(file, "utf8")).toBe(original + "\n");
      expect(warn).toHaveBeenCalledTimes(5);
      await expect(saveNode(base, "global", { l: 0, i: 0, text: "🙂é", size: 3 })).rejects.toThrow("node");
    } finally {
      warn.mockRestore();
    }
  });

  test("repairs a torn tail even when saving before any load", async () => {
    const file = path.join(base, "tree", "global", path.basename(dayFile(base, "global", new Date().toISOString())));
    await mkdir(path.dirname(file), { recursive: true });
    const original = '{"l":0';
    await writeFile(file, original);
    const node = { l: 0, i: 0, text: "whole\n🙂", size: 10 };
    await saveNode(base, "global", node);
    expect(await readFile(file, "utf8")).toBe(original + "\n" + JSON.stringify(node) + "\n");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await loadAllNodes(base, "global")).toEqual(new Map([["0:0", node]]));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("parallel node saves remain separate complete records", async () => {
    const nodes = Array.from({ length: 16 }, (_, i) => ({ l: 0, i, text: "🙂é", size: 6 }));
    await Promise.all(nodes.map((node) => saveNode(base, "global", node)));
    const loaded = await loadAllNodes(base, "global");
    expect(loaded.size).toBe(16);
    for (const node of nodes) expect(loaded.get(`0:${node.i}`)).toEqual(node);
  });
});

describe("storage creation privacy", () => {
  test.skipIf(process.platform !== "linux")("creates private chat/tree directories and JSONL files", async () => {
    const writer = await openLog(base, "global");
    await Promise.all([
      writer.append("user", "private"),
      saveNode(base, "global", { l: 0, i: 0, text: "private", size: 7 }),
    ]);
    const chat = path.join(base, "chat", "global", "main");
    const tree = path.join(base, "tree", "global");
    const directories = [
      path.join(base, "chat"), path.dirname(chat), chat,
      path.join(base, "tree"), tree,
    ];
    expect(await Promise.all(directories.map(async (directory) => (await stat(directory)).mode & 0o777)))
      .toEqual([0o700, 0o700, 0o700, 0o700, 0o700]);
    const [chatFiles, treeFiles] = await Promise.all([readdir(chat), readdir(tree)]);
    expect(chatFiles).toHaveLength(1);
    expect(treeFiles).toHaveLength(1);
    const files = [path.join(chat, chatFiles[0]!), path.join(tree, treeFiles[0]!)];
    expect(await Promise.all(files.map(async (file) => (await stat(file)).mode & 0o777)))
      .toEqual([0o600, 0o600]);
  });

  test.skipIf(process.platform !== "linux")("does not change existing directory or JSONL permissions", async () => {
    const date = "2026-10-06T12:00:00.000Z";
    const log = dayFile(base, "global", new Date().toISOString());
    const tree = path.join(base, "tree", "global", path.basename(log));
    await Promise.all([
      mkdir(path.dirname(log), { recursive: true, mode: 0o750 }),
      mkdir(path.dirname(tree), { recursive: true, mode: 0o750 }),
    ]);
    await Promise.all([
      writeFile(log, JSON.stringify({ i: 0, kind: "user", text: "kept", size: 10, date }) + "\n", { mode: 0o640 }),
      writeFile(tree, JSON.stringify({ l: 0, i: 0, text: "kept", size: 4 }) + "\n", { mode: 0o640 }),
    ]);
    const paths = [
      base, path.join(base, "chat"), path.join(base, "chat", "global"), path.dirname(log),
      path.join(base, "tree"), path.dirname(tree), log, tree,
    ];
    const before = await Promise.all(paths.map(async (file) => (await stat(file)).mode & 0o777));
    const writer = await openLog(base, "global");
    await Promise.all([
      writer.append("talk", "next", date),
      saveNode(base, "global", { l: 0, i: 1, text: "next", size: 4 }),
    ]);
    await Promise.all([loadAll(base, "global"), loadAllNodes(base, "global")]);
    expect(await Promise.all(paths.map(async (file) => (await stat(file)).mode & 0o777))).toEqual(before);
  });
});
