#!/usr/bin/env bun
/**
 * Plain terminal CLI: one endless chat, no TUI redraws, no cursor games.
 *
 * Usage: optchat --scope global --dir ./data [--print-view]
 *   --print-view  print the current view and exit (no input loop)
 *
 * On start the view is printed once. Then each stdin line is queued and a
 * turn is run. Lines arriving during a turn reach the native actor between
 * completed tool calls, or start a fresh turn after it finishes.
 *
 * Model: OPENAI_BASE_URL + OPENAI_API_KEY + OPENAI_MODEL (chat completions,
 * plain fetch). Interactive mode requires all three settings. --print-view
 * needs no model configuration.
 */
import * as readline from "node:readline";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { SCOPES, byteLen } from "./constants";
import type { Kind, TreeNode } from "./constants";
import { OpenAICompat, readEnv, redactUrl } from "./model/openai-compat";
import { OpenAIResponses, listModels } from "./model/openai-responses";
import { login, refreshIfDue } from "./auth/login";
import { loadCredentials } from "./auth/credentials";
import { openLog } from "./storage/log";
import { capture } from "./storage/capture";
import { acquireLock } from "./storage/lock";
import type { LockHandle } from "./storage/lock";
import { loadAllNodes, saveNode } from "./storage/tree-store";
import { nodeKey } from "./tree/address";
import { appendAndFit, fit, foldAll } from "./view/fold";
import type { Part } from "./view/fold";
import { renderView } from "./view/render";
import { pumpOnce } from "./compactor/pump";
import { runTurn, settle, TURN_SYSTEM } from "./turn/loop";
import type { TurnContext } from "./turn/loop";
import { zoom } from "./tools/zoom";
import type { ZoomStore } from "./tools/zoom";
import { lookup } from "./tools/date";
import { TOOL_DEFINITIONS } from "./tools/definitions";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value !== undefined && !value.startsWith("--") ? value : fallback;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: optchat [options]

--scope KEY        Memory scope. Only global is supported today.
--dir PATH         Data directory (default ./data).
--print-view       Print stored memory and exit without a model.
--capture          Append one message and exit. No model needed.
--kind KIND        With --capture: user, talk, tool, echo or note (default user).
--text TEXT        With --capture: the message. Without it, the message is read from stdin.
--login            Sign in with ChatGPT and store the credential, then exit.
--models           List model slugs the signed-in plan can run, then exit.
--plan             Use the signed-in ChatGPT plan instead of an API key.
--model SLUG       With --plan: which model to run.
--auth-dir PATH    Where credentials live (default ~/.config/optchat/auth).
--instructions F   Read F once at startup (default <dir>/instructions.md, if present).
--git              Commit chat/tree data after each turn in a separate data repository.
--help             Show this help without creating data or taking a lock.

