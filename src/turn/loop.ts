import { CAP } from "../constants";
import type { Kind } from "../constants";
import { MASTER_SYSTEM, VIEW_DOC } from "../compactor/prompts";
import type { TurnAdapter } from "../model/adapter";

/**
 * renderBeforeLog rule: render the view BEFORE the new user text is logged,
 * so every turn answers against memory built from earlier turns only. Never
 * render after logging the current prompt; the prompt must not appear twice.
 */

// System prompt for every turn: master prompt plus the view/tool doc. A
// constant, so the prompt and tool list stay byte-identical across calls
// (AGENTS.md rule 7).
const SYSTEM = MASTER_SYSTEM + "\n\n" + VIEW_DOC;

export interface TurnContext {
  renderView(): string;
  log(kind: Kind, text: string): Promise<void>;
  adapter: TurnAdapter;
}

/** Cap a tool result the capToolResult way: head + tail, drop the middle. */
function capToolResult(text: string): string {
  if (text.length <= CAP) return text;
  const half = Math.floor((CAP - 5) / 2); // 5 = the "\n...\n" separator
  return `${text.slice(0, half)}\n...\n${text.slice(-half)}`;
}

/**
 * Wait until the incremental view is built (waitForBuilt) and fitted (onFit
 * fires after registering the callback). Resolves true when either is already
 * true or onFit fires; resolves false when the signal aborts first.
 */
export function settle(
  waitForBuilt: () => boolean,
  onFit: (cb: () => void) => void,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (waitForBuilt()) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", onAbort);
      resolve(ok);
    };
    const onAbort = (): void => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
    onFit(() => finish(true));
  });
}

/**
 * One fresh turn: take the oldest queued user text, render the view first,
 * log the user text, stream the adapter, log talk/tool/echo as they finish.
 * Thought kinds are never logged.
 */
export async function runTurn(queue: string[], ctx: TurnContext): Promise<void> {
  const userText = queue.shift();
  if (userText === undefined) return;

  // renderBeforeLog: the view is rendered before the user text hits the log.
  const view = ctx.renderView();

  await ctx.log("user", userText);

  for await (const entry of ctx.adapter.ask({ system: SYSTEM, view, userText })) {
    if (entry.kind === "talk" || entry.kind === "tool") {
      await ctx.log(entry.kind, entry.text);
    } else if (entry.kind === "echo") {
      await ctx.log("echo", capToolResult(entry.text));
    }
    // Any other kind (thoughts, reasoning, ...) is never logged.
  }

  // Mid-run user texts: lines pushed onto `queue` while the model streamed
  // are not seen by this turn (its view is already fixed) and stay queued for
  // the next runTurn call.
}