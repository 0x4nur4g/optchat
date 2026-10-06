# OptChat core (phase 1)

Standalone harness. One endless chat. The chat history is the memory.

Inspired by VictorTaelin OptChat gist (2026-10-06) and OptMem.
Prompts here are original wording. No verbatim copy from the gist.
Structure follows the same architecture. See `docs/SPEC-NOTES.md`.

## Shape

```
A. optchat-core (this repo, Bun, zero runtime deps):
   chat/<scope>/main/YYYY-MM-DD.jsonl  log, append-only
   tree/<scope>/YYYY-MM-DD.jsonl  nodes, cache
   single-writer lock + background compactor + incremental view
   fresh model call per turn + zoom/date tools + cache marks

B. optchat-bridge (later, thin adapter):
   exposes zoom/date to OpenCode/Codex/Claude sessions
```

Phase 1 ships A with `global` scope only. Storage keys by scope
from day one (`chat/<scope>/`, `tree/<scope>/`) for later
project-local split. No side index yet. No bridge yet.

## Constants

- NODE 512 bytes target per summary line
- VIEW 128000 bytes budget
- JOBS 8 parallel compactor calls
- TRIES 5 size retries per node
- RETRY 10 s failed node retry delay
- CAP 30000 chars max tool result kept (head + tail)
- MARKS 50000 / 80000 / 100000 chars cache breakpoints

Sizes are UTF-8 bytes, never tokens.

## Run

```sh
bun install
bun run src/cli.ts --scope global --dir ./data
bun test
```

## Layout

- `src/constants.ts` budgets and kinds
- `src/storage/` log, tree store, single-writer lock
- `src/tree/` address math `id+n`
- `src/view/` incremental fold + render
- `src/compactor/` pump order + prompts (original) + size loop
- `src/turn/` fresh-turn loop
- `src/tools/` zoom + date
- `src/cache/` breakpoint splitter
- `src/cli.ts` plain terminal, no TUI redraws
- `src/browse.ts` HTML dump, `src/import.ts` history import
- `tests/` view fold, due, address, size, lock rules

## License note

Gist has no LICENSE statement. Do not paste COMPACT, MASTER,
VIEW_DOC verbatim. This repo uses own wording.
