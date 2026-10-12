# optchat + OpenCode

Puts optchat's memory behind your OpenCode sessions, in two deliberately
different halves.

**Capture is model-independent.** Your words are recorded when you submit
them, not when a model decides to call something. Memory must never depend on
that choice.

**Recall is model-invoked**, because the model deciding *when* to look
something up is fine. That half is `optchat --mcp`.

## 1. Recall — the MCP server

Add optchat to the `mcp` block of `opencode.json`:

```json
{
  "mcp": {
    "optchat": {
      "type": "local",
      "command": ["optchat", "--mcp", "--dir", "/home/you/.local/share/optchat"]
    }
  }
}
```

The command runs `optchat --mcp`, which serves three read-only tools over
stdio: `recall` for the current memory, `zoom` to open a summary into what it
was made from, and `date` for a message's timestamp.

It reads without taking the single-writer lock, so it never blocks a running
optchat instance.

## 2. Capture — the plugin

Register `index.ts` from this directory:

```json
{
  "plugin": [
    ["/absolute/path/to/optchat/integrations/opencode/index.ts", { "options": {} }]
  ]
}
```

The registration shape matters on current OpenCode builds. Use the singular
`plugin` key and a **nested** tuple array exactly as above. A bare string path,
a plural `plugins` key, or a flat tuple all silently fail to load.

The plugin listens for `session.inbox.enqueued`, which fires when you submit a
message, and hands it to `optchat --capture --kind user`. The CLI owns every
durability guarantee: single writer, write and fsync, contiguous message ids.
Nothing here touches a model.

## 3. Configuration

| Variable | Meaning | Default |
| --- | --- | --- |
| `OPTCHAT_DIR` | Where optchat keeps memory | `~/.local/share/optchat` |
| `OPTCHAT_BIN` | How to invoke the CLI | `optchat` |

`OPTCHAT_DIR` must match the `--dir` in the `mcp` block. Both halves have to
read the same memory.

`optchat` must be on the server's PATH for capture. If it is not, set
`OPTCHAT_BIN` to its absolute path.

## What is and is not captured

Only what **you** submit is recorded, as `user` messages. Assistant replies are
not captured yet: this runtime does not expose them on the same event surface,
and capture must not depend on a model choosing to report them. They can still
be recorded later from the log with `optchat --capture --kind talk`, or by an
import.

## Version note

This targets `@opencode-ai/plugin@0.0.0-beta-18155`, the build whose Context
exposes `event` and a `setup` that may return a cleanup function. Later builds
have moved these surfaces before, so re-run `bun run typecheck` here after any
OpenCode upgrade.