Interactive mode requires OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL,
or --plan with a prior --login and --model.
/cancel cancels the current turn. /exit or /quit drains input and exits.
Ctrl+C cancels work, preserves queued input, and exits.`);
  process.exit(0);
}

const scope = arg("--scope", SCOPES[0]);
const dir = arg("--dir", "./data");
const printView = process.argv.includes("--print-view");
const gitPersistence = process.argv.includes("--git");
const planMode = process.argv.includes("--plan");
const authDir = arg("--auth-dir", path.join(homedir(), ".config", "optchat", "auth"));
const planModel = arg("--model", "");

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const PLACEHOLDER = "(not summarized yet: zoom it)"; // render.ts placeholder body

if (!(SCOPES as readonly string[]).includes(scope)) {
  console.error("optchat: only scope global is supported");
  process.exit(1);
}

// --capture: deterministic ingest for hooks in other tools. Runs before any
// model configuration is read, so capture never depends on a provider or on
// the model choosing to remember.
if (process.argv.includes("--capture")) {
  const kind = arg("--kind", "user") as Kind;
  let text: string;
  if (process.argv.includes("--text")) {
    text = arg("--text", "");
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
    text = Buffer.concat(chunks).toString("utf8");
  }
  try {
    const message = await capture(dir, scope, kind, text);
    console.log(message.i);
    process.exit(0);
  } catch (err) {
    console.error(`optchat: ${errText(err)}`);
    process.exit(1);
  }
}

// --login: Sign in with ChatGPT. Runs before any model configuration is read
// and never takes the memory lock, since it writes only to the auth directory.
if (process.argv.includes("--login")) {
  try {
    await login({
      authDir,
      agentName: "optchat",
      onAuthorizeUrl: (url) => {
        // The authorization URL carries no secret: the PKCE verifier stays
        // local and only the public challenge travels.
        console.log("optchat: open this to sign in:");
        console.log(url);
      },
    });
    // No account identifier is printed: credentials are sensitive and the
    // terminal may be logged or shared.
    console.log(`optchat: signed in; credential stored under ${authDir}`);
  } catch (err) {
    console.error(`optchat: ${errText(err)}`);
    process.exit(1);
  }
  process.exit(0);
}

// --models: what the signed-in plan can actually run. Prints slugs, which are
// what --model takes. No account identifier is printed.
if (process.argv.includes("--models")) {
  try {
    const records = await loadCredentials(authDir);
    const record = records[0];
    if (record === undefined) {
      throw new Error("optchat: no ChatGPT credential; run optchat --login first");
    }
    const refreshed = await refreshIfDue(record, { authDir });
    const token = (refreshed ?? record).access_token;
    for (const model of await listModels(async () => token)) {
      console.log(`${model.slug}\t${model.displayName}`);
    }
    process.exit(0);
  } catch (err) {
    console.error(`optchat: ${errText(err)}`);
    process.exit(1);
  }
}

let env: ReturnType<typeof readEnv> = null;
try {
  if (!printView && !planMode) env = readEnv();
} catch (err) {
  console.error(`optchat: ${errText(err)}`);
  process.exit(1);
}
if (planMode) {
  // Plan usage carries no API key. The model comes from --model or OPENAI_MODEL.
  if (!printView && planModel === "" && !process.env["OPENAI_MODEL"]?.trim()) {
    console.error("optchat: --plan needs --model or OPENAI_MODEL");
    process.exit(1);
  }
} else if (!printView && env === null) {
  console.error("optchat: OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL are required for interactive mode");
  process.exit(1);
}

let system = TURN_SYSTEM;
if (!printView) {
  const instructionsFile = arg("--instructions", path.join(dir, "instructions.md"));
  try {
    if (process.argv.includes("--instructions") || existsSync(instructionsFile)) {
      const instructions = await readFile(instructionsFile, "utf8");
      system += "\n\n" + instructions;
    }
  } catch (err) {
    console.error(`optchat: instructions: ${errText(err)}`);
    process.exit(1);
  }
}

// --- start: single writer, load log + tree, fold the view from 0 ------------
let lock: LockHandle;
try {
  lock = await acquireLock(dir);
} catch (err) {
  console.error(`optchat: ${errText(err)}`);
  process.exit(1);
}

try {
const writer = await openLog(dir, scope);
const messages = writer.messages;
if (messages.some((message, i) => message.i !== i) || writer.nextId !== messages.length) {
  throw new Error("chat log ID gap: restore missing records before using memory");
}
const nodes = await loadAllNodes(dir, scope);

const isBuilt = (l: number, i: number): boolean => nodes.has(nodeKey(l, i));

/** Render size of a part: stored summary bytes, or the placeholder row. */
function sizeOf(l: number, i: number): number {
  const node = nodes.get(nodeKey(l, i));
  return node === undefined ? byteLen(PLACEHOLDER) : node.size;
}

function getText(part: Part): string | undefined {
  return nodes.get(nodeKey(part.l, part.i))?.text;
}

let view: Part[] = foldAll(messages.length, sizeOf, isBuilt);

function allBuilt(): boolean {
  return view.every((p) => isBuilt(p.l, p.i));
}

// settle waiters: fired after a refit once every view line is built.
const fitWaiters = new Set<() => void>();
function fireFit(): void {
  if (!allBuilt()) return;
  const waiters = [...fitWaiters];
  fitWaiters.clear();
  for (const cb of waiters) cb();
}

/** Refit after a tree save: sizes changed, the fold may coarsen. */
function refit(): void {
  view = fit(view, messages.length, sizeOf, isBuilt);
  fireFit();
}

// --- tools: zoom and date over the live log + tree --------------------------
const zoomStore: ZoomStore = {
  getMessage(id: number): string | null {
    const m = messages[id];
    return m !== undefined && m.i === id ? `${m.kind}: ${m.text}` : null;
  },
  getNodeChildren(id: number, n: number): [string, string] | null {
    const l = Math.log2(n);
    const i = id / n;
    if (!Number.isInteger(l) || !Number.isInteger(i)) return null;
    const a = nodes.get(nodeKey(l - 1, 2 * i));
    const b = nodes.get(nodeKey(l - 1, 2 * i + 1));
    if (a === undefined || b === undefined) return null;
    return [a.text, b.text];
  },
};

function dateAt(id: number): string | null {
  const m = messages[id];
  return m !== undefined && m.i === id ? m.date : null;
}

function runTool(name: string, input: Record<string, unknown>): string {
  if (name === "zoom") {
    return zoom(zoomStore, Number(input["id"]), Number(input["n"]), messages.length);
  }
  if (name === "date") return lookup(dateAt, Number(input["id"]));
  return `Unknown tool ${name}.`;
}

// --- native actor: fixed tools, full in-turn history, queued input -----------
const queue: string[] = [];
const actorPending: string[] = [];
let activeTurn: AbortController | null = null;

const takePending = (): string[] => {
  if (activeTurn?.signal.aborted) return [];
  const pending = queue.splice(0);
  actorPending.push(...pending); // retain until each delivered user is fsynced
  return pending;
};

/** Current plan access token, refreshed first when it is near expiry. */
async function planToken(): Promise<string> {
  const records = await loadCredentials(authDir);
  const record = records[0];
  if (record === undefined) {
    throw new Error("optchat: no ChatGPT credential; run optchat --login first");
  }
  const refreshed = await refreshIfDue(record, { authDir });
  return (refreshed ?? record).access_token;
}

const model = planMode
  ? new OpenAIResponses({
      getAccessToken: planToken,
      model: planModel !== "" ? planModel : (process.env["OPENAI_MODEL"] ?? ""),
      tools: TOOL_DEFINITIONS,
      runTool,
      takePending,
    })
  : env === null
    ? null
    : new OpenAICompat(env, { tools: TOOL_DEFINITIONS, runTool, takePending });
if (!printView && env !== null) {
  const url = new URL(env.baseUrl);
  const redacted = url.username !== "" || url.password !== "" || url.search !== "";
  console.log(`optchat: model ${env.model} at ${redactUrl(env.baseUrl)}${redacted ? " (credentials present, redacted)" : ""}`);
}

// --- compactor pump: background loop; JOBS cap lives in pumpOnce ------------
const busy = new Set<string>();
const reported = new Set<string>();
let stopPump = false;
let idleWake: (() => void) | null = null;
let pumpVersion = 0;
const pumpAbort = new AbortController();

function wakePump(): void {
  pumpVersion++;
  const wake = idleWake;
  idleWake = null;
  if (wake !== null) wake();
}

function idleWait(observed: number): Promise<void> {
  if (observed !== pumpVersion) return Promise.resolve();
  return new Promise((resolve) => {
    idleWake = resolve;
  });
}

/** View lines (text only, no ids) before the node's end, oldest first. */
function contextOf(snapshot: Part[], l: number, i: number): string[] {
  const end = l === 0 ? i : (i + 1) * 2 ** l;
  const lines: string[] = [];
  for (const p of snapshot) {
    if (p.id + p.n > end) break;
    const text = nodes.get(nodeKey(p.l, p.i))?.text;
    if (text !== undefined) lines.push(text.replace(/\r\n|\r|\n/g, " "));
  }
  return lines;
}

async function pumpLoop(): Promise<void> {
  const compressor = model;
  if (compressor === null) return; // no model: a fake summary would poison the tree
  while (!stopPump) {
    const observed = pumpVersion;
    const snapshot = view;
    const started = await pumpOnce({
      T: messages.length,
      view: snapshot,
      isBuilt,
      busy,
      reported,
      adapter: compressor,
      signal: pumpAbort.signal,
      onSettled: wakePump,
      message: (i) => {
        const m = messages[i];
        if (m === undefined) throw new Error(`missing message ${i}`);
        return { kind: m.kind, text: m.text };
      },
      children: (l, i) => [
        nodes.get(nodeKey(l - 1, 2 * i))?.text ?? "",
        nodes.get(nodeKey(l - 1, 2 * i + 1))?.text ?? "",
      ],
      context: (l, i) => contextOf(snapshot, l, i),
      save: async (l, i, text) => {
        const node: TreeNode = { l, i, text, size: byteLen(text) };
        await saveNode(dir, scope, node);
        nodes.set(nodeKey(l, i), node);
        refit();
      },
      report: (l, i, err) => console.error(`optchat: compactor ${l}:${i} failed: ${errText(err)}`),
    });
    if (started === 0 && !stopPump) await idleWait(observed);
  }
}

// --- turn loop: settle, run a turn, commit the data dir ---------------------
const abort = new AbortController();
let turnLoop: Promise<void> | null = null;

/** Append one line (write + fsync), fold it into the view, wake the pump. */
async function log(kind: Kind, text: string): Promise<void> {
  const expected = messages.length;
  if (writer.nextId !== expected) {
    throw new Error("chat log ID gap: restore missing records before appending input");
  }
  const message = await writer.append(kind, text);
  if (message.i !== expected) {
    // Never let an unexpected durable ID enter the contiguous view.
    // Acknowledge this persisted input once, then stop all model work.
    console.log(`${kind}: ${text}`);
    console.error("optchat: chat log ID gap: input retained; restore missing records before using memory");
    process.exitCode = 1;
    abort.abort();
    stopPump = true;
    pumpAbort.abort();
    wakePump();
    closeInput();
    return;
  }
  view = appendAndFit(view, messages.length, sizeOf, isBuilt);
  wakePump();
  console.log(`${kind}: ${text}`);
}

const ctx: TurnContext = {
  renderView: () => renderView(view, getText),
  log,
  adapter: model!,
  system,
  onEntry: (entry) => {
    if (entry.kind === "thought") console.log(`thought: ${entry.text}`);
    if (entry.kind === "user" && actorPending[0] === entry.text) actorPending.shift();
  },
};

/** Preserve undelivered input on failure/cancel before releasing the lock. */
async function preservePending(): Promise<void> {
  for (const pending of [actorPending, queue]) {
    await preserveInputs(pending);
  }
}

async function commitTurn(): Promise<void> {
  try {
    if (!gitPersistence) return;
    const dataRoot = await realpath(dir);
    const gitEnv = { ...process.env };
    for (const key of Object.keys(gitEnv)) {
      if (key.startsWith("GIT_")) delete gitEnv[key];
    }
    const git = (args: string[]) => spawnSync("git", ["-C", dataRoot, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: gitEnv });
    const repo = git(["rev-parse", "--show-toplevel"]);
    if (repo.status !== 0 || await realpath(repo.stdout.trim()) !== dataRoot) {
      throw new Error("--git requires a separate repository rooted at the data directory");
    }
    const sourceRoot = await realpath(path.resolve(import.meta.dir, ".."));
    if (sourceRoot === dataRoot || sourceRoot.startsWith(dataRoot + path.sep)) {
      throw new Error("refusing to commit the source checkout");
    }
    const name = git(["config", "--local", "--get", "user.name"]).stdout.trim();
    const email = git(["config", "--local", "--get", "user.email"]).stdout.trim();
    const identity = /^(?:\d+\+)?([^@\s]+)@users\.noreply\.github\.com$/.exec(email);
    if (!name || identity?.[1]?.toLowerCase() !== name.toLowerCase()) {
      throw new Error("data repository needs a local pseudonymous name and matching GitHub noreply email");
    }
    Object.assign(gitEnv, {
      GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
    });
    const paths = [`chat/${scope}`, `tree/${scope}`].filter((p) => existsSync(path.join(dataRoot, p)));
    if (paths.length === 0) return;
    const add = git(["add", "--", ...paths]);
    if (add.error) throw add.error;
    if (add.status !== 0) throw new Error(`git add failed (status ${add.status})`);
    if (git(["diff", "--cached", "--quiet", "--", ...paths]).status === 0) return;
    const commit = git(["commit", "--only", "-m", "turn", "--", ...paths]);
    if (commit.error) throw commit.error;
    if (commit.status !== 0) console.error(`optchat: git commit skipped (status ${commit.status})`);
  } catch (err) {
    console.error(`optchat: git commit failed: ${errText(err)}`);
  }
}

async function turnLoopBody(): Promise<void> {
  while (queue.length > 0 && !abort.signal.aborted) {
    activeTurn = new AbortController();
    ctx.signal = AbortSignal.any([abort.signal, activeTurn.signal]);
    try {
      const ok = await settle(allBuilt, (cb) => {
        fitWaiters.add(cb);
        return () => { fitWaiters.delete(cb); };
      }, ctx.signal);
      if (ok) await runTurn(queue, ctx);
      else await preservePending();
    } catch (err) {
      if (!ctx.signal.aborted) console.error(`optchat: turn failed: ${errText(err)}`);
      await preservePending();
    } finally {
      activeTurn = null;
      await preserveInputs(actorPending);
    }
    await commitTurn();
  }
}

async function preserveInputs(pending: string[]): Promise<void> {
  while (pending.length > 0) {
    await log("user", pending[0]!);
    pending.shift();
  }
}

let closeInput = (): void => {};

function kickTurn(): void {
  if (turnLoop !== null || abort.signal.aborted || queue.length === 0) return;
  turnLoop = turnLoopBody().catch((err) => {
    console.error(`optchat: input persistence failed: ${errText(err)}`);
    process.exitCode = 1;
    abort.abort();
    closeInput();
  }).finally(() => {
    turnLoop = null;
    if (queue.length > 0 && !abort.signal.aborted) kickTurn();
  });
}

// --- start ------------------------------------------------------------------
console.log(`optchat scope=${scope} dir=${dir}`);
console.log(renderView(view, getText));

if (printView) {
  // No model calls or background writes in print-only mode.
} else {
  const pumping = pumpLoop();

  const rl = readline.createInterface({ input: process.stdin });
  closeInput = () => rl.close();
  const onInterrupt = (): void => {
    abort.abort();
    activeTurn?.abort();
    rl.close();
  };
  process.on("SIGINT", onInterrupt);
  rl.on("line", (line: string) => {
    const command = line.trim();
    if (command === "") return;
    if (command === "/exit" || command === "/quit") {
      rl.close();
      return;
    }
    if (command === "/cancel") {
      activeTurn?.abort();
      return;
    }
    queue.push(line);
    kickTurn();
  });

  try {
    await new Promise<void>((resolve) => rl.once("close", () => resolve()));
    // Drain normal EOF/exit input while compaction can still settle its view.
    while (turnLoop !== null) await turnLoop;
    await preservePending();
  } finally {
    onInterrupt();
    stopPump = true;
    pumpAbort.abort();
    wakePump();
    await turnLoop;
    await pumping;
    while (busy.size > 0) await idleWait(pumpVersion);
    await commitTurn(); // include durable tree saves completed during shutdown
    process.off("SIGINT", onInterrupt);
    rl.close();
  }
}
} catch (err) {
  console.error(`optchat: ${errText(err)}`);
  process.exitCode = 1;
} finally {
  await lock.release();
}
