import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { dayFile, loadAll, openLog } from "../src/storage/log";
import { saveNode } from "../src/storage/tree-store";
import { TURN_SYSTEM } from "../src/turn/loop";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const fixtures: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

async function fixture(): Promise<string> {
  const dir = await mkdtemp("/tmp/opencode/optchat-cli-");
  fixtures.push(dir);
  return dir;
}

function start(dir: string, args: string[] = [], env: Record<string, string> = {}, entry = cli) {
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) if (key.startsWith("GIT_")) delete inherited[key];
  const child = Bun.spawn([process.execPath, entry, "--dir", dir, ...args], {
    cwd: existsSync(dir) ? dir : path.dirname(dir),
    env: {
      ...inherited,
      OPENAI_BASE_URL: "", OPENAI_API_KEY: "", OPENAI_MODEL: "",
      OPENAI_COMPACTOR_MODEL: "",
      TZ: "UTC",
      ...env,
    },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  children.push(child);
  return child;
}

async function result(child: ReturnType<typeof start>) {
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function readUntil(stream: ReadableStream<Uint8Array>, text: string): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`process closed before ${text}`);
      output += decoder.decode(value, { stream: true });
      if (output.includes(text)) return output;
    }
  } finally {
    reader.releaseLock();
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type NativeRequest = {
  messages: Record<string, unknown>[];
  tools?: { type: string; function: { name: string } }[];
};

function provider(respond: (body: NativeRequest) => Response | Promise<Response>) {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (request) => respond(await request.json() as NativeRequest),
  });
  servers.push(server);
  return {
    OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
    OPENAI_API_KEY: "offline-test", OPENAI_MODEL: "offline-actor",
  };
}

