#!/usr/bin/env bun
/**
 * Plain terminal CLI: one endless chat, no TUI redraws, no cursor games.
 *
 * Usage: bun run src/cli.ts --scope global --dir ./data [--print-view]
 *   --print-view  print the current view and exit (no input loop)
 *
 * On start the view is printed once. Then each stdin line is queued and a
 * turn is run. Lines arriving while a turn streams stay queued and are
 * answered by a later turn.
 *
 * Model: OPENAI_BASE_URL + OPENAI_API_KEY + OPENAI_MODEL (chat completions,
 * plain fetch). Without them the turns fall back to MockAdapter and the
 * compactor stays off (no summaries, so no tree writes).
 */
import * as readline from "node:readline";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { SCOPES, byteLen } from "./constants";
import type { Kind, LogMessage, TreeNode } from "./constants";
import { MockAdapter } from "./model/adapter";
import type { TurnAdapter, TurnEntry, TurnRequest } from "./model/adapter";
import { OpenAICompat, parseToolLine, readEnv, redactUrl } from "./model/openai-compat";
import { appendMessage, loadAll } from "./storage/log";
import { acquireLock } from "./storage/lock";
import type { LockHandle } from "./storage/lock";
import { loadAllNodes, nodeKey, saveNode } from "./storage/tree-store";
import { appendAndFit, foldAll } from "./view/fold";
import type { Part } from "./view/fold";
import { renderBefore, renderView } from "./view/render";
import { pumpOnce } from "./compactor/pump";
import { capToolResult } from "./compactor/prompts";
import { runTurn, settle } from "./turn/loop";
import type { TurnContext } from "./turn/loop";
import { zoom } from "./tools/zoom";
import type { ZoomStore } from "./tools/zoom";
import { lookup } from "./tools/date";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value !== undefined && !value.startsWith("--") ? value : fallback;
}

const scope = arg("--scope", SCOPES[0]);
const dir = arg("--dir", "./data");
const printView = process.argv.includes("--print-view");

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const PLACEHOLDER = "(not summarized yet: zoom it)"; // render.ts placeholder body
const PUMP_IDLE_MS = 100;
const MAX_TOOL_ROUNDS = 8;

// --- start: single writer, load log + tree, fold the view from 0 ------------
let lock: LockHandle;
try {
  lock = await acquireLock(dir);
} catch (err) {
  console.error(`optchat: ${errText(err)}`);
  process.exit(1);
}

const messages: LogMessage[] = await loadAll(dir, scope);
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
  view = foldAll(messages.length, sizeOf, isBuilt);
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

// --- model adapter: env, else MockAdapter with the compactor off ------------
const env = readEnv();
let turn: TurnAdapter;
let compactor: { compress(contextLines: string[], step: string, system: string): Promise<string> } | null = null;
if (env === null) {
  turn = new MockAdapter();
  console.log("optchat: OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL not set: MockAdapter answers, compactor off");
} else {
  const compat = new OpenAICompat(env);
  turn = compat;
  compactor = compat;
  console.log(`optchat: model ${env.model} at ${redactUrl(env.baseUrl)}`);
}

/** Execute each TOOL line, log it plus its echo, and run one more round. */
class ToolRounds implements TurnAdapter {
  constructor(
    private readonly inner: TurnAdapter,
    private readonly run: (name: string, input: Record<string, unknown>) => string,
  ) {}

  async *ask(req: TurnRequest): AsyncIterable<TurnEntry> {
    let userText = req.userText;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const results: string[] = [];
      for await (const entry of this.inner.ask({ system: req.system, view: req.view, userText })) {
        const call = entry.kind === "tool" ? parseToolLine(entry.text) : null;
        yield entry;
        if (call === null) continue;
        const result = capToolResult(this.run(call.name, call.input)).text;
        results.push(result);
        yield { kind: "echo", text: result };
      }
      if (results.length === 0) return;
      userText = results.join("\n\n"); // tool results go back as the next user block
    }
  }
}

// --- compactor pump: background loop; JOBS cap lives in pumpOnce ------------
const busy = new Set<string>();
const reported = new Set<string>();
let stopPump = false;
let idleWake: (() => void) | null = null;

