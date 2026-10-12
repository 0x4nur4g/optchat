/**
 * optchat-recall — OpenCode v2 plugin that keeps optchat's memory behind
 * OpenCode sessions.
 *
 * Two halves, deliberately different in shape:
 *
 *   CAPTURE is model-independent. It runs off `session.inbox.enqueued`, which
 *   fires when the user submits, so a message is recorded whether or not any
 *   model chooses to do anything. Memory must never depend on that choice.
 *   It shells out to `optchat --capture`, which owns every durability
 *   guarantee: single writer lock, write + fsync, contiguous ids.
 *
 *   RECALL is model-invoked and lives in `optchat --mcp`, registered through
 *   the `mcp` block of opencode.json rather than here. The model deciding when
 *   to look something up is fine; the model deciding whether to remember is not.
 *
 * Config: `mcp` in opencode.json for recall (see the README alongside this
 * file), and this plugin for capture.
 */
import { Plugin } from "@opencode-ai/plugin";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

// The Context is not re-exported as a named type by the package root in this
// build, so derive it from the define entrypoint. That keeps this type-safe
// against the pinned plugin build without naming a shape that could drift.
type PluginObject = Parameters<typeof Plugin.define>[0];
type Context = Parameters<PluginObject["setup"]>[0];

/** Where optchat keeps the memory. Must match the `--dir` in opencode.json. */
const DATA_DIR: string = process.env["OPTCHAT_DIR"] ?? `${homedir()}/.local/share/optchat`;

/** The CLI to invoke. Override when it is not on the server's PATH. */
const OPTCHAT_BIN: string = process.env["OPTCHAT_BIN"] ?? "optchat";

interface EnqueuedItem {
  type?: unknown;
  payload?: { text?: unknown };
}

/** v2.0.11 nests the payload under `data`; earlier builds put it on the event. */
function itemOf(event: unknown): EnqueuedItem | null {
  const outer = event as { data?: unknown };
  const data = (outer.data ?? event) as { item?: unknown };
  const item = data.item;
  return typeof item === "object" && item !== null ? item as EnqueuedItem : null;
}

/**
 * Hand one message to optchat. Fire and forget: a capture must never block or
 * fail the session it came from. The child writes and fsyncs before it exits,
 * so detaching is safe.
 */
function capture(text: string): void {
  const child = spawn(OPTCHAT_BIN, ["--capture", "--kind", "user", "--dir", DATA_DIR], {
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
  });
  child.once("error", () => { /* optchat absent: nothing to record into */ });
  child.stdin.write(text);
  child.stdin.end();
  child.unref();
}

async function setup(ctx: Context): Promise<() => void> {
  const controller = new AbortController();

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if ((event as { type?: unknown }).type !== "session.inbox.enqueued") continue;
        const item = itemOf(event);
        if (item?.type !== "user") continue;
        const text = item.payload?.text;
        if (typeof text !== "string" || text.trim().length === 0) continue;
        capture(text);
      }
    } catch {
      // Aborted on cleanup, or the event stream ended. Either way the plugin's
      // job is done; never surface this into a user's session.
    }
  })();

  return () => controller.abort();
}

export default Plugin.define({ id: "optchat-recall", setup });
