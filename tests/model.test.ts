import { describe, expect, spyOn, test } from "bun:test";
import type { ToolDefinition, TurnEntry } from "../src/model/adapter";
import { capToolResult } from "../src/compactor/prompts";
import { CAP } from "../src/constants";
import { OpenAICompat, readEnv, redactUrl } from "../src/model/openai-compat";

const env = { baseUrl: "https://model.invalid/v1", apiKey: "test-only", model: "test-model" };
const tools: ToolDefinition[] = [{
  name: "lookup",
  description: "Read a local fixture.",
  parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
}];

async function entries(adapter: OpenAICompat, userText = "original task", signal?: AbortSignal): Promise<TurnEntry[]> {
  const output: TurnEntry[] = [];
  for await (const entry of adapter.ask({ system: "stable system", view: "stable view\n", userText, signal })) output.push(entry);
  return output;
}

describe("native turns", () => {
  test("two tool steps retain the original prompt, raw metadata, results, and stable prefix", async () => {
    const first = {
      role: "assistant", content: "Checking first.", reasoning_content: "readable thought",
      reasoning_details: [{ type: "reasoning.encrypted", data: "opaque fixture", signature: "signature fixture" }],
      vendor_state: { position: 7 },
      tool_calls: [{ id: "call-a", type: "function", function: { name: "lookup", arguments: '{"n":1}' } }],
    };
    const second = {
      role: "assistant", content: null, reasoning: "next thought", signature: "second signature",
      tool_calls: [{ id: "call-b", type: "function", function: { name: "lookup", arguments: '{"n":2}' } }],
    };
    const requests: any[] = [];
    const replies = [first, second, { role: "assistant", content: "Done." }, { role: "assistant", content: "Fresh." }];
    const adapter = new OpenAICompat(env, {
      tools,
      runTool: (_name, input) => `result ${input.n}`,
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init.body)));
        return Response.json({ choices: [{ message: replies.shift() }] });
      },
    });
    const output = await entries(adapter);
    expect(output).toEqual([
      { kind: "thought", text: "readable thought" },
      { kind: "talk", text: "Checking first." },
      { kind: "tool", text: 'lookup {"n":1}' },
      { kind: "echo", text: "result 1" },
      { kind: "thought", text: "next thought" },
      { kind: "tool", text: 'lookup {"n":2}' },
      { kind: "echo", text: "result 2" },
      { kind: "talk", text: "Done." },
    ]);
    const initial = [
      { role: "system", content: "stable system" },
      { role: "user", content: [{ type: "text", text: "stable view\n" }, { type: "text", text: "original task" }] },
    ];
    expect(requests[2].messages).toEqual([
      ...initial, first, { role: "tool", tool_call_id: "call-a", content: "result 1" },
      second, { role: "tool", tool_call_id: "call-b", content: "result 2" },
    ]);
    for (const request of requests) {
      expect(request.messages.slice(0, 2)).toEqual(initial);
      expect(request.tools).toEqual([{ type: "function", function: tools[0] }]);
      expect(request.parallel_tool_calls).toBe(false);
      expect(request.stream).toBe(false);
    }
    expect(output.filter((entry) => ["talk", "tool", "echo", "user"].includes(entry.kind))
      .map((entry) => entry.text).join("\n")).not.toContain("thought");
    await entries(adapter, "next task");
    expect(requests[3].messages).toEqual([
      initial[0],
      { role: "user", content: [{ type: "text", text: "stable view\n" }, { type: "text", text: "next task" }] },
    ]);
    expect(requests[3].tools).toEqual(requests[0].tools);
  });

  test("queued input enters only after complete tool results and final responses never drain it", async () => {
    const pending = ["mid-run one", "mid-run two"];
    const requests: any[] = [];
    let drains = 0;
    const adapter = new OpenAICompat(env, {
      tools,
      takePending: () => { drains += 1; return pending.splice(0); },
      runTool: async () => { expect(drains).toBe(0); return "fulfilled"; },
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init.body)));
        if (requests.length === 1) {
          expect(drains).toBe(0);
          return Response.json({ choices: [{ message: { role: "assistant", content: null,
            tool_calls: [{ id: "pending-tool", type: "function", function: { name: "lookup", arguments: '{"n":1}' } }],
          } }] });
        }
        pending.push("next turn");
        return Response.json({ choices: [{ message: { role: "assistant", content: "answered" } }] });
      },
    });
    expect((await entries(adapter)).map((entry) => entry.kind)).toEqual(["tool", "echo", "user", "user", "talk"]);
    expect(requests[1].messages.slice(-3)).toEqual([
      { role: "tool", tool_call_id: "pending-tool", content: "fulfilled" },
      { role: "user", content: "mid-run one" }, { role: "user", content: "mid-run two" },
    ]);
    expect(drains).toBe(1);
    expect(pending).toEqual(["next turn"]);
  });

  test("cancellation stops an unresolved tool wait without draining pending input", async () => {
    const controller = new AbortController();
    const pending = ["unanswered"];
    let started!: () => void;
    const toolStarted = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0;
    const adapter = new OpenAICompat(env, {
      tools,
      takePending: () => pending.splice(0),
      runTool: () => { started(); return new Promise<string>(() => {}); },
      fetch: async () => {
        calls += 1;
        return Response.json({ choices: [{ message: { role: "assistant", content: null,
          tool_calls: [{ id: "waiting", type: "function", function: { name: "lookup", arguments: '{"n":1}' } }],
        } }] });
      },
    });
    const output = entries(adapter, "original task", controller.signal);
    await toolStarted;
    controller.abort(new Error("private cancellation fixture"));
    const outcome = await Promise.race([
      output.then(() => "finished", (error: unknown) => error),
      new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 25)),
    ]);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("turn aborted");
    expect(pending).toEqual(["unanswered"]);
    expect(calls).toBe(1);
  });

  test("abort at a tool or echo boundary keeps queued input and stops further work", async () => {
    for (const boundary of ["tool", "echo"]) {
      const controller = new AbortController();
      const pending = ["keep queued"];
      let executions = 0;
      let requests = 0;
      const adapter = new OpenAICompat(env, {
        tools,
        runTool: () => { executions += 1; return "finished tool"; },
        takePending: () => pending.splice(0),
        fetch: async () => {
          requests += 1;
          return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [
            { id: "boundary", type: "function", function: { name: "lookup", arguments: '{"n":1}' } },
          ] } }] });
        },
      });
      const iterator = adapter.ask({ system: "stable", view: "", userText: "task", signal: controller.signal })[Symbol.asyncIterator]();
      expect((await iterator.next()).value.kind).toBe("tool");
      if (boundary === "echo") expect((await iterator.next()).value.kind).toBe("echo");
      controller.abort();
      await expect(iterator.next()).rejects.toThrow("turn aborted");
      expect(pending).toEqual(["keep queued"]);
      expect(executions).toBe(boundary === "echo" ? 1 : 0);
      expect(requests).toBe(1);
    }
  });

  test("abort after a thought stops the remaining response entries and tool handler", async () => {
    const controller = new AbortController();
    let executions = 0;
    const adapter = new OpenAICompat(env, {
      tools, runTool: () => { executions += 1; return "unexpected"; },
      fetch: async () => Response.json({ choices: [{ message: {
        role: "assistant", content: "not delivered after abort", reasoning_content: "completed thought",
        tool_calls: [{ id: "after-thought", type: "function", function: { name: "lookup", arguments: '{"n":1}' } }],
      } }] }),
    });
    const iterator = adapter.ask({ system: "stable", view: "", userText: "task", signal: controller.signal })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ kind: "thought", text: "completed thought" });
    controller.abort();
    await expect(iterator.next()).rejects.toThrow("turn aborted");
    expect(executions).toBe(0);
  });

  test("inputs yielded before a failed follow-up remain visible as unanswered user entries", async () => {
    const pending = ["accepted one", "accepted two"];
    const output: TurnEntry[] = [];
    let requests = 0;
    const adapter = new OpenAICompat(env, {
      tools, runTool: () => "ready", takePending: () => pending.splice(0),
      fetch: async () => {
        requests += 1;
        if (requests > 1) throw new Error("private follow-up failure fixture");
        return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [
          { id: "follow-up", type: "function", function: { name: "lookup", arguments: '{"n":1}' } },
        ] } }] });
      },
    });
    const run = async (): Promise<void> => {
      for await (const entry of adapter.ask({ system: "stable", view: "", userText: "task" })) output.push(entry);
    };
    await expect(run()).rejects.toThrow("model request failed");
    expect(output.filter((entry) => entry.kind === "user")).toEqual([
      { kind: "user", text: "accepted one" }, { kind: "user", text: "accepted two" },
    ]);
    expect(pending).toEqual([]);
  });

  test("unknown tools, malformed JSON, and non-object inputs become matching native results", async () => {
    const argumentsList = ["{}", "not JSON", "[]", "null", "3", '"string"', '{"n":1}'];
    const calls = argumentsList.map((args, index) => ({
      id: `invalid-${index}`, type: "function", function: { name: index === 0 ? "unknown" : "lookup", arguments: args },
    }));
    const requests: any[] = [];
    let executions = 0;
    let drains = 0;
    const adapter = new OpenAICompat(env, {
      tools,
      runTool: () => { executions += 1; throw new Error("private tool failure fixture"); },
      takePending: () => { drains += 1; return ["after all results"]; },
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init.body)));
        return Response.json({ choices: [{ message: requests.length === 1
          ? { role: "assistant", content: null, tool_calls: calls }
          : { role: "assistant", content: "recovered" },
        }] });
      },
    });
    const output = await entries(adapter);
    const results = requests[1].messages.filter((message: any) => message.role === "tool");
    expect(results.map((message: any) => message.tool_call_id)).toEqual(calls.map((call) => call.id));
    expect(results.map((message: any) => message.content)).toEqual([
      "error: unknown tool",
      ...Array(5).fill("error: tool arguments must be a JSON object"),
      "error: tool failed",
    ]);
    expect(output.filter((entry) => entry.kind === "echo").map((entry) => entry.text))
      .toEqual(results.map((message: any) => message.content));
    expect(requests[1].messages.at(-1)).toEqual({ role: "user", content: "after all results" });
    expect(output.at(-1)).toEqual({ kind: "talk", text: "recovered" });
    expect(executions).toBe(1);
    expect(drains).toBe(1);
  });

  test("missing native result IDs fail before any handler runs without inventing IDs", async () => {
    let executions = 0;
    let drains = 0;
    const adapter = new OpenAICompat(env, {
      tools, runTool: () => { executions += 1; return "unexpected"; },
      takePending: () => { drains += 1; return []; },
      fetch: async () => Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [
        { id: "valid-first", type: "function", function: { name: "lookup", arguments: '{"n":1}' } },
        { type: "function", function: { name: "lookup", arguments: '{"n":2}' } },
      ] } }] }),
    });
    await expect(entries(adapter)).rejects.toThrow("model tool call had no id");
    expect(executions).toBe(0);
    expect(drains).toBe(0);
  });

  test("tool results use the same Unicode-safe character cap in echo and provider history", async () => {
    const result = "HEAD " + "😀é界".repeat(10_000) + " TAIL";
    const requests: any[] = [];
    const adapter = new OpenAICompat(env, {
      tools, runTool: () => result,
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init.body)));
        return Response.json({ choices: [{ message: requests.length === 1
          ? { role: "assistant", content: null, tool_calls: [
            { id: "large", type: "function", function: { name: "lookup", arguments: '{"n":1}' } },
          ] }
          : { role: "assistant", content: "ok" },
        }] });
      },
    });
    const output = await entries(adapter);
    const echo = output.find((entry) => entry.kind === "echo")!.text;
    expect(echo).toBe(capToolResult(result));
    expect(echo.length).toBeLessThanOrEqual(CAP);
    expect(Buffer.byteLength(echo)).toBeGreaterThan(CAP);
    expect(echo.startsWith("HEAD ")).toBe(true);
    expect(echo.endsWith(" TAIL")).toBe(true);
    expect(new TextDecoder().decode(new TextEncoder().encode(echo))).toBe(echo);
    expect(requests[1].messages.at(-1)).toEqual({ role: "tool", tool_call_id: "large", content: echo });
  });

  test("native turns can complete more than eight tool rounds", async () => {
    let rounds = 0;
    const adapter = new OpenAICompat(env, {
      tools, runTool: () => "result",
      fetch: async () => {
        rounds += 1;
        const message = rounds <= 9
          ? { role: "assistant", content: null, tool_calls: [
            { id: `round-${rounds}`, type: "function", function: { name: "lookup", arguments: '{"n":1}' } },
          ] }
          : { role: "assistant", content: "finished all nine" };
        return Response.json({ choices: [{ message }] });
      },
    });
    const output = await entries(adapter);
    expect(output.at(-1)).toEqual({ kind: "talk", text: "finished all nine" });
    expect(output.filter((entry) => entry.kind === "echo")).toHaveLength(9);
    expect(rounds).toBe(10);
  });

  test("legacy TOOL text remains prose, not an executable command", async () => {
    let executions = 0;
    const adapter = new OpenAICompat(env, {
      tools, runTool: () => { executions += 1; return "unexpected"; },
      fetch: async () => Response.json({ choices: [{ message: { role: "assistant", content: 'TOOL lookup {"n":1}' } }] }),
    });
    expect(await entries(adapter)).toEqual([{ kind: "talk", text: 'TOOL lookup {"n":1}' }]);
    expect(executions).toBe(0);
  });

  test("cache view blocks stay before the separate last user block and no cache flags are invented", async () => {
    const first = "😀".repeat(24_999) + "\n";
    const tail = "é".repeat(30_010);
    const requests: any[] = [];
    const adapter = new OpenAICompat(env, {
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init.body)));
        return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
      },
    });
    for await (const _entry of adapter.ask({ system: "stable", view: first + tail, userText: "new question" })) {}
    expect(requests[0].messages).toEqual([
      { role: "system", content: "stable" },
      { role: "user", content: [
        { type: "text", text: first }, { type: "text", text: tail }, { type: "text", text: "new question" },
      ] },
    ]);
    expect(requests[0].prompt_cache_options).toBeUndefined();
    expect(requests[0].messages[1].content.every((part: any) => Object.keys(part).sort().join(",") === "text,type"))
      .toBe(true);
  });

  test("caller mutation cannot change the environment or tool definitions between requests", async () => {
    const definitions: ToolDefinition[] = JSON.parse(JSON.stringify(tools));
    const config = { ...env };
    const requests: any[] = [];
    const adapter = new OpenAICompat(config, {
      tools: definitions,
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init.body)));
        return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
      },
    });
    await entries(adapter);
    definitions[0].description = "changed description";
    definitions[0].parameters.required = ["changed"];
    config.model = "changed-model";
    await entries(adapter);
    expect(requests[1].tools).toEqual(requests[0].tools);
    expect(requests[1].model).toBe("test-model");
    expect(requests[1].messages).toEqual(requests[0].messages);
  });
});

