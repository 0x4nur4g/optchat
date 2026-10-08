import type { Kind } from "../constants";
import { MASTER_SYSTEM, VIEW_DOC, capToolResult } from "../compactor/prompts";
import type { TurnAdapter, TurnEntry } from "../model/adapter";

/**
 * renderBeforeLog rule: render the view BEFORE the new user text is logged,
 * so every turn answers against memory built from earlier turns only. Never
 * render after logging the current prompt; the prompt must not appear twice.
 */

// System prompt for every turn: master prompt plus the view/tool doc. A
// constant, so the prompt and tool list stay byte-identical across calls
// (AGENTS.md rule 7).
export const TURN_SYSTEM = MASTER_SYSTEM + "\n\n" + VIEW_DOC;

export interface TurnContext {
  renderView(): string;
  log(kind: Kind, text: string): Promise<void>;
  adapter: TurnAdapter;
  system?: string;
  signal?: AbortSignal;
  onEntry?(entry: TurnEntry): void | Promise<void>;
}

/**
 * Wait until the incremental view is built (waitForBuilt) and fitted (onFit
 * fires after registering the callback). Resolves true when either is already
 * true or onFit fires; resolves false when the signal aborts first.
 */
export function settle(
  waitForBuilt: () => boolean,
  onFit: (cb: () => void) => void | (() => void),
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (waitForBuilt()) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    let done = false;
    let removeFit: void | (() => void);
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", onAbort);
      removeFit?.();
      resolve(ok);
    };
    const onAbort = (): void => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
    removeFit = onFit(() => {
      if (waitForBuilt()) finish(true);
    });
    if (done) removeFit?.(); // a synchronous subscription can finish immediately
    else if (signal.aborted) finish(false);
    else if (waitForBuilt()) finish(true);
  });
}

/**
 * One fresh turn: take all queued user texts, render the view first,
 * log the user text, stream the adapter, log talk/tool/echo as they finish.
 * Thought kinds are never logged.
 */
export async function runTurn(queue: string[], ctx: TurnContext): Promise<void> {
  const initial = queue.slice();
  if (initial.length === 0) return;

  // renderBeforeLog: the view is rendered before the user text hits the log.
  const view = ctx.renderView();

  for (const text of initial) {
    await ctx.log("user", text);
    queue.shift(); // only remove input after its durable append succeeds
  }
  const userText = initial.join("\n\n");
  if (ctx.signal?.aborted) return;

  for await (const entry of ctx.adapter.ask({
    system: ctx.system ?? TURN_SYSTEM, view, userText, signal: ctx.signal,
  })) {
    if (entry.kind === "talk" || entry.kind === "tool" || entry.kind === "user") {
      await ctx.log(entry.kind, entry.text);
    } else if (entry.kind === "echo") {
      await ctx.log("echo", capToolResult(entry.text));
    }
    await ctx.onEntry?.(entry);
    // Any other kind (thoughts, reasoning, ...) is never logged.
  }

  // Undelivered mid-run input stays queued. Native adapters emit a user entry
  // when they accept input at a completed-tool boundary.
}
