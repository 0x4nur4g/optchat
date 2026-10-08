/**
 * OpenAI-compatible chat-completions adapter. Plain fetch, no deps.
 *
 * Env: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL; optional
 * OPENAI_COMPACTOR_MODEL uses the same endpoint and key. The key only ever
 * leaves this process as an Authorization header; it is never logged. Any
 * URL that reaches console output is redacted first (userinfo and query
 * stripped), because a base URL can carry credentials in both places.
 */
import { splitViewForCache } from "../cache/marks";
import { capToolResult } from "../compactor/prompts";
import type { CompactionAdapter, CompactionSession, ToolDefinition, TurnAdapter, TurnEntry, TurnRequest } from "./adapter";

export interface OpenAIEnv {
  baseUrl: string;
  apiKey: string;
  model: string;
  compactorModel?: string;
}

export interface OpenAIOptions {
  tools?: readonly ToolDefinition[];
  runTool?: (name: string, input: Record<string, unknown>) => string | Promise<string>;
  /** Caller retains taken inputs until the turn succeeds, including entries not yet logged. */
  takePending?: () => string[];
  onUsage?: (usage: { input: number; cached: number; output: number }) => void;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Three required env vars; null when any is blank. Malformed config throws without values. */
export function readEnv(
  env: Record<string, string | undefined> = process.env,
): OpenAIEnv | null {
  const baseUrl = env["OPENAI_BASE_URL"]?.trim();
  const apiKey = env["OPENAI_API_KEY"]?.trim();
  const model = env["OPENAI_MODEL"]?.trim();
  if (!baseUrl || !apiKey || !model) return null;
  const compactorModel = env["OPENAI_COMPACTOR_MODEL"]?.trim();
  return validateEnv({ baseUrl, apiKey, model, ...(compactorModel ? { compactorModel } : {}) });
}

/** URL for logs: scheme + host + path only. Never credentials or query. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "(unparseable url)";
  }
}

const REQUEST_TIMEOUT_MS = 120_000;
type Message = Record<string, unknown>;

export class OpenAICompat implements TurnAdapter, CompactionAdapter {
  private readonly env: OpenAIEnv;
  private readonly url: string;
  private readonly tools: { type: "function"; function: ToolDefinition }[];

  constructor(env: OpenAIEnv, private readonly options: OpenAIOptions = {}) {
    this.env = validateEnv(env);
    const url = new URL(this.env.baseUrl);
    // Append to pathname, not the raw URL: deliberate query auth stays intact.
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
    this.url = url.toString();
    // Snapshot definitions once, so caller mutations cannot change the prefix.
    this.tools = JSON.parse(JSON.stringify((options.tools ?? []).map((tool) => ({
      type: "function", function: tool,
    }))));
  }

  /** Buffered Chat Completions; entries are yielded after each response/tool finishes. */
  async *ask(req: TurnRequest): AsyncIterable<TurnEntry> {
    const messages: Message[] = [
      { role: "system", content: req.system },
      {
        role: "user",
        content: [
          ...splitViewForCache(req.view).pieces.filter(Boolean).map((text) => ({ type: "text", text })),
          { type: "text", text: req.userText },
        ],
      },
    ];
    for (;;) {
      checkAbort(req.signal);
      const message = await this.chat(messages, this.env.model, req.signal, this.tools);
      messages.push(message); // Keep every provider field, not a reconstructed assistant message.
      for (const text of thoughts(message)) {
        checkAbort(req.signal);
        yield { kind: "thought", text };
      }
      checkAbort(req.signal);
      const content = contentText(message);
      if (content) yield { kind: "talk", text: content };
      const calls = message.tool_calls;
      if (calls == null || (Array.isArray(calls) && calls.length === 0)) {
        if (content === null) throw new Error("model reply had no content");
        return;
      }
      if (!Array.isArray(calls)) throw new Error("model reply had invalid tool calls");
      const decoded = calls.map(decodeToolCall); // Validate IDs before any handler can run.
      for (const call of decoded) {
        checkAbort(req.signal);
        yield { kind: "tool", text: `${call.name} ${JSON.stringify(call.input ?? { error: call.error })}` };
        checkAbort(req.signal);
        let result = call.error;
        if (!result && !this.tools.some((tool) => tool.function.name === call.name)) {
          result = "error: unknown tool";
        }
        if (!result && !this.options.runTool) result = "error: tool handler unavailable";
        if (!result) {
          try {
            result = await abortable(() => this.options.runTool!(call.name, call.input!), req.signal);
          } catch {
            checkAbort(req.signal);
            result = "error: tool failed";
          }
        }
        checkAbort(req.signal);
        const text = capToolResult(result!);
        messages.push({ role: "tool", tool_call_id: call.id, content: text });
        yield { kind: "echo", text };
      }
      checkAbort(req.signal);
      // Finish all native results before user messages, even if a provider
      // returns multiple calls despite parallel_tool_calls:false.
      const pending = this.options.takePending?.() ?? [];
      for (const text of pending) {
        messages.push({ role: "user", content: text });
        // Deliver every taken item before checking abort again. The caller
        // can retain yielded but unanswered inputs when a follow-up fails.
        yield { kind: "user", text };
      }
    }
  }

