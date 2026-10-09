// MCP server core: newline-delimited JSON-RPC over stdio, no dependencies.
// Only the tools surface is implemented; that is all the recall path needs.
//
// Framing rule from the MCP transports spec: messages are individual JSON-RPC
// objects delimited by newlines and must not contain embedded newlines. Nothing
// but valid MCP messages may reach stdout.

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(input: Record<string, unknown>): Promise<string>;
}

export interface McpServerOptions {
  name: string;
  version: string;
  tools: readonly McpTool[];
}

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type Json = Record<string, unknown>;

function errorOf(id: unknown, code: number, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function asRecord(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

/**
 * Serve one MCP session. Resolves when the input ends. Responses are written
 * one per line through `write`, which must not inject newlines of its own.
 */
export async function serveMcp(
  lines: AsyncIterable<string>,
  write: (line: string) => void,
  options: McpServerOptions,
): Promise<void> {
  const emit = (message: Json): void => {
    write(JSON.stringify(message));
  };

  for await (const line of lines) {
    if (line.trim() === "") continue;

    let message: Json;
    try {
      message = asRecord(JSON.parse(line));
    } catch {
      emit(errorOf(null, PARSE_ERROR, "parse error"));
      continue;
    }

    const method = typeof message["method"] === "string" ? message["method"] : null;
    if (method === null) continue; // a client response, not a request

    // A missing id means a notification, which never gets a reply.
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const id = message["id"];
    const reply = (payload: Omit<Json, "jsonrpc" | "id"> & { id?: unknown }): void => {
      if (hasId) emit({ jsonrpc: "2.0", id, ...payload });
    };

    const params = asRecord(message["params"]);

    switch (method) {
      case "initialize": {
        const requested = params["protocolVersion"];
        reply({
          result: {
            protocolVersion: typeof requested === "string" ? requested : DEFAULT_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: options.name, version: options.version },
          },
        });
        break;
      }

      case "notifications/initialized":
      case "initialized":
        break;

      case "tools/list":
        reply({
          result: {
            tools: options.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          },
        });
        break;

      case "tools/call": {
        const name = typeof params["name"] === "string" ? params["name"] : "";
        const tool = options.tools.find((candidate) => candidate.name === name);
        if (tool === undefined) {
          reply(errorOf(id, INVALID_PARAMS, `Unknown tool: ${name}`));
          break;
        }
        try {
          const text = await tool.run(asRecord(params["arguments"]));
          reply({ result: { content: [{ type: "text", text }], isError: false } });
        } catch (err) {
          // A failing tool is a tool-execution error, not a protocol error.
          const text = err instanceof Error ? err.message : String(err);
          reply({ result: { content: [{ type: "text", text }], isError: true } });
        }
        break;
      }

      default:
        reply(errorOf(id, METHOD_NOT_FOUND, `Method not found: ${method}`));
    }
  }
}