function reply(message: Record<string, unknown>): Response {
  return Response.json({ choices: [{ message: { role: "assistant", ...message } }] });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const FIXTURE_GIT_NAME = "optchat-cli-fixture";
const FIXTURE_GIT_EMAIL = `${FIXTURE_GIT_NAME}@users.noreply.github.com`;

/** All commands target an owned fixture. Capture metadata; never print it. */
function git(dir: string, args: string[]): string {
  if (!fixtures.includes(dir)) throw new Error("Git target is not an owned fixture");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: FIXTURE_GIT_NAME, GIT_AUTHOR_EMAIL: FIXTURE_GIT_EMAIL,
    GIT_COMMITTER_NAME: FIXTURE_GIT_NAME, GIT_COMMITTER_EMAIL: FIXTURE_GIT_EMAIL,
  });
  const output = Bun.spawnSync(["git", "-C", dir, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  if (output.exitCode !== 0) throw new Error(`fixture Git ${args[0]} failed`);
  return output.stdout.toString("utf8");
}

function initGit(dir: string): void {
  git(dir, ["init", "--quiet", "--initial-branch=fixture"]);
  git(dir, ["config", "--local", "user.name", FIXTURE_GIT_NAME]);
  git(dir, ["config", "--local", "user.email", FIXTURE_GIT_EMAIL]);
}

describe("offline CLI Git persistence", () => {
  test("explicit --git commits only durable scoped data, not pre-staged unrelated files", async () => {
    const dir = await fixture();
    initGit(dir);
    await writeFile(path.join(dir, "unrelated.txt"), "unrelated fixture\n");
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src/unrelated.ts"), "export const fixture = true;\n");
    git(dir, ["add", "--", "unrelated.txt"]);
    const writer = await openLog(dir, "global");
    await writer.append("note", "seed memory");
    const text = "note: seed memory";
    await saveNode(dir, "global", { l: 0, i: 0, text, size: Buffer.byteLength(text) });
    const env = provider(() => reply({ content: "fixture answer" }));
    const child = start(dir, ["--git"], env);
    child.stdin.write("persist fixture input\n");
    child.stdin.end();
    const output = await result(child);
    expect(output.code).toBe(0);
    expect(output.stderr).toBe("");
    expect(Number(git(dir, ["rev-list", "--all", "--count"]).trim())).toBeGreaterThan(0);
    const files = git(dir, ["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n");
    expect(files.every((file) => /^(chat\/global\/main|tree\/global)\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))).toBe(true);
    expect(files.some((file) => file.startsWith("chat/global/main/"))).toBe(true);
    expect(files.some((file) => file.startsWith("tree/global/"))).toBe(true);
    const chat = files.filter((file) => file.startsWith("chat/")).flatMap((file) =>
      git(dir, ["show", `HEAD:${file}`]).trim().split("\n").map((line) => JSON.parse(line)),
    );
    expect(chat.map((message) => [message.kind, message.text])).toEqual([
      ["note", "seed memory"], ["user", "persist fixture input"], ["talk", "fixture answer"],
    ]);
    const tree = files.filter((file) => file.startsWith("tree/")).flatMap((file) =>
      git(dir, ["show", `HEAD:${file}`]).trim().split("\n").map((line) => JSON.parse(line)),
    );
    expect(tree.some((node) => node.l === 0 && node.i === 0 && node.text === text)).toBe(true);
    for (const file of files) {
      // The final data commit must contain every durable record after drain.
      expect(git(dir, ["show", `HEAD:${file}`]) === await readFile(path.join(dir, file), "utf8")).toBe(true);
    }
    expect(git(dir, ["diff", "--cached", "--name-only"]).trim()).toBe("unrelated.txt");
    const identity = git(dir, ["log", "-1", "--format=%an%n%ae%n%cn%n%ce"]).trim();
    expect(identity === [FIXTURE_GIT_NAME, FIXTURE_GIT_EMAIL, FIXTURE_GIT_NAME, FIXTURE_GIT_EMAIL].join("\n")).toBe(true);
    expect(existsSync(path.join(dir, "lock.sock"))).toBe(false);
  });

  test("a data repository never commits automatically without --git", async () => {
    const dir = await fixture();
    initGit(dir);
    await writeFile(path.join(dir, "unrelated.txt"), "unrelated fixture\n");
    git(dir, ["add", "--", "unrelated.txt"]);
    const child = start(dir, [], provider(() => reply({ content: "fixture answer" })));
    child.stdin.write("persist without committing\n");
    child.stdin.end();
    const output = await result(child);
    expect(output.code).toBe(0);
    expect(output.stderr).toBe("");
    expect(git(dir, ["rev-list", "--all", "--count"]).trim()).toBe("0");
    expect(git(dir, ["diff", "--cached", "--name-only"]).trim()).toBe("unrelated.txt");
    expect((await loadAll(dir, "global")).map((message) => [message.kind, message.text])).toEqual([
      ["user", "persist without committing"], ["talk", "fixture answer"],
    ]);
    expect(existsSync(path.join(dir, "lock.sock"))).toBe(false);
  });

  test("refuses source-checkout commits in an isolated copied source repository", async () => {
    const dir = await fixture();
    const source = path.resolve(import.meta.dir, "..");
    await cp(path.join(source, "src"), path.join(dir, "src"), { recursive: true });
    await cp(path.join(source, "package.json"), path.join(dir, "package.json"));
    initGit(dir);
    git(dir, ["add", "--", "src", "package.json"]);
    git(dir, ["commit", "--quiet", "-m", "fixture source baseline"]);
    const beforeHead = git(dir, ["rev-parse", "HEAD"]).trim();
    const copiedCli = path.join(dir, "src/cli.ts");
    const beforeCli = await readFile(copiedCli, "utf8");
    const child = start(dir, ["--git"], provider(() => reply({ content: "fixture answer" })), copiedCli);
    child.stdin.write("do not commit source\n");
    child.stdin.end();
    const output = await result(child);
    expect(output.code).toBe(0);
    expect(output.stderr).toContain("refusing to commit the source checkout");
    expect(git(dir, ["rev-parse", "HEAD"]).trim() === beforeHead).toBe(true);
    expect(git(dir, ["diff", "--cached", "--name-only"]).trim()).toBe("");
    expect(await readFile(copiedCli, "utf8") === beforeCli).toBe(true);
    expect((await loadAll(dir, "global")).map((message) => message.kind)).toEqual(["user", "talk"]);
    expect(existsSync(path.join(dir, "lock.sock"))).toBe(false);
  });
});

describe("CLI startup", () => {
  test("help exits before creating data or acquiring a lock", async () => {
    const base = await fixture();
    const dir = path.join(base, "unused");
    const child = start(dir, ["--help"]);
    child.stdin.end();
    const output = await result(child);
    expect(output.code).toBe(0);
    expect(output.stdout).toContain("Usage: optchat");
    expect(output.stdout).toContain("--instructions");
    expect(existsSync(dir)).toBe(false);
  });

  test("missing model configuration fails without fake replies or data", async () => {
    const base = await fixture();
    const dir = path.join(base, "unused");
    const child = start(dir);
    child.stdin.write("hello\n");
    child.stdin.end();
    const output = await result(child);
    expect(output.code).toBe(1);
    expect(output.stderr).toContain("OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL are required");
    expect(output.stdout).not.toContain("MockAdapter");
    expect(output.stdout).not.toContain("talk: ok");
    expect(existsSync(dir)).toBe(false);
  });

  test("rejects non-global scope before creating data", async () => {
    const base = await fixture();
    const dir = path.join(base, "unused");
    const child = start(dir, ["--scope", "../other", "--print-view"]);
    child.stdin.end();
    const output = await result(child);
    expect(output.code).toBe(1);
    expect(output.stderr).toContain("only scope global is supported");
    expect(existsSync(dir)).toBe(false);
  });

  test("print-view works without model configuration and releases the lock", async () => {
    const dir = await fixture();
    const child = start(dir, ["--print-view"]);
    child.stdin.end();
    const output = await result(child);
    expect(output.code).toBe(0);
    expect(output.stdout).toContain("<chat>\n</chat>");
    expect(output.stdout).not.toContain("MockAdapter");
    expect(existsSync(path.join(dir, "lock.sock"))).toBe(false);
  });

  test("print-view ignores invalid provider settings", async () => {
    const dir = await fixture();
    const child = start(dir, ["--print-view"], {
      OPENAI_BASE_URL: "not-a-url", OPENAI_API_KEY: "offline-test", OPENAI_MODEL: "offline-actor",
    });
    child.stdin.end();
    const output = await result(child);
    expect(output.code).toBe(0);
    expect(output.stderr).toBe("");
  });

  test("invalid configuration and missing explicit instructions fail before locking", async () => {
    const base = await fixture();
    const dir = path.join(base, "unused");
    const invalid = start(dir, [], {
      OPENAI_BASE_URL: "not-a-url", OPENAI_API_KEY: "offline-test", OPENAI_MODEL: "offline-actor",
    });
    invalid.stdin.end();
    expect((await result(invalid)).stderr).toContain("invalid OPENAI_BASE_URL");
    expect(existsSync(dir)).toBe(false);
    const missing = start(dir, ["--instructions", path.join(base, "missing.md")], {
      OPENAI_BASE_URL: "http://127.0.0.1:1/v1", OPENAI_API_KEY: "offline-test", OPENAI_MODEL: "offline-actor",
    });
    missing.stdin.end();
    const output = await result(missing);
    expect(output.code).toBe(1);
    expect(output.stderr).toContain("instructions:");
    expect(existsSync(dir)).toBe(false);
  });

  test("stored ID gaps fail clearly instead of misaddressing the view", async () => {
    const dir = await fixture();
    const writer = await openLog(dir, "global");
    const prefix = await writer.append("note", "prefix");
    expect(prefix.i).toBe(0);
    await appendFile(dayFile(dir, "global", prefix.date), JSON.stringify({
      i: 2, kind: "user", text: "later", size: Buffer.byteLength("user: later"), date: prefix.date,
    }) + "\n");
    const child = start(dir, ["--print-view"]);
    child.stdin.end();
    const output = await result(child);
    expect(output.code).toBe(1);
    expect(output.stderr).toContain("chat log ID gap");
    expect(existsSync(path.join(dir, "lock.sock"))).toBe(false);
  });
});

describe("offline native CLI", () => {
  test("retains tool history, accepts boundary input, starts fresh, and loads instructions once", async () => {
    const dir = await fixture();
    const instructions = path.join(dir, "instructions.md");
    await writeFile(instructions, "  Original instructions.\nKeep this wording.\n");
    const seen: NativeRequest[] = [];
    const compactions: NativeRequest[] = [];
    let child!: ReturnType<typeof start>;
    const env = provider(async (body) => {
      if (!body.tools) {
        compactions.push(body);
        return reply({ content: "user: short memory; talk: answered" });
      }
      seen.push(body);
      if (seen.length === 1) {
        await writeFile(instructions, "CHANGED AFTER STARTUP");
        child.stdin.write("  correction at tool boundary  \n");
        await child.stdin.flush();
        return reply({
          content: "", reasoning_content: "transient internal reasoning",
          tool_calls: [
            { id: "zoom_call", type: "function", function: { name: "zoom", arguments: '{"id":0,"n":1}' } },
            { id: "date_call", type: "function", function: { name: "date", arguments: '{"id":0}' } },
          ],
        });
      }
      if (seen.length === 2) {
        child.stdin.write("fresh next turn\n");
        child.stdin.end();
        return reply({ content: "first answer" });
      }
      return reply({ content: "second answer" });
    });
    child = start(dir, [], env);
    child.stdin.write("  original question  \n");
    const output = await result(child);
    expect(output.code).toBe(0);
    expect(output.stderr).toBe("");
    expect(seen).toHaveLength(3);
    expect(seen[0]!.tools!.map((tool) => tool.function.name)).toEqual(["zoom", "date"]);
    const system = seen[0]!.messages[0]!.content;
    expect(system).toBe(TURN_SYSTEM + "\n\n  Original instructions.\nKeep this wording.\n");
    // VIEW_DOC names the display placeholder. It must never become a memory row.
    expect(system).toContain('shows as "(not summarized yet: zoom it)"');
    for (const request of seen) {
      expect(request.messages[0]!.content).toBe(system);
      expect(JSON.stringify(request.tools)).toBe(JSON.stringify(seen[0]!.tools));
      expect(JSON.stringify(request.messages.slice(1))).not.toContain("(not summarized yet: zoom it)");
    }
    expect(seen[0]!.messages[1]!.content).toEqual([
      { type: "text", text: "<chat>\n</chat>" },
      { type: "text", text: "  original question  " },
    ]);
    expect(seen[1]!.messages[1]).toEqual(seen[0]!.messages[1]);
    expect(seen[1]!.messages[2]!.reasoning_content).toBe("transient internal reasoning");
    const toolResults = seen[1]!.messages.filter((message) => message.role === "tool");
    expect(toolResults.map((message) => message.tool_call_id)).toEqual(["zoom_call", "date_call"]);
    expect(toolResults[0]!.content).toContain("user:   original question  ");
    expect(seen[1]!.messages.at(-1)).toEqual({ role: "user", content: "  correction at tool boundary  " });
    expect(seen[2]!.messages).toHaveLength(2);
    expect(JSON.stringify(seen[2]!.messages[1])).toContain("fresh next turn");
    const log = await loadAll(dir, "global");
    expect(log.filter((message) => message.kind === "user").map((message) => message.text)).toEqual([
      "  original question  ", "  correction at tool boundary  ", "fresh next turn",
    ]);
    expect(log.filter((message) => message.kind === "echo").map((message) => message.text)).toEqual([
      toolResults[0]!.content as string, `${log[0]!.date.slice(0, 10)} ${log[0]!.date.slice(11, 19)}`,
    ]);
    expect(JSON.stringify(log)).not.toContain("transient internal reasoning");
    expect(output.stdout).toContain("thought: transient internal reasoning");
    for (const message of log) {
      expect(message.size).toBe(Buffer.byteLength(`${message.kind}: ${message.text}`));
    }
    for (const request of compactions) {
      expect(JSON.stringify(request.messages[1]!.content)).not.toMatch(/\d+\+\d+\|/);
      expect(JSON.stringify(request.messages)).not.toContain("(not summarized yet: zoom it)");
    }
    expect(existsSync(path.join(dir, "lock.sock"))).toBe(false);
  });

  test("cancel preserves queued input exactly once, refuses another writer, and reopens", async () => {
    const dir = await fixture();
    const asked = deferred<void>();
    const held = deferred<Response>();
    const env = provider((body) => {
      if (!body.tools) return reply({ content: "short memory" });
      asked.resolve();
      return held.promise;
    });
    const child = start(dir, [], env);
    child.stdin.write("initial question\n");
    await asked.promise;

    const second = start(dir, ["--print-view"]);
    second.stdin.end();
    const refused = await result(second);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("second writer: lock already held");

    child.stdin.write("  queued correction  \n\tsecond queued item\n/cancel\n/exit\n");
    child.stdin.end();
    const output = await result(child);
    held.resolve(reply({ content: "late answer" }));
    expect(output.code).toBe(0);
    const log = await loadAll(dir, "global");
    expect(log.map((message) => [message.kind, message.text])).toEqual([
      ["user", "initial question"], ["user", "  queued correction  "], ["user", "\tsecond queued item"],
    ]);
    expect(log.map((message) => message.i)).toEqual([0, 1, 2]);
    expect(existsSync(path.join(dir, "lock.sock"))).toBe(false);

    const reopened = start(dir, ["--print-view"]);
    reopened.stdin.end();
    const printed = await result(reopened);
    expect(printed.code).toBe(0);
    expect(printed.stdout).toContain("initial question");
    expect(existsSync(path.join(dir, "lock.sock"))).toBe(false);
  });

  test("SIGINT cancels a provider request and waits for lock release", async () => {
    const dir = await fixture();
    const asked = deferred<void>();
    const held = deferred<Response>();
    const env = provider((body) => {
      if (!body.tools) return reply({ content: "short memory" });
      asked.resolve();
      return held.promise;
    });
    const child = start(dir, [], env);
    child.stdin.write("unanswered but durable\n");
    await asked.promise;
    child.kill("SIGINT");
    const output = await result(child);
    held.resolve(reply({ content: "late answer" }));
    expect(output.code).toBe(0);
    expect((await loadAll(dir, "global")).map((message) => message.text)).toEqual(["unanswered but durable"]);
    expect(existsSync(path.join(dir, "lock.sock"))).toBe(false);
  });

  test("provider failure preserves accepted input without fake answers", async () => {
    const dir = await fixture();
    let child!: ReturnType<typeof start>;
    const env = provider((body) => {
      if (!body.tools) return reply({ content: "short memory" });
      child.stdin.write("  still unanswered  \n");
      child.stdin.end();
      return new Response("offline failure", { status: 500 });
    });
    child = start(dir, [], env);
    child.stdin.write("first question\n");
    const output = await result(child);
    expect(output.stderr).toContain("turn failed: model http 500");
    expect(output.stdout).not.toContain("talk: ok");
    expect((await loadAll(dir, "global")).map((message) => [message.kind, message.text])).toEqual([
      ["user", "first question"], ["user", "  still unanswered  "],
    ]);
    expect(existsSync(path.join(dir, "lock.sock"))).toBe(false);
  });

  test.each(["failure", "cancel"])("%s after taking boundary input never loses or double-logs it", async (mode) => {
    const dir = await fixture();
    const followup = deferred<NativeRequest>();
    const held = deferred<Response>();
    let actorCalls = 0;
    let child!: ReturnType<typeof start>;
    const env = provider(async (body) => {
      if (!body.tools) return reply({ content: "short memory" });
      actorCalls++;
      if (actorCalls === 1) {
        child.stdin.write("  accepted at the tool boundary  \n");
        await child.stdin.flush();
        return reply({ content: "", tool_calls: [{
          id: "pending_zoom", type: "function", function: { name: "zoom", arguments: '{"id":0,"n":1}' },
        }] });
      }
      followup.resolve(body);
      if (mode === "failure") {
        child.stdin.end();
        return new Response("offline follow-up failure", { status: 500 });
      }
      return held.promise;
    });
    child = start(dir, [], env);
    child.stdin.write("first question\n");
    const secondRequest = await followup.promise;
    expect(secondRequest.messages.at(-1)).toEqual({ role: "user", content: "  accepted at the tool boundary  " });
    if (mode === "cancel") {
      child.stdin.write("/cancel\n/exit\n");
      child.stdin.end();
    }
    const output = await result(child);
    held.resolve(reply({ content: "late answer" }));
    expect(output.code).toBe(0);
    expect(actorCalls).toBe(2);
    const log = await loadAll(dir, "global");
    expect(log.filter((message) => message.kind === "user").map((message) => message.text)).toEqual([
      "first question", "  accepted at the tool boundary  ",
    ]);
    expect(log.map((message) => message.i)).toEqual([0, 1, 2, 3]);
    expect(existsSync(path.join(dir, "lock.sock"))).toBe(false);
  });

  test("a saved older parent never splits an already merged live view part", async () => {
    const dir = await fixture();
    const writer = await openLog(dir, "global");
    for (let i = 0; i < 4; i++) {
      const text = String.fromCharCode(65 + i).repeat(50_000);
      await writer.append("note", text);
      await saveNode(dir, "global", { l: 0, i, text, size: 50_000 });
    }
    await saveNode(dir, "global", { l: 1, i: 1, text: "late pair", size: 9 });
    const rootAsked = deferred<void>();
    const seen: NativeRequest[] = [];
    let compactions = 0;
    let child!: ReturnType<typeof start>;
    const env = provider(async (body) => {
      if (!body.tools) {
        compactions++;
        if (compactions === 1) return reply({ content: "P".repeat(512) });
        // A root request proves the older parent was saved and refitted.
        rootAsked.resolve();
        return reply({ content: "older root" });
      }
      seen.push(body);
      if (seen.length === 1) {
        await rootAsked.promise;
        child.stdin.write("next question\n");
        child.stdin.end();
      }
      return reply({ content: "answer" });
    });
    child = start(dir, [], env);
    child.stdin.write("first question\n");
    const output = await result(child);
    expect(output.code).toBe(0);
    expect(output.stderr).toBe("");
    expect(seen).toHaveLength(2);
    const nextMemory = JSON.stringify(seen[1]!.messages[1]!.content);
    expect(nextMemory).toContain("2+2|late pair");
    expect(nextMemory).not.toContain("2+1|");
    expect(nextMemory).not.toContain("3+1|");
    expect(nextMemory).not.toContain("(not summarized yet: zoom it)");
    expect(existsSync(path.join(dir, "lock.sock"))).toBe(false);
  });

  test("cancelling settle aborts delayed compactor retries and preserves input", async () => {
    const dir = await fixture();
    const writer = await openLog(dir, "global");
    await writer.append("note", "historical source ".repeat(50));
    let child!: ReturnType<typeof start>;
    let actorCalls = 0;
    let compactions = 0;
    const env = provider((body) => {
      if (body.tools) {
        actorCalls++;
        return reply({ content: "must not answer an unbuilt view" });
      }
      compactions++;
      child.stdin.write("  queued while settling  \n/cancel\n/exit\n");
      child.stdin.end();
      return new Response("offline compactor failure", { status: 500 });
    });
    child = start(dir, [], env);
    child.stdin.write("first pending prompt\n");
    const output = await result(child);
    expect(output.code).toBe(0);
    expect(actorCalls).toBe(0);
    expect(compactions).toBe(1);
    expect((await loadAll(dir, "global")).filter((message) => message.kind === "user").map((message) => message.text)).toEqual([
      "first pending prompt", "  queued while settling  ",
    ]);
    expect(existsSync(path.join(dir, "lock.sock"))).toBe(false);
  }, 5000);

  test("normal exit keeps unsettled retries active until explicit cancellation", async () => {
    const dir = await fixture();
    const writer = await openLog(dir, "global");
    await writer.append("note", "historical source ".repeat(50));
    let child!: ReturnType<typeof start>;
    let actorCalls = 0;
    const env = provider((body) => {
      if (body.tools) {
        actorCalls++;
        return reply({ content: "must not answer" });
      }
      child.stdin.write("/exit\n");
      child.stdin.end();
      return new Response("offline compactor failure", { status: 500 });
    });
    child = start(dir, [], env);
    child.stdin.write("waiting for memory\n");
    await readUntil(child.stderr, "compactor 0:0 failed");
    expect(child.exitCode).toBeNull();
    expect(actorCalls).toBe(0);
    const second = start(dir, ["--print-view"]);
    second.stdin.end();
    expect((await result(second)).stderr).toContain("second writer: lock already held");
    child.kill("SIGINT");
    expect(await child.exited).toBe(0);
    expect((await loadAll(dir, "global")).filter((message) => message.kind === "user").map((message) => message.text)).toEqual([
      "waiting for memory",
    ]);
    expect(existsSync(path.join(dir, "lock.sock"))).toBe(false);
  }, 5000);

  test("a reserved tail ID rejects startup before appending input or calling a model", async () => {
    const dir = await fixture();
    const writer = await openLog(dir, "global");
    const prefix = await writer.append("note", "prefix");
    expect(prefix.i).toBe(0);
    // The loader rejects the invalid date but reserves the parsed ID.
    await appendFile(dayFile(dir, "global", prefix.date), JSON.stringify({
      i: 7, kind: "note", text: "invalid record", size: Buffer.byteLength("note: invalid record"), date: "invalid date",
    }) + "\n");
    const before = await readFile(dayFile(dir, "global", prefix.date), "utf8");
    let modelCalls = 0;
    const env = provider(() => {
      modelCalls++;
      return reply({ content: "must not answer" });
    });
    const child = start(dir, [], env);
    child.stdin.write("input rejected before startup\n");
    child.stdin.end();
    const output = await result(child);
    expect(output.code).toBe(1);
    expect(output.stderr).toContain("chat log ID gap");
    expect(modelCalls).toBe(0);
    const log = await loadAll(dir, "global");
    expect(log.map((message) => message.i)).toEqual([0]);
    expect(log.filter((message) => message.kind === "user")).toEqual([]);
    expect(await readFile(dayFile(dir, "global", prefix.date), "utf8")).toBe(before);
    expect(existsSync(path.join(dir, "lock.sock"))).toBe(false);
  });
});
