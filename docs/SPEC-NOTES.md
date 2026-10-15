# OptChat core spec notes

Reference: [OptChat specification, pinned revision](https://gist.githubusercontent.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449/raw/3c190e06f34aba0c69f49042c526093269604935/optchat.md).
This file records the core contract and release limits. It does not reproduce
the reference's prompts. Repository prompts use original wording.

## Spec parity (recorded 2026-10-15)

Status against pinned revision `3c190e06`, verified in this tree at `06f910d`.
Adopted parts were confirmed in `src/` at recording time. Eleven of the twelve
parity gaps landed on 2026-10-15 through the parity merge train (PRs #14 and
#16-#25); the remaining one carries its tracking issue.

Adopted:

- Merge order measures a pair's due time from its last message
  (`bestPair` in `src/view/fold.ts`), not from its first.
- View merges are batched: the live view grows without merging and drops
  to `LOW` in one batch once past `VIEW` (`sawtooth` in `src/view/fold.ts`).
- The view is persisted and resumed, rebuilt only when the saved view cannot
  be trusted (`src/view/persist.ts`).
- One shared system prompt serves turns and compactions byte-identically
  (`TURN_SYSTEM = SHARED_SYSTEM` in `src/turn/loop.ts`), so compactions
  read the cached prefix the turns already wrote.
- #1 Subagent reports are stored as a `work` kind with a `[Name] ` author
  prefix; older `user`-kind reports stay readable.
- #2 Long non-echo text is logged as several cap-bounded messages in a row
  (`splitLogText` in `src/storage/log.ts`); the whole text still reaches
  the model in one turn input.
- #4 Compactions take their context from their own 16-32 KB view derived
  from the built prefix (`src/view/compaction.ts`).
- #5 The compactor's size ruler is 512 dashes, not a sample line.
- #6 Compaction payloads are wrapped in `<input>` tags in both step builders.
- #7 A leaf starts once fewer than 8 unbuilt view lines precede it
  (`firstUnbuilt(..., 7)` in `src/compactor/pump.ts`).
- #8 A merge starts once both its halves are built; its context is cut at
  the first unbuilt line, never across a hole.
- #9 Ready nodes are kept in queues; the tree is walked once per load, never
  per pump (`ReadyQueues` in `src/compactor/pump.ts`).
- #10 A failed compaction retries at the next message — arrival or append —
  never on a timer (`failedAt` generations in `src/compactor/pump.ts`).
- #11 `zoom(id, 1)` returns long messages in pages; the page selector is
  this repo's own extension, since the reference defines no paging API
  (see the pagination deviation note under "Turn state and native tools").
- #12 The turn prompt carries both navigation rules: the view's newest
  mention is the truth to zoom whole before anything else, and zoom is the
  only way through memory, never a grep or file search.

Divergent:

- #3 View marks are fixed `MARKS` offsets (50000/80000/100000), not
  4-line blocks plus the request end. Open PR #26 implements only the
  splitter; the Responses-adapter cache breakpoints and the request-end
  mark are still unwired.

## Release boundary

The core release is a Bun CLI with zero runtime dependencies. It connects to an
OpenAI-compatible native Chat Completions provider and exposes `zoom` and `date`.
Storage paths include scope keys; phase 1 exposes only `global` in the CLI.
The package stays private. Local CLI installation is separate from publication.

Linux is the verified runtime, with Bun 1.4.0. macOS is expected to work but has
not been verified end to end. The writer lock is portable: an advisory `flock`
serialises stale-socket takeover, and its kernel lifetime needs no PID file and
no timeout. A Unix domain socket stays bound for the writer's lifetime as the
visible marker. Windows is not supported, because that socket is a Unix domain
socket. An always-on host with a persistent terminal session supports continued
operation while users disconnect and attach again.

Product subagents, computer use, external session bridges, a semantic index,
and history-import/browser commands are deferred. Source helpers for importing
text and rendering HTML do not mean those commands are wired into the CLI.
Reports can be captured with the stored `work` kind and a `[Name] ` author
prefix. This does not provide an available `spawn` or `tell` tool, or named zoom.
Older reports stored as `user` messages remain readable without migration.

## Turn state and native tools

- Settle the view before a model-backed turn. Capture it before appending the
  new user message. The new message is supplied whole, separate from prior memory.
- Start each turn with new conversation state. Prior turns persist through the
  log and summary view, not by carrying an old provider conversation forward.
- Within a turn, resend the full native message history. Retain assistant tool
  calls and their IDs, matching tool-role results, and input accepted at tool
  boundaries. Do not replace earlier messages with the latest tool result.
- Retain provider reasoning fields in active assistant messages when returned.
  The permanent log records `user`, `talk`, `tool`, `echo`, `note`, and `work`, not reasoning.
- Keep system text and tool definitions byte-identical across requests. An
  optional instructions file is read once at startup, not once per tool round.
  The default is `<dir>/instructions.md` when present; `--instructions` overrides it.
- Provider responses are buffered with `stream: false`. Entries become available
  after completed responses or tool calls; the CLI does not stream tokens.
- `zoom(id, n)` navigates an aligned binary range. At `n = 1`, it reads the stored
  message. `date(id)` reads that message's stored timestamp. Tool-result capping
  applies even when the source message is larger than the result limit.
- Pagination deviation: `zoom(id, 1, page?)` uses optional 1-based pages,
  defaulting to page 1. Short results retain their exact legacy format. Long
  results use `id+0|page p/count chars start:end` followed by a newline and
  verbatim payload, including the stored kind prefix. Offsets are UTF-16 units
  in that payload source. Join payloads in page order for lossless reconstruction.
  Fixed payload budgets reserve 100 characters for metadata and preserve
  surrogate pairs. The entire result stays within CAP, so adapter head-tail
  capping is a no-op. Pages on ranges, noninteger/nonpositive pages, and pages
  beyond the message are refused. This extends the reference's two-argument
  tool rather than allowing its raw-message result to be irretrievably capped.
- The turn prompt carries two navigation rules: the view's newest mention of a
  thing is the one that counts, so zoom it to the whole message before any other
  source and before acting, assuming or asking; and zoom is the only way through
  memory, never a grep or search of the chat or tree files.

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
- A leaf builds once fewer than 8 unbuilt view lines precede it. A merge
  starts once both its halves are built. Compaction context ends at the
  first unbuilt line, so it never contains a gap or placeholder. Failed
  nodes retry when the chat advances — an appended message, or queued input
  that will become one — never on a timer; report the first failure rather
  than repeating it.
- Fold the view on load. During a run, append at the end; once past `VIEW`,
  merge the most-due eligible pairs in one batch down to `LOW`. Replace
  children only with a built parent. Never split
  an already merged part or rebuild the live tiling on every summary completion.
- A display placeholder is not model context. Model-backed turns wait via
  `settle`; they never receive a cut prefix of an unbuilt source.

## Storage and privacy

Use append-only `chat/<scope>/main/YYYY-MM-DD.jsonl` and
`tree/<scope>/YYYY-MM-DD.jsonl` under the data directory. Each append writes and
fsyncs before returning. Loading skips torn JSON lines and repairs missing final
newlines. An advisory `flock` serializes acquisition and stale-socket
takeover. Hold the filesystem socket `<dir>/lock.sock` for the writer's lifetime.
Git persistence is disabled by default. `--git` opts into local per-turn commits
in a separate data repository; it does not publish to a remote repository.

The log is the source of truth. Stored nodes avoid the provider cost of rebuilding
the tree. Back up both. Do not publish chat data, credentials, or personal identity
traces with the source release. URL diagnostics retain only scheme, host, and path;
strip userinfo and all query parameters before reporting them.

## ChatGPT plan usage

`--login` runs OpenAI's Sign in with ChatGPT and spends a ChatGPT plan instead
of per-token API fees. It is a public OAuth client: no client secret, no API key.

- Authorization: `auth.openai.com/api/accounts/authorize`. Token exchange and
  refresh: `auth.openai.com/api/accounts/oauth/token`.
- First registration sends `client_id=dynamic_agent_client`. The callback
  returns the issued `client_id`, which is what gets stored. The registration
  entrypoint is never saved as the connection's id.
- The redirect URI is `http://127.0.0.1:<port>/auth/callback`. Only the port may
  vary; scheme, host and path are fixed, and `localhost` must not be substituted.
- Scopes: `openid profile email offline_access resource.invoke
  chatgpt.tokens.use.direct`. The last one is what authorises plan usage, and its
  presence in the granted scopes is checked before anything is stored.
- PKCE S256, fresh `state` and `nonce` per attempt. The ID token is verified
  against OpenAI's published JWKS: signature, issuer, audience (the issued client
  id), expiry and nonce.
- The host identifier is an opaque URN persisted once per host. It must never
  encode an email, user id, or other identifying value.
- Access tokens last one hour; refresh tokens last 30 days and rotate on every
  successful refresh. The rotating refresh token replaces the old one together
  with the access token and scopes.
- Credentials are stored owner-only outside the chat data directory.

Inference on this route uses the **Responses API**, which differs from the
Chat Completions adapter in hard ways:

| Requirement | Note |
| --- | --- |
| `store: false`, `stream: true` | Both mandatory on every request |
| System text in `instructions` | A system-role input item is rejected |
| Full history in `input` | `previous_response_id` is not allowed |
| Tools as an `additional_tools` input item | `role: "developer"` with a `tools` array |
| No `temperature`, `top_p`, `user`, `metadata`, `truncation` | Rejected outright |

Success is only `response.completed`. `response.failed` can carry
`subscription_sharing_usage_limit_exceeded` or
`subscription_sharing_usage_unavailable`, and `response.incomplete` is a
separate case. Provider bodies are never echoed.

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
