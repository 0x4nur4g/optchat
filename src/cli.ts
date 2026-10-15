#!/usr/bin/env bun
/**
 * Plain terminal CLI: one endless chat, no TUI redraws, no cursor games.
 *
 * Usage: optchat --scope global --dir ./data [--print-view]
 *   --print-view  print the current view and exit (no input loop)
 *   --mcp         serve read-only memory tools over stdio (no input loop)
 *
 * On start the view is printed once. Then each stdin line is queued and a
 * turn is run. Lines arriving during a turn reach the native actor between
 * completed tool calls, or start a fresh turn after it finishes.
 *
 * Model: OPENAI_BASE_URL + OPENAI_API_KEY + OPENAI_MODEL (chat completions,
 * plain fetch). Interactive mode requires all three settings. --print-view,
 * --capture and --mcp need no model configuration.
 */
import * as readline from "node:readline";
import { spawnSync } from "node:child_process";
import { existsSync, writeSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { SCOPES, byteLen } from "./constants";
import type { Kind, TreeNode } from "./constants";
import { OpenAICompat, readEnv, redactUrl } from "./model/openai-compat";
import { OpenAIResponses, listModels } from "./model/openai-responses";
import { login, refreshIfDue, signOut, PLAN_SCOPE } from "./auth/login";
import { loadCredentials, loadPlanModel, savePlanModel } from "./auth/credentials";
import { openLog } from "./storage/log";
import { capture } from "./storage/capture";
import { acquireLock } from "./storage/lock";
import type { LockHandle } from "./storage/lock";
import { loadAllNodes, saveNode } from "./storage/tree-store";
import { nodeKey } from "./tree/address";
import { appendAndFit, sawtooth } from "./view/fold";
import type { Part } from "./view/fold";
import { CompactionView } from "./view/compaction";
import { resumeView, saveView } from "./view/persist";
import { NOT_BUILT, renderBefore, renderView } from "./view/render";
import { arrive, initReady, pumpOnce } from "./compactor/pump";
import { runTurn, settle, TURN_SYSTEM } from "./turn/loop";
import type { TurnContext } from "./turn/loop";
import { memoryZoomStore, zoom } from "./tools/zoom";
import type { ZoomStore } from "./tools/zoom";
import { lookup, memoryDateAt } from "./tools/date";
import { TOOL_DEFINITIONS } from "./tools/definitions";
import { memoryTools } from "./mcp/tools";
import { serveMcp } from "./mcp/server";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value !== undefined && !value.startsWith("--") ? value : fallback;
}