describe("compaction sessions", () => {
  test("feedback retains the same conversation, raw reasoning, and full source without tools", async () => {
    const attempts = [
      { role: "assistant", content: "too long", reasoning_content: "private thought", signature: "signed fixture" },
      { role: "assistant", content: "still long", vendor_state: { cursor: 4 } },
      { role: "assistant", content: "short" },
    ];
    const requests: any[] = [];
    const adapter = new OpenAICompat({ ...env, compactorModel: "cheap-model" }, {
      tools,
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init.body)));
        return Response.json({ choices: [{ message: attempts[requests.length - 1] }] });
      },
    });
    const session = adapter.openCompaction(["bare summary", "second summary"], "whole source\nlast line", "compact system");
    expect(await session.reply()).toBe("too long");
    expect(await session.reply("Try 128 bytes.")).toBe("still long");
    expect(await session.reply("Try 64 bytes.")).toBe("short");
    const initial = [
      { role: "system", content: "compact system" },
      { role: "user", content: [
        { type: "text", text: "<chat>\nbare summary\nsecond summary\n</chat>" },
        { type: "text", text: "whole source\nlast line" },
      ] },
    ];
    expect(requests[0].messages).toEqual(initial);
    expect(requests[2].messages).toEqual([
      ...initial, attempts[0], { role: "user", content: "Try 128 bytes." },
      attempts[1], { role: "user", content: "Try 64 bytes." },
    ]);
    for (const request of requests) {
      expect(request.model).toBe("cheap-model");
      expect(request.tools).toBeUndefined();
      expect(request.parallel_tool_calls).toBeUndefined();
      expect(JSON.stringify(request.messages)).not.toMatch(/\d+\+\d+\|/);
    }
  });

  test("new compaction sessions start fresh and default to the turn model", async () => {
    const requests: any[] = [];
    const adapter = new OpenAICompat(env, {
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init.body)));
        return Response.json({ choices: [{ message: { role: "assistant", content: "summary" } }] });
      },
    });
    const old = adapter.openCompaction([], "old source", "compact");
    await old.reply();
    await old.reply("retry");
    await adapter.openCompaction([], "fresh source", "compact").reply();
    expect(requests[2].model).toBe("test-model");
    expect(requests[2].messages).toEqual([
      { role: "system", content: "compact" },
      { role: "user", content: [
        { type: "text", text: "<chat>\n\n</chat>" }, { type: "text", text: "fresh source" },
      ] },
    ]);
  });
});

