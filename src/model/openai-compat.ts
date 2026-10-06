/**
 * OpenAI-compatible chat-completions adapter. Plain fetch, no deps.
 *
 * Env: OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL. The key only ever
 * leaves this process as an Authorization header; it is never logged. Any
 * URL that reaches console output is redacted first (userinfo and query
 * stripped), because a base URL can carry credentials in both places.
 */
import type { TurnAdapter, TurnEntry, TurnRequest } from "./adapter";

export interface OpenAIEnv {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Read the three env vars; null when any is missing or blank. */
export function readEnv(
  env: Record<string, string | undefined> = process.env,
): OpenAIEnv | null {
  const baseUrl = env["OPENAI_BASE_URL"]?.trim();
  const apiKey = env["OPENAI_API_KEY"]?.trim();
  const model = env["OPENAI_MODEL"]?.trim();
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl, apiKey, model };
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

/** One model line `TOOL name {json}`, or null when the line is not a call. */
export function parseToolLine(
  line: string,
): { name: string; input: Record<string, unknown> } | null {
  const m = /^TOOL\s+([A-Za-z0-9_-]+)\s+(\{.*\})$/.exec(line.trim());
  if (m === null) return null;
  try {
    const parsed: unknown = JSON.parse(m[2]);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return { name: m[1], input: parsed as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** Split a model reply: one entry per TOOL line, runs of prose grouped. */
export function toEntries(content: string): TurnEntry[] {
  const out: TurnEntry[] = [];
  const prose: string[] = [];
  const flush = (): void => {
    if (prose.length > 0) {
      out.push({ kind: "talk", text: prose.join("\n") });
      prose.length = 0;
    }
  };
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (parseToolLine(line) !== null) {
      flush();
      out.push({ kind: "tool", text: line });
    } else {
      prose.push(line);
    }
  }
  flush();
  return out;
}

const REQUEST_TIMEOUT_MS = 120_000;

export class OpenAICompat implements TurnAdapter {
  constructor(private readonly env: OpenAIEnv) {}

  /** One fresh turn: system + view + user text, streamed back as entries. */
  async *ask(req: TurnRequest): AsyncIterable<TurnEntry> {
    const content = await this.chat(req.system, `${req.view}\n\n${req.userText}`);
    yield* toEntries(content);
  }

  /** One compactor call: the view lines, then the step. Returns the reply. */
  async compress(contextLines: string[], step: string, system: string): Promise<string> {
    const user = [...contextLines, step].join("\n\n");
    return this.chat(system, user);
  }

  private async chat(system: string, user: string): Promise<string> {
    const url = `${this.env.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.env.apiKey}`,
      },
      body: JSON.stringify({
        model: this.env.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`model http ${res.status} at ${redactUrl(url)}: ${body.slice(0, 200)}`);
    }
    const data: unknown = await res.json();
    const content = pickContent(data);
    if (content === null) throw new Error(`model reply had no content at ${redactUrl(url)}`);
    return content;
  }
}

function pickContent(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}