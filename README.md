# OptChat core (phase 1)

Standalone chat-memory harness. One durable chat log, a binary summary tree,
and a bounded view for each new turn. Bun, zero runtime dependencies.

Inspired by the [pinned OptChat specification](https://gist.githubusercontent.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449/raw/f51fe5c910427fd6f384d22823140b1693c76207/optchat.md)
and OptMem.
Prompts here are original wording. No verbatim copy from the gist.
See [spec notes](docs/SPEC-NOTES.md) for invariants, differences, and deferred work.

## Shape

```
A. optchat-core (this repo, Bun, zero runtime deps):
   chat/<scope>/main/YYYY-MM-DD.jsonl  log, append-only
   tree/<scope>/YYYY-MM-DD.jsonl  nodes, cache
   single-writer lock + background compactor + incremental view
   native Chat Completions tool loop + fresh state per turn
   zoom/date memory tools + stable view pieces

B. optchat-bridge (later, thin adapter):
   exposes zoom/date to OpenCode/Codex/Claude sessions
```

Phase 1 ships the core CLI with `global` scope only. Paths contain scope keys
from day one (`chat/<scope>/`, `tree/<scope>/`). Other scopes are not a CLI feature yet.

Each turn starts with a settled view and the new user message. The view is
captured before that message enters the log. Within a turn, native assistant
messages, tool-call IDs, tool results, and accepted follow-up input remain in
the full request history. Reasoning fields stay in that active history when
the provider returns them; they do not enter the permanent log.

The shipped tools are `zoom(id, n)` and `date(id)`. They read the stored memory.
This release does not provide shell execution, computer use, or product subagents.
The external bridge, semantic index, and history-import/browser commands remain
deferred. Import and HTML helpers in `src/` are not installed CLI commands.

## Install and run

Linux is the currently supported runtime. Use Bun 1.4.0, the version pinned for CI.
The writer lock requires Linux abstract Unix sockets. Install from this checkout:

```sh
bun install --frozen-lockfile
bun link
optchat --help
```

`bun link` installs `optchat` into `~/.bun/bin`. That directory must be on `PATH`
for the last command to resolve. The official Bun installer adds it. If Bun was
installed another way, add `~/.bun/bin` to `PATH` first.

For continuous use, run on an always-on Linux host in a persistent terminal session.
Attach to that session as needed.

Set these variables in the process environment for model-backed turns:

| Variable | Meaning |
| --- | --- |
| `OPENAI_BASE_URL` | API root, for example `https://api.openai.com/v1`; the adapter adds `/chat/completions` |
| `OPENAI_API_KEY` | Provider key; keep it out of the repository and chat text |
| `OPENAI_MODEL` | Model with native Chat Completions tool support |
| `OPENAI_COMPACTOR_MODEL` | Optional summary model on the same provider; defaults to `OPENAI_MODEL` |

The provider must accept the configured view and the active turn history.
Provider calls can incur charges. Compatibility varies by provider and model.

```sh
optchat --scope global --dir ./data
optchat --scope global --dir ./data --print-view
```

Optional user instructions come from a file loaded once at startup. By default,
the CLI reads `<dir>/instructions.md` when it exists. Select another file with:

```sh
optchat --scope global --dir ./data --instructions ./instructions.md
```

Restart to reload that file. Stable instructions keep the system prefix unchanged.
The terminal prints plain text. Use `/exit` or `/quit` to leave the input loop.
Provider responses are buffered (`stream: false`); text appears after each completed
response, not token by token.
`/cancel` cancels the active turn. Ctrl+C cancels work and preserves queued input.
`--print-view` displays stored state; it is not a live-provider verification.

## Memory and storage

Under `--dir`, the log uses `chat/global/main/YYYY-MM-DD.jsonl`; the tree uses
`tree/global/YYYY-MM-DD.jsonl`. Each append is written and fsynced. A Linux abstract
Unix-socket guard serializes lock acquisition; the filesystem socket `lock.sock`
remains held for the writer's lifetime. Loading skips torn JSON lines and repairs a
missing final newline. Keep backups of both streams; rebuilding the tree costs model calls.

Short sources that fit `NODE` become free nodes without a model call. They retain
their original text, including newlines. Longer sources are summarized. The view
flattens stored newlines and shows `id+n|text` rows. `zoom` opens a node's children
or a stored message; tool results remain subject to `CAP`.

The live view appends at the end and merges the most-due eligible pair. A built
parent can replace its children; merged parts never split. Turns wait for summaries
with `settle`, rather than receiving cut message text.

**Privacy:** logs and summaries contain your chat text. Keep the data directory
separate from the source checkout and restrict access to its backups. The default
data paths and `.env` files are ignored by Git. Custom data paths need their own
ignore rules. Summarization sends context and source text to the configured provider.

Git persistence is off by default. `--git` enables local per-turn commits only
for a separate data repository. It does not publish data to a remote repository.

## Constants

- NODE 512 bytes target per summary line
- VIEW 128000 bytes budget
- JOBS 8 parallel compactor calls
- TRIES 5 size attempts per node
- RETRY 10 s failed node retry delay
- CAP 30000 characters max tool result kept (head + cut note + tail)
- MARKS 50000 / 80000 / 100000 character offsets for stable view pieces

`NODE`, `VIEW`, and stored `size` fields use UTF-8 bytes via `Buffer.byteLength`.
`CAP` and `MARKS` use character limits/offsets, not byte budgets. Character cuts
preserve surrogate pairs. None of these values are token counts. `NODE` is a target:
after the size attempts, a model node may retain its shortest oversized reply.

## Caching and verification

Native OpenAI-compatible Chat Completions relies on the provider's implicit
prefix caching. The system prompt and tool definitions stay byte-identical.
The view splitter forms stable text pieces at line ends before `MARKS`. This
does not enable unsupported explicit cache flags or guarantee cache hits.

Tests use offline scripted providers. They check request history, memory-tool
execution, and storage/view behavior without real credentials. No live-provider
cache measurements or compatibility claims are included.

```sh
bun test
bun run typecheck
```

CI runs these checks after a frozen-lockfile install. The package remains private;
`bun link` installs the local CLI without publishing it to a package registry.

## Layout

- `src/constants.ts` budgets and kinds
- `src/storage/` log, tree store, single-writer lock
- `src/tree/` address math `id+n`
- `src/view/` incremental fold + render
- `src/compactor/` pump order + prompts (original) + size loop
- `src/model/` native Chat Completions adapter
- `src/turn/` fresh-turn orchestration
- `src/tools/` zoom + date
- `src/cache/` stable view splitter
- `src/cli.ts` plain terminal, no TUI redraws
- `src/browse.ts`, `src/import.ts` helpers; browser/import commands are deferred
- `tests/` offline provider integration and core invariants

## License note

This repository's code is covered by [LICENSE](LICENSE). The pinned gist has no
LICENSE statement. Its prompts are not copied here; this repository uses its own wording.