  /** Context comes first; retries append feedback without replacing earlier attempts. */
  openCompaction(
    contextLines: string[], step: string, system: string, signal?: AbortSignal,
  ): CompactionSession {
    const messages: Message[] = [
      { role: "system", content: system },
      { role: "user", content: [
        { type: "text", text: `<chat>\n${contextLines.join("\n")}\n</chat>` },
        { type: "text", text: step },
      ] },
    ];
    return {
      reply: async (feedback) => {
        if (feedback !== undefined) messages.push({ role: "user", content: feedback });
        const message = await this.chat(messages, this.env.compactorModel ?? this.env.model, signal);
        messages.push(message);
        const content = contentText(message);
        if (content === null) throw new Error("model reply had no content");
        return content;
      },
    };
  }

  private async chat(
    messages: Message[], model: string, signal?: AbortSignal,
    tools?: { type: "function"; function: ToolDefinition }[],
  ): Promise<Message> {
    checkAbort(signal);
    const url = this.url;
    const requestSignal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]);
    let res: Response;
    try {
      res = await abortable(() => (this.options.fetch ?? fetch)(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.env.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          ...(tools && tools.length > 0 ? { tools, parallel_tool_calls: false } : {}),
          stream: false,
        }),
        signal: requestSignal,
      }), requestSignal);
    } catch {
      throw requestFailure(url, requestSignal, signal, "model request failed");
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      // Provider error bodies and transport exceptions can echo credentials.
      throw new Error(`model http ${res.status} at ${redactUrl(url)}`);
    }
    let data: unknown;
    try {
      data = await abortable(() => res.json(), requestSignal);
    } catch {
      throw requestFailure(url, requestSignal, signal, "model reply was not valid JSON");
    }
    if (requestSignal.aborted) throw requestFailure(url, requestSignal, signal, "model request failed");
    const message = pickMessage(data);
    if (message === null) throw new Error(`model reply had no assistant message at ${redactUrl(url)}`);
    if (isObject(data) && isObject(data.usage) && this.options.onUsage) {
      const usage = data.usage;
      const input = counter(usage.prompt_tokens);
      const cached = isObject(usage.prompt_tokens_details) ? counter(usage.prompt_tokens_details.cached_tokens) : 0;
      try {
        this.options.onUsage({ input, cached: Math.min(input, cached), output: counter(usage.completion_tokens) });
      } catch {
        throw new Error("model usage callback failed");
      }
    }
    return message;
  }
}