async function packageVersion(): Promise<string> {
  try {
    const raw = await readFile(path.join(import.meta.dir, "..", "package.json"), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" && version.length > 0 ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

if (process.argv.includes("--version")) {
  // Runs before any data directory or lock, like --help.
  console.log(`optchat ${await packageVersion()}`);
  process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: optchat [options]

--scope KEY        Memory scope. Only global is supported today.
--dir PATH         Data directory (default ./data).
--print-view       Print stored memory and exit without a model.
--mcp              Serve read-only memory tools (recall, zoom, date) over stdio for MCP
                   clients. No model and no writer lock; exits when stdin ends.
--capture          Append one message and exit. No model needed.
--kind KIND        With --capture: user, talk, tool, echo or note (default user).
--text TEXT        With --capture: the message. Without it, the message is read from stdin.
--login            Sign in with ChatGPT and store the credential, then exit.
--fresh            With --login: register again rather than reuse the saved account.
--accounts         Show which ChatGPT account each saved registration is bound to.
--logout           Revoke the saved session and forget it, then exit.
--models           List model slugs the signed-in plan can run, then exit.
--plan             Use the signed-in ChatGPT plan instead of an API key.
--model SLUG       With --plan: which model to run.
--auth-dir PATH    Where credentials live (default ~/.config/optchat/auth).
--instructions F   Read F once at startup (default <dir>/instructions.md, if present).
--git              Commit chat/tree data after each turn in a separate data repository.
--help             Show this help without creating data or taking a lock.
--version          Print the version and exit.

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
    const added = await capture(dir, scope, kind, text);
    for (const message of added) console.log(message.i);
    process.exit(0);
  } catch (err) {
    console.error(`optchat: ${errText(err)}`);
    process.exit(1);
  }
}

// --mcp: read-only recall for MCP clients (OpenCode, Codex, Claude Code). Runs
// before any model configuration is read, and never takes the writer lock: a
// reader must not block a running instance. Nothing here writes to the log, so
// --capture stays the only way memory is written.
if (process.argv.includes("--mcp")) {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    // Synchronous writes: process.exit would otherwise drop a large reply that
    // is still buffered in the stdout pipe.
    await serveMcp(lines, (line) => { writeSync(1, `${line}\n`); }, {
      name: "optchat",
      version: await packageVersion(),
      tools: memoryTools(dir, scope),
    });
  } catch (err) {
    console.error(`optchat: ${errText(err)}`);
    process.exit(1);
  }
  process.exit(0);
}

// --login: Sign in with ChatGPT. Runs before any model configuration is read
// and never takes the memory lock, since it writes only to the auth directory.
if (process.argv.includes("--login")) {
  try {
    const fresh = process.argv.includes("--fresh");
    console.log(fresh
      ? "optchat: starting a new registration; a saved account is left untouched"
      : "optchat: reusing the saved registration if one exists (use --fresh to add or change account)");
    await login({
      authDir,
      agentName: "optchat",
      fresh,
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

// --accounts: which ChatGPT account each saved registration is bound to. The
// email is masked; it is shown so a workspace mismatch can be recognised, and
// is never written to a log.
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "(no email)";
  const local = email.slice(0, at);
  return `${local.slice(0, 1)}***@${email.slice(at + 1)}`;
}

if (process.argv.includes("--accounts")) {
  try {
    const records = await loadCredentials(authDir);
    if (records.length === 0) {
      console.log("optchat: no saved ChatGPT account; run optchat --login");
    } else {
      for (const record of records) {
        const plan = record.scopes.includes(PLAN_SCOPE) ? "plan" : "no-plan";
        console.log(`${maskEmail(record.email)}  ${record.client_id}  ${plan}  saved ${record.saved_at}`);
      }
    }
    process.exit(0);
  } catch (err) {
    console.error(`optchat: ${errText(err)}`);
    process.exit(1);
  }
}

// --logout: revoke the session at OpenAI and forget it here. The registered
// client survives on OpenAI's side, so the next --login registers again.
if (process.argv.includes("--logout")) {
  try {
    const records = await loadCredentials(authDir);
    if (records.length === 0) {
      console.log("optchat: no saved ChatGPT account");
    } else {
      for (const record of records) {
        const { revoked } = await signOut(record, { authDir });
        console.log(revoked
          ? `optchat: signed out ${maskEmail(record.email)}; session revoked`
          : `optchat: signed out ${maskEmail(record.email)}; remote revocation was not confirmed`);
      }
    }
  } catch (err) {
    console.error(`optchat: ${errText(err)}`);
    process.exit(1);
  }
  process.exit(0);
}

let env: ReturnType<typeof readEnv> = null;
try {
  if (!printView && !planMode) env = readEnv();
} catch (err) {
  console.error(`optchat: ${errText(err)}`);
  process.exit(1);
}
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

// A saved credential is enough to run, so signing in is the only setup step.
// Plan is used automatically when no API key is configured.
const rememberedModel = await loadPlanModel(authDir);
const hasCredential = (await loadCredentials(authDir)).length > 0;
const usePlan = planMode || (env === null && hasCredential);
let modelChoice = "";
const resolvedModel = planModel !== ""
  ? planModel
  : (rememberedModel ?? process.env["OPENAI_MODEL"]?.trim() ?? "");

if (!printView && !usePlan && env === null) {
  console.error("optchat: OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL are required for interactive mode, or run optchat --login");
  process.exit(1);
}
if (!printView && usePlan && resolvedModel === "") {
  // No model chosen yet: take the first the plan exposes, so signing in is the
  // only setup step. Reported, and changeable with --plan --model.
  try {
    const models = await listModels(planToken);
    if (models.length === 0) throw new Error("optchat: this plan exposes no models");
    modelChoice = models[0]!.slug;
    await savePlanModel(authDir, modelChoice);
    console.error(`optchat: using model ${modelChoice}; change with optchat --plan --model SLUG`);
  } catch (err) {
    console.error(`optchat: ${errText(err)}`);
    process.exit(1);
  }
} else {
  modelChoice = resolvedModel;
}
// Remember an explicit choice so later plain runs work.
if (usePlan && planModel !== "") await savePlanModel(authDir, planModel);

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
  return node === undefined ? byteLen(NOT_BUILT) : node.size;
}

function getText(part: Part): string | undefined {
  return nodes.get(nodeKey(part.l, part.i))?.text;
}

let view: Part[] = await resumeView(dir, scope, messages.length, sizeOf, isBuilt);

// Ready queues: seeded once from the loaded state, then maintained by message
// arrivals and completed saves. The pump pops them instead of scanning.
const ready = initReady(view, isBuilt, messages.length);

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

/** Refit after a tree save: sizes changed, and a batch may be able to finish. */
function refit(): void {
  view = sawtooth(view, messages.length, sizeOf, isBuilt);
  void saveView(dir, scope, view).catch((err) => {
    console.error(`optchat: could not save the view: ${errText(err)}`);
  });
  fireFit();
}

// --- tools: zoom and date over the live log + tree --------------------------
const zoomStore: ZoomStore = memoryZoomStore(messages, nodes);

const dateAt = memoryDateAt(messages);

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

const model = usePlan
  ? new OpenAIResponses({
      getAccessToken: planToken,
      model: modelChoice,
      tools: TOOL_DEFINITIONS,
      runTool,
      takePending,
    })
  : env === null
    ? null
    : new OpenAICompat(env, { tools: TOOL_DEFINITIONS, runTool, takePending });
// The startup header reports the active model, so no separate banner.

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

const compactionView = new CompactionView();

async function pumpLoop(): Promise<void> {
  const compressor = model;
  if (compressor === null) return; // no model: a fake summary would poison the tree
  while (!stopPump) {
    const observed = pumpVersion;
    const snapshot = view;
    compactionView.update(snapshot, messages.length, sizeOf, isBuilt);
    const started = await pumpOnce({
      ready,
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
      context: (l, i) => compactionView.contextOf(l, i, getText),
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
  const added = await writer.append(kind, text);
  if (added.some((message, index) => message.i !== expected + index)) {
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
  for (const message of added) {
    view = appendAndFit(view, message.i + 1, sizeOf, isBuilt);
    arrive(ready, message.i); // a leaf enters the ready queue on arrival
  }
  await saveView(dir, scope, view);
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
let reprompt = (): void => {};

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
    else reprompt();
  });
}

// --- start ------------------------------------------------------------------
// For a person, an unsummarized message shows as itself. The placeholder a
// model sees ("not summarized yet: zoom it") is an instruction to zoom, which
// means nothing to the reader of their own memory.
function humanText(part: Part): string | undefined {
  const node = nodes.get(nodeKey(part.l, part.i))?.text;
  if (node !== undefined) return node;
  if (part.n !== 1) return undefined;
  const message = messages[part.id];
  if (message === undefined) return undefined;
  const body = message.text.replace(/\r\n?|\n/g, " ").trim();
  return `${message.kind}: ${body.length > 160 ? `${body.slice(0, 160)}…` : body}`;
}

if (printView) {
  // Pipeable form: the view exactly as a model call receives it.
  console.log(`optchat scope=${scope} dir=${dir}`);
  console.log(renderView(view, getText));
} else {
  // The interactive screen is for a person, so it shows the memory without the
  // <chat> framing a model needs, and says what to do when there is none yet.
  const memory = renderBefore(view, Number.POSITIVE_INFINITY, humanText);
  console.log(`optchat ${await packageVersion()}    memory ${dir}    model ${usePlan ? modelChoice : (env?.model ?? "")}`);
  console.log("");
  console.log(memory === "" ? "Memory is empty. Whatever you say here is kept forever." : memory);
  console.log("");
  console.log("  /cancel  cancel the current turn");
  console.log("  /exit    quit");
  console.log("");
}

if (printView) {
  // No model calls or background writes in print-only mode.
} else {
  const pumping = pumpLoop();

  // terminal:false keeps the terminal driver in charge of echoing and line
  // editing, which is the plain terminal this CLI wants, and it makes the
  // prompt ours to write rather than readline's.
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  closeInput = () => rl.close();
  reprompt = () => process.stdout.write("> ");
  reprompt();
  const onInterrupt = (): void => {
    abort.abort();
    activeTurn?.abort();
    rl.close();
  };
  process.on("SIGINT", onInterrupt);
  rl.on("line", (line: string) => {
    const command = line.trim();
    if (command === "") {
      reprompt();
      return;
    }
    if (command === "/exit" || command === "/quit") {
      rl.close();
      return;
    }
    if (command === "/cancel") {
      activeTurn?.abort();
      if (turnLoop === null) reprompt();
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
