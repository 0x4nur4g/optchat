import { capToolResult } from "../compactor/prompts";
import type {
  CompactionAdapter,
  CompactionSession,
  ToolDefinition,
  TurnAdapter,
  TurnEntry,
  TurnRequest,
} from "./adapter";
import { parseSseJson } from "./sse";

// Sign in with ChatGPT plan usage over the Responses API. This route has hard
// constraints the Chat Completions adapter does not: `store: false` and
// `stream: true` are mandatory, the system text travels as `instructions`
// because a system-role input item is rejected, tools arrive as an
// `additional_tools` input item, and the full history must be resent every
// request because `previous_response_id` is not allowed.

export const RESPONSES_URL = "https://api.openai.com/v1/responses";
export const MODELS_URL = "https://api.openai.com/v1/models";

export interface ResponsesOptions {
  /** Supplies a current access token; the caller handles refresh. */
  getAccessToken: () => string | Promise<string>;
  model: string;
  tools?: readonly ToolDefinition[];
  runTool?: (name: string, input: Record<string, unknown>) => string | Promise<string>;
  takePending?: () => string[];
  onUsage?: (usage: { input: number; cached: number; output: number }) => void;
  fetch?: typeof fetch;
  baseUrl?: string;
}

type InputItem = Record<string, unknown>;

// Fields this route rejects outright. Only these are ever sent.
function requestBody(model: string, instructions: string, input: InputItem[]): Record<string, unknown> {
  return { model, instructions, input, store: false, stream: true };
}

function toolItems(tools: readonly ToolDefinition[]): InputItem[] {
  if (tools.length === 0) return [];
  return [{
    type: "additional_tools",
    role: "developer",
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  }];
}

function textOf(item: Record<string, unknown>): string {
  const content = item["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const p = part as Record<string, unknown>;
      return typeof p["text"] === "string" ? p["text"] : "";
    }).join("");
  }
  return "";
}

/** Convert one provider output item into the neutral entries the CLI logs. */
function entriesFor(item: Record<string, unknown>): TurnEntry[] {
  const type = item["type"];
  if (type === "reasoning") {
    const text = textOf(item);
    return text.length > 0 ? [{ kind: "thought", text }] : [];
  }
  if (type === "message") {
    const text = textOf(item);
    return text.length > 0 ? [{ kind: "talk", text }] : [];
  }
  return [];
}

export class OpenAIResponses implements TurnAdapter, CompactionAdapter {
  private readonly options: ResponsesOptions;
  private readonly url: string;

  constructor(options: ResponsesOptions) {
    this.options = options;
    this.url = `${(options.baseUrl ?? RESPONSES_URL).replace(/\/+$/, "")}`;
  }