describe("model config", () => {
  test("required env values stay required and the optional compactor model is trimmed", () => {
    expect(readEnv({})).toBeNull();
    expect(readEnv({ OPENAI_BASE_URL: env.baseUrl, OPENAI_API_KEY: " ", OPENAI_MODEL: env.model })).toBeNull();
    expect(readEnv({
      OPENAI_BASE_URL: ` ${env.baseUrl} `, OPENAI_API_KEY: " test-only ", OPENAI_MODEL: " test-model ",
      OPENAI_COMPACTOR_MODEL: " cheap-model ",
    })).toEqual({ ...env, compactorModel: "cheap-model" });
  });

  test("malformed URL, userinfo, fragments, and header control characters fail before transport", () => {
    for (const baseUrl of ["not a URL", "file:///fixture", "https://fixture-user:fixture-pass@model.invalid/v1", "https://model.invalid/v1#fragment"]) {
      expect(() => new OpenAICompat({ ...env, baseUrl })).toThrow("invalid OPENAI_BASE_URL");
    }
    expect(() => new OpenAICompat({ ...env, apiKey: "fixture\r\nheader" })).toThrow("invalid OPENAI_API_KEY");
    expect(() => new OpenAICompat({ ...env, model: " " })).toThrow("invalid OPENAI_MODEL");
    expect(() => new OpenAICompat({ ...env, compactorModel: "fixture\nmodel" })).toThrow("invalid OPENAI_COMPACTOR_MODEL");
    expect(() => readEnv({ OPENAI_BASE_URL: "not a URL", OPENAI_API_KEY: "test-only", OPENAI_MODEL: env.model }))
      .toThrow("invalid OPENAI_BASE_URL");
  });

  test("URL redaction keeps only scheme, host, and path", () => {
    expect(redactUrl("https://fixture-user:fixture-pass@model.invalid/v1?fixture=auth#fragment"))
      .toBe("https://model.invalid/v1");
    expect(redactUrl("not a URL")).toBe("(unparseable url)");
  });
});

