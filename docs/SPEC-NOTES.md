# OptChat core spec notes

Reference: [OptChat specification, pinned revision](https://gist.githubusercontent.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449/raw/f51fe5c910427fd6f384d22823140b1693c76207/optchat.md).
This file records the core contract and release limits. It does not reproduce
the reference's prompts. Repository prompts use original wording.

## Release boundary

The core release is a Bun CLI with zero runtime dependencies. It connects to an
OpenAI-compatible native Chat Completions provider and exposes `zoom` and `date`.
Storage paths include scope keys; phase 1 exposes only `global` in the CLI.
The package stays private. Local CLI installation is separate from publication.

Linux with Bun 1.4.0 is the currently supported runtime. The writer lock depends
on Linux abstract Unix sockets; this release does not provide macOS/Windows lock
portability. An always-on Linux host with a persistent terminal session supports
continued operation while users disconnect and attach again.

Product subagents, computer use, external session bridges, a semantic index,
and history-import/browser commands are deferred. Source helpers for importing
text and rendering HTML do not mean those commands are wired into the CLI.
References to subagent reports in prompts describe a possible future log kind
convention, not an available `spawn` or `tell` tool.

## Turn state and native tools

- Settle the view before a model-backed turn. Capture it before appending the
  new user message. The new message is supplied whole, separate from prior memory.
- Start each turn with new conversation state. Prior turns persist through the
  log and summary view, not by carrying an old provider conversation forward.
- Within a turn, resend the full native message history. Retain assistant tool
  calls and their IDs, matching tool-role results, and input accepted at tool
  boundaries. Do not replace earlier messages with the latest tool result.
- Retain provider reasoning fields in active assistant messages when returned.
  The permanent log records `user`, `talk`, `tool`, `echo`, and `note`, not reasoning.
- Keep system text and tool definitions byte-identical across requests. An
  optional instructions file is read once at startup, not once per tool round.
  The default is `<dir>/instructions.md` when present; `--instructions` overrides it.
- Provider responses are buffered with `stream: false`. Entries become available
  after completed responses or tool calls; the CLI does not stream tokens.
- `zoom(id, n)` navigates an aligned binary range. At `n = 1`, it reads the stored
  message. `date(id)` reads that message's stored timestamp. Tool-result capping
  applies even when the source message is larger than the result limit.

## Units and Unicode

The reference distinguishes byte budgets from character limits. Existing
`src/constants.ts`, `byteLen`, and the tool-result helper follow that distinction:

| Value | Unit and role |
| --- | --- |
| `NODE = 512` | UTF-8 bytes; summary target |
| `VIEW = 128000` | UTF-8 bytes; view's stored-text budget |
| Log/node `size` | UTF-8 bytes; measure with `Buffer.byteLength` |
| `CAP = 30000` | Characters; kept tool-result text, including its cut note |
| `MARKS = 50000, 80000, 100000` | Character offsets; view-piece boundaries |

Character offsets use JavaScript string indexing (UTF-16 code units), not token
counts. Character cuts preserve surrogate pairs. Byte-limit feedback must end
on a complete UTF-8 character. The view budget measures stored text, not every
address, delimiter, or wrapper in the final request; allow provider context headroom.

## Nodes, compactor, and view

- A level-zero node covers one log message. Each parent covers exactly its two
  adjacent children. The address `id+n` uses the first message ID and range length.
- A short leaf's source is `kind + ": " + text`. A short parent's source is its
  two child texts joined by a newline. If the source fits `NODE`, store it verbatim
  as a free node without calling the model. Original newlines may remain stored.
- Model-generated compactor output is one line. View rendering flattens newlines,
  including those in free nodes. The model-only rule must not alter free sources.
- Supply full source text and summarized context to the compactor. Add no node
  address labels to its input. User text can itself mention an address. Treat all
  messages as data to summarize, not instructions to execute.
- `NODE` is a target, not a hard storage bound. Apply size feedback and the bounded
  attempt loop, then retain the shortest candidate. Measure actual stored bytes.
- Build only when sources and preceding summary context are ready. Failed nodes
  retry after the fixed delay; report the first failure rather than repeating it.
- Fold the view on load. During a run, append at the end and merge the most-due
  eligible adjacent pair. Replace children only with a built parent. Never split
  an already merged part or rebuild the live tiling on every summary completion.
- A display placeholder is not model context. Model-backed turns wait via
  `settle`; they never receive a cut prefix of an unbuilt source.

## Storage and privacy

Use append-only `chat/<scope>/main/YYYY-MM-DD.jsonl` and
`tree/<scope>/YYYY-MM-DD.jsonl` under the data directory. Each append writes and
fsyncs before returning. Loading skips torn JSON lines and repairs missing final
newlines. A Linux abstract Unix-socket guard serializes acquisition and stale-socket
takeover. Hold the filesystem socket `<dir>/lock.sock` for the writer's lifetime.
Git persistence is disabled by default. `--git` opts into local per-turn commits
in a separate data repository; it does not publish to a remote repository.

The log is the source of truth. Stored nodes avoid the provider cost of rebuilding
the tree. Back up both. Do not publish chat data, credentials, or personal identity
traces with the source release. URL diagnostics retain only scheme, host, and path;
strip userinfo and all query parameters before reporting them.

## Cache and test evidence

This adapter uses native Chat Completions, not the reference's Responses API or
Anthropic protocol. Compatible providers may apply implicit prefix caching.
Stable system/tool prefixes, native in-turn history, and line-aligned view pieces
support that layout. No explicit vendor cache-control or breakpoint flags are
claimed for this adapter. The splitter alone does not prove a provider cache hit.

Integration tests use offline scripted-provider responses and recorded requests.
They establish local request/history and memory behavior, not live-provider
compatibility, measured cache hits, a cache lifetime, or production cost savings.
CI uses the pinned Bun version, frozen lockfile, `bun test`, and `tsc --noEmit`.