  async *ask(req: TurnRequest): AsyncIterable<TurnEntry> {
    // Fresh state per turn. Within the turn the full history is resent, with
    // native call ids and their outputs kept intact.
    const input: InputItem[] = [...toolItems(this.options.tools ?? [])];
    input.push({
      role: "user",
      content: [
        { type: "input_text", text: req.view },
        { type: "input_text", text: req.userText },
      ],
    });

    for (;;) {
      const response = await this.complete(input, req.system, req.signal);
      const output = Array.isArray(response["output"]) ? response["output"] : [];
      const calls: Record<string, unknown>[] = [];

      for (const raw of output) {
        const item = raw as Record<string, unknown>;
        for (const entry of entriesFor(item)) {
          yield entry;
          if (entry.kind === "talk") input.push({ role: "assistant", content: entry.text });
        }
        if (item["type"] === "function_call") calls.push(item);
        if (item["type"] === "reasoning") input.push(item); // keep raw provider metadata
      }

      if (calls.length === 0) return;

      for (const call of calls) {
        const callId = String(call["call_id"] ?? "");
        const name = String(call["name"] ?? "");
        input.push(call); // keep the native call and its id
        yield { kind: "tool", text: `${name} ${String(call["arguments"] ?? "{}")}` };

        let outputText: string;
        if (this.options.runTool === undefined) {
          outputText = "error: tool handler unavailable";
        } else {
          let parsed: Record<string, unknown> | null = null;
          try {
            const decoded: unknown = JSON.parse(String(call["arguments"] ?? "{}"));
            if (typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)) {
              parsed = decoded as Record<string, unknown>;
            }
          } catch {
            parsed = null;
          }
          if (parsed === null) {
            outputText = "error: tool arguments must be a JSON object";
          } else {
            try {
              outputText = await this.options.runTool(name, parsed);
            } catch {
              outputText = "error: tool failed";
            }
          }
        }

        const capped = capToolResult(outputText);
        input.push({ type: "function_call_output", call_id: callId, output: capped });
        yield { kind: "echo", text: capped };
      }

      // Boundary input arrives only after every native result is complete.
      for (const text of this.options.takePending?.() ?? []) {
        input.push({ role: "user", content: text });
        yield { kind: "user", text };
      }
    }
  }

  openCompaction(
    contextLines: string[],
    step: string,
    system: string,
    signal?: AbortSignal,
  ): CompactionSession {
    const input: InputItem[] = [{
      role: "user",
      content: [
        { type: "input_text", text: `<chat>\n${contextLines.join("\n")}\n</chat>` },
        { type: "input_text", text: step },
      ],
    }];
    return {
      reply: async (feedback) => {
        if (feedback !== undefined) input.push({ role: "user", content: feedback });
        const response = await this.complete(input, system, signal);
        const output = Array.isArray(response["output"]) ? response["output"] : [];
        for (const raw of output) {
          const item = raw as Record<string, unknown>;
          if (item["type"] === "message") {
            const text = textOf(item).trim().replace(/\r\n?|\n/g, " ");
            if (text.length > 0) return text;
          }
        }
        throw new Error("optchat: compactor returned no line");
      },
    };
  }

  /** One streamed request. Resolves only on `response.completed`. */
  private async complete(
    input: InputItem[],
    instructions: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const token = await this.options.getAccessToken();
    const res = await (this.options.fetch ?? fetch)(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(requestBody(this.options.model, instructions, input)),
      signal,
    });
    if (!res.ok || res.body === null) {
      // Never echo a provider body: it can contain account or quota detail.
      throw new Error(`optchat: model http ${res.status}`);
    }

    let terminal: Record<string, unknown> | null = null;
    for await (const event of parseSseJson(res.body)) {
      const type = event["type"];
      if (type === "response.completed") {
        terminal = (event["response"] as Record<string, unknown>) ?? {};
      } else if (type === "response.failed" || type === "response.incomplete") {
        const response = (event["response"] ?? {}) as Record<string, unknown>;
        const error = (response["error"] ?? {}) as Record<string, unknown>;
        const code = typeof error["code"] === "string" ? error["code"] : String(type);
        throw new Error(`optchat: model response failed (${code})`);
      }
    }
    if (terminal === null) throw new Error("optchat: model stream ended without completion");
    this.reportUsage(terminal);
    return terminal;
  }

  private reportUsage(response: Record<string, unknown>): void {
    if (this.options.onUsage === undefined) return;
    const usage = (response["usage"] ?? {}) as Record<string, unknown>;
    const details = (usage["input_tokens_details"] ?? {}) as Record<string, unknown>;
    const number = (value: unknown): number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    const input = number(usage["input_tokens"]);
    this.options.onUsage({
      input,
      cached: Math.min(input, number(details["cached_tokens"])),
      output: number(usage["output_tokens"]),
    });
  }
}

/** Model catalog for the signed-in account, in server order. */
export async function listModels(
  getAccessToken: () => string | Promise<string>,
  fetchFn: typeof fetch = fetch,
): Promise<Array<{ slug: string; displayName: string }>> {
  const res = await fetchFn(MODELS_URL, {
    headers: { authorization: `Bearer ${await getAccessToken()}` },
  });
  if (!res.ok) throw new Error(`optchat: model list failed (http ${res.status})`);
  const payload = await res.json() as { models?: unknown[] };
  const models = Array.isArray(payload.models) ? payload.models : [];
  return models
    .filter((entry) => (entry as Record<string, unknown>)["visibility"] === "list")
    .map((entry) => {
      const model = entry as Record<string, unknown>;
      return {
        slug: String(model["slug"] ?? ""),
        displayName: String(model["display_name"] ?? model["slug"] ?? ""),
      };
    })
    .filter((model) => model.slug.length > 0);
}
