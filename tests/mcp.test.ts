import { describe, expect, test } from "bun:test";
import { serveMcp } from "../src/mcp/server";
import type { McpTool } from "../src/mcp/server";

/** Collect one protocol session: feed lines in, return every emitted line. */
async function session(
  input: readonly string[],
  tools: readonly McpTool[],
): Promise<Array<Record<string, unknown>>> {
  const out: string[] = [];
  await serveMcp(
    (async function* () {
      for (const line of input) yield line;
    })(),
    (line) => { out.push(line); },
    { name: "optchat", version: "0.1.0", tools },
  );
  return out.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const echo: McpTool = {
  name: "echo",
  description: "Return the text",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  async run(input) {
    return String(input["text"]);
  },
};

describe("mcp protocol", () => {
  test("initialize returns server info and a tools capability", async () => {
    const [reply] = await session(
      [JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } },
      })],
      [echo],
    );
    expect(reply!["id"]).toBe(1);
    const result = reply!["result"] as Record<string, unknown>;
    expect(result["protocolVersion"]).toBe("2025-06-18");
    expect((result["capabilities"] as Record<string, unknown>)["tools"]).toEqual({ listChanged: false });
    expect(result["serverInfo"]).toEqual({ name: "optchat", version: "0.1.0" });
  });

  test("initialize answers with the requested protocol version", async () => {
    const [reply] = await session(
      [JSON.stringify({
        jsonrpc: "2.0", id: 7, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "1" } },
      })],
      [echo],
    );
    const result = reply!["result"] as Record<string, unknown>;
    expect(result["protocolVersion"]).toBe("2024-11-05");
  });

  test("notifications produce no reply", async () => {
    const replies = await session(
      [JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })],
      [echo],
    );
    expect(replies).toEqual([]);
  });

  test("tools/list returns name, description and schema", async () => {
    const [reply] = await session(
      [JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })],
      [echo],
    );
    const result = reply!["result"] as { tools: Record<string, unknown>[] };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!["name"]).toBe("echo");
    expect(result.tools[0]!["description"]).toBe("Return the text");
    expect(result.tools[0]!["inputSchema"]).toEqual(echo.inputSchema);
  });

  test("tools/call returns text content and isError false", async () => {
    const [reply] = await session(
      [JSON.stringify({
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "echo", arguments: { text: "hello" } },
      })],
      [echo],
    );
    const result = reply!["result"] as { content: { type: string; text: string }[]; isError: boolean };
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
  });

  test("a throwing tool reports isError true, not a protocol error", async () => {
    const failing: McpTool = {
      name: "failing",
      description: "throws",
      inputSchema: { type: "object", properties: {} },
      async run() {
        throw new Error("boom");
      },
    };
    const [reply] = await session(
      [JSON.stringify({
        jsonrpc: "2.0", id: 4, method: "tools/call",
        params: { name: "failing", arguments: {} },
      })],
      [failing],
    );
    expect(reply!["error"]).toBeUndefined();
    const result = reply!["result"] as { content: { text: string }[]; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("boom");
  });

  test("unknown tool is a protocol error", async () => {
    const [reply] = await session(
      [JSON.stringify({
        jsonrpc: "2.0", id: 5, method: "tools/call",
        params: { name: "nope", arguments: {} },
      })],
      [echo],
    );
    const error = reply!["error"] as { code: number; message: string };
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("nope");
  });

  test("unknown method returns -32601", async () => {
    const [reply] = await session(
      [JSON.stringify({ jsonrpc: "2.0", id: 6, method: "bogus/method", params: {} })],
      [echo],
    );
    expect((reply!["error"] as { code: number }).code).toBe(-32601);
  });

  test("malformed JSON returns -32700 with no id", async () => {
    const [reply] = await session(["{not json"], [echo]);
    const error = reply!["error"] as { code: number };
    expect(error.code).toBe(-32700);
    expect(reply!["id"]).toBeNull();
  });

  test("several messages on separate lines are answered in order", async () => {
    const replies = await session(
      [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } }),
      ],
      [echo],
    );
    expect(replies.map((r) => r["id"])).toEqual([1, 2, 3]);
  });

  test("stdout carries only valid JSON-RPC objects", async () => {
    const out: string[] = [];
    await serveMcp(
      (async function* () {
        yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      })(),
      (line) => { out.push(line); },
      { name: "optchat", version: "0.1.0", tools: [echo] },
    );
    for (const line of out) {
      expect(line.includes("\n")).toBe(false);
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed["jsonrpc"]).toBe("2.0");
    }
  });
});