describe("provider transport", () => {
  test("already-aborted turns and compaction sessions never invoke transport or drain input", async () => {
    let calls = 0;
    let drains = 0;
    const adapter = new OpenAICompat(env, {
      fetch: async () => { calls += 1; return Response.json({}); },
      takePending: () => { drains += 1; return ["unanswered"]; },
    });
    const signal = AbortSignal.abort(new Error("private abort fixture"));
    await expect(entries(adapter, "task", signal)).rejects.toThrow("turn aborted");
    await expect(adapter.openCompaction([], "source", "compact", signal).reply()).rejects.toThrow("turn aborted");
    expect(calls).toBe(0);
    expect(drains).toBe(0);
  });

  test("caller cancellation reaches the HTTP signal and omits private abort reasons", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => { started = resolve; });
    let received: AbortSignal | undefined;
    const adapter = new OpenAICompat(env, {
      fetch: (_url, init) => {
        received = init.signal ?? undefined;
        started();
        return new Promise<Response>(() => {});
      },
    });
    const output = entries(adapter, "task", controller.signal);
    await fetching;
    controller.abort(new Error("private abort reason fixture"));
    const outcome = await Promise.race([
      output.then(() => "finished", (error: unknown) => error),
      new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 25)),
    ]);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("turn aborted");
    expect(received?.aborted).toBe(true);
  });

  test("query auth stays on the endpoint while HTTP errors omit response bodies and all credentials", async () => {
    const adapter = new OpenAICompat({ ...env, baseUrl: "https://model.invalid/v1/?fixture=auth" }, {
      fetch: async (url, init) => {
        const parsed = new URL(url);
        expect(parsed.pathname).toBe("/v1/chat/completions");
        expect(parsed.searchParams.has("fixture")).toBe(true);
        expect(parsed.username).toBe("");
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-only");
        return new Response("private response fixture test-only", { status: 422 });
      },
    });
    try {
      await entries(adapter);
      throw new Error("expected provider error");
    } catch (error) {
      expect((error as Error).message).toBe("model http 422 at https://model.invalid/v1/chat/completions");
    }
  });

  test("network and invalid-JSON errors cannot echo transport secrets", async () => {
    const network = new OpenAICompat(env, {
      fetch: async () => { throw new Error("private network fixture test-only"); },
    });
    await expect(entries(network)).rejects.toThrow("model request failed at https://model.invalid/v1/chat/completions");
    const invalid = new OpenAICompat(env, { fetch: async () => new Response("private body fixture") });
    await expect(entries(invalid)).rejects.toThrow("model reply was not valid JSON at https://model.invalid/v1/chat/completions");
  });

  test("usage callbacks report safe native input, cached, and output counters", async () => {
    const usage: { input: number; cached: number; output: number }[] = [];
    const data = [
      { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens: 4, total_tokens: 104 },
      { prompt_tokens: -1, prompt_tokens_details: { cached_tokens: "unsafe" }, completion_tokens: null },
      { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 99 }, completion_tokens: 2.5 },
    ];
    const adapter = new OpenAICompat(env, {
      onUsage: (entry) => usage.push(entry),
      fetch: async () => Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: data.shift() }),
    });
    await entries(adapter);
    await entries(adapter);
    await entries(adapter);
    expect(usage).toEqual([
      { input: 100, cached: 30, output: 4 }, { input: 0, cached: 0, output: 0 }, { input: 10, cached: 10, output: 0 },
    ]);
  });

  test("timeout stops even an injected fetch that ignores its signal and redacts the abort reason", async () => {
    const timer = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      expect(milliseconds).toBe(120_000);
      queueMicrotask(() => timer.abort(new DOMException("private timeout fixture", "TimeoutError")));
      return timer.signal;
    });
    try {
      const adapter = new OpenAICompat(env, { fetch: () => new Promise<Response>(() => {}) });
      const outcome = await Promise.race([
        entries(adapter).then(() => "finished", (error: unknown) => error),
        new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 25)),
      ]);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe("model request timed out at https://model.invalid/v1/chat/completions");
    } finally {
      timeout.mockRestore();
    }
  });
});