function validateEnv(env: OpenAIEnv): OpenAIEnv {
  for (const [name, value] of [
    ["OPENAI_BASE_URL", env.baseUrl], ["OPENAI_API_KEY", env.apiKey], ["OPENAI_MODEL", env.model],
    ...(env.compactorModel === undefined ? [] : [["OPENAI_COMPACTOR_MODEL", env.compactorModel]]),
  ]) {
    if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`invalid ${name}`);
    }
  }
  const baseUrl = env.baseUrl.trim();
  try {
    const url = new URL(baseUrl);
    if (!/^https?:\/\//i.test(baseUrl) || !["http:", "https:"].includes(url.protocol)
      || !url.hostname || url.username || url.password || baseUrl.includes("#")) throw new Error();
  } catch {
    throw new Error("invalid OPENAI_BASE_URL: expected an HTTP URL without userinfo or fragment");
  }
  return {
    baseUrl, apiKey: env.apiKey.trim(), model: env.model.trim(),
    ...(env.compactorModel === undefined ? {} : { compactorModel: env.compactorModel.trim() }),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("turn aborted", "AbortError");
}

function requestFailure(url: string, combined: AbortSignal, supplied: AbortSignal | undefined, problem: string): Error {
  if (supplied?.aborted) return new DOMException("turn aborted", "AbortError");
  if (combined.aborted) return new Error(`model request timed out at ${redactUrl(url)}`);
  return new Error(`${problem} at ${redactUrl(url)}`);
}

function counter(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Stop waiting, not the injected handler itself. Always consume late rejection. */
function abortable<T>(run: () => T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  checkAbort(signal);
  if (!signal) return Promise.resolve().then(run);
  return new Promise<T>((resolve, reject) => {
    const clear = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      clear();
      reject(new DOMException("turn aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      Promise.resolve(run()).then(
        (value) => { clear(); resolve(value); },
        (error: unknown) => { clear(); reject(error); },
      );
    } catch (error) {
      clear();
      reject(error);
    }
  });
}

function pickMessage(data: unknown): Message | null {
  if (!isObject(data)) return null;
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  if (!isObject(choices[0])) return null;
  const message = choices[0].message;
  return isObject(message) && message.role === "assistant" ? message : null;
}

function contentText(message: Message): string | null {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    const text = message.content.flatMap((part) => {
      if (!isObject(part)) return [];
      if (part.type === "text" && typeof part.text === "string") return [part.text];
      if (part.type === "refusal" && typeof part.refusal === "string") return [part.refusal];
      return [];
    });
    if (text.length > 0) return text.join("");
  }
  return typeof message.refusal === "string" ? message.refusal : null;
}

function thoughts(message: Message): string[] {
  const text: string[] = [];
  for (const value of [message.reasoning_content, message.reasoning, message.reasoning_details]) {
    if (typeof value === "string" && value) text.push(value);
    if (Array.isArray(value)) {
      for (const part of value) {
        if (!isObject(part)) continue;
        if (typeof part.text === "string" && part.text) text.push(part.text);
        else if (typeof part.summary === "string" && part.summary) text.push(part.summary);
      }
    }
  }
  return [...new Set(text)];
}

function decodeToolCall(raw: unknown): {
  id: string; name: string; input?: Record<string, unknown>; error?: string;
} {
  if (!isObject(raw) || typeof raw.id !== "string" || !raw.id) {
    // Without an ID there is no valid native result to send; never invent one.
    throw new Error("model tool call had no id");
  }
  if (raw.type !== "function" || !isObject(raw.function) || typeof raw.function.name !== "string") {
    return { id: raw.id, name: "invalid", error: "error: invalid function call" };
  }
  const { name, arguments: args } = raw.function;
  try {
    if (typeof args !== "string") throw new Error();
    const input: unknown = JSON.parse(args);
    if (!isObject(input)) throw new Error();
    return { id: raw.id, name, input };
  } catch {
    return { id: raw.id, name, error: "error: tool arguments must be a JSON object" };
  }
}