function wakePump(): void {
  const wake = idleWake;
  idleWake = null;
  if (wake !== null) wake();
}

function idleWait(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      idleWake = null;
      resolve();
    }, PUMP_IDLE_MS);
    idleWake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

/** View lines (text only, no ids) before the node's end, oldest first. */
function contextOf(snapshot: Part[], l: number, i: number): string[] {
  const end = l === 0 ? i : (i + 1) * 2 ** l;
  const lines: string[] = [];
  for (const p of snapshot) {
    if (p.id + p.n > end) break;
    const text = nodes.get(nodeKey(p.l, p.i))?.text;
    if (text !== undefined) lines.push(text);
  }
  return lines;
}

async function pumpLoop(): Promise<void> {
  const compressor = compactor;
  if (compressor === null) return; // no model: a fake summary would poison the tree
  while (!stopPump) {
    const snapshot = view;
    const started = await pumpOnce({
      T: messages.length,
      view: snapshot,
      isBuilt,
      startOf: (p) => p.id,
      busy,
      reported,
      adapter: compressor,
      message: (i) => {
        const m = messages[i];
        return m === undefined ? { kind: "note", text: "" } : { kind: m.kind, text: m.text };
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
    if (started === 0 && !stopPump) await idleWait();
  }
}

// --- turn loop: settle, run a turn, commit the data dir ---------------------
const queue: string[] = [];
const abort = new AbortController();
let turnLoop: Promise<void> | null = null;

/** Append one line (write + fsync), fold it into the view, wake the pump. */
async function log(kind: Kind, text: string): Promise<void> {
  const msg = await appendMessage(dir, scope, kind, text);
  messages.push(msg);
  view = appendAndFit(view, messages.length, sizeOf, isBuilt);
  wakePump();
  console.log(`${kind}: ${text}`);
}

const ctx: TurnContext = {
  renderView: () => renderBefore(view, messages.length, getText),
  log,
  adapter: new ToolRounds(turn, runTool),
};

async function commitTurn(): Promise<void> {
  try {
    if (!existsSync(path.join(dir, ".git"))) return; // not a repo: silent skip
    const add = spawnSync("git", ["-C", dir, "add", "-A"], { stdio: "ignore" });
    if (add.error) throw add.error;
    const commit = spawnSync("git", ["-C", dir, "commit", "-m", "turn"], { stdio: "ignore" });
    if (commit.error) throw commit.error;
    if (commit.status !== 0) console.error(`optchat: git commit skipped (status ${commit.status})`);
  } catch (err) {
    console.error(`optchat: git commit failed: ${errText(err)}`);
  }
}

async function turnLoopBody(): Promise<void> {
  while (queue.length > 0 && !abort.signal.aborted) {
    // Never start a turn on placeholder lines. Without a compactor they can
    // never become built, so mock mode proceeds (placeholder is the fail-safe).
    const ok = await settle(
      () => compactor === null || allBuilt(),
      (cb) => fitWaiters.add(cb),
      abort.signal,
    );
    if (!ok) return;
    try {
      await runTurn(queue, ctx);
    } catch (err) {
      console.error(`optchat: turn failed: ${errText(err)}`);
    }
    await commitTurn();
  }
}

function kickTurn(): void {
  if (turnLoop !== null) return;
  turnLoop = turnLoopBody();
  void turnLoop.finally(() => {
    turnLoop = null;
  });
}

// --- start ------------------------------------------------------------------
console.log(`optchat scope=${scope} dir=${dir}`);
console.log(renderView(view, getText));

if (printView) {
  await lock.release();
} else {
  void pumpLoop();

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line: string) => {
    const text = line.trim();
    if (text === "") return;
    if (text === "/exit" || text === "/quit") {
      rl.close();
      return;
    }
    queue.push(text);
    kickTurn();
  });

  await new Promise<void>((resolve) => rl.once("close", () => resolve()));

  // Drain queued texts (settle needs the pump), then stop the background work.
  await turnLoop;
  stopPump = true;
  wakePump();
  abort.abort();
  await lock.release();
}