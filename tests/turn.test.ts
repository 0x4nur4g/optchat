import { describe, expect, test } from "bun:test";
import type { Kind } from "../src/constants";
import type { TurnRequest } from "../src/model/adapter";
import { runTurn, settle } from "../src/turn/loop";

describe("runTurn", () => {
  test("renders before logging all queued prompts and keeps their wording", async () => {
    const queue = ["  first  ", "\tsecond\n  indented"];
    const log: [Kind, string][] = [];
    const requests: TurnRequest[] = [];
    await runTurn(queue, {
      renderView: () => {
        expect(log).toEqual([]);
        return "0+1|user: earlier";
      },
      log: async (kind, text) => { log.push([kind, text]); },
      adapter: {
        async *ask(request) {
          requests.push(request);
          yield { kind: "talk", text: "answer" };
        },
      },
    });
    expect(queue).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.view).toBe("0+1|user: earlier");
    expect(requests[0]!.userText).toBe("  first  \n\n\tsecond\n  indented");
    expect(log).toEqual([
      ["user", "  first  "], ["user", "\tsecond\n  indented"], ["talk", "answer"],
    ]);
  });

  test("logs delivered mid-turn users but displays thoughts only transiently", async () => {
    const log: [Kind, string][] = [];
    const displayed: string[] = [];
    const queue = ["start"];
    await runTurn(queue, {
      renderView: () => "",
      log: async (kind, text) => { log.push([kind, text]); },
      onEntry: (entry) => { displayed.push(`${entry.kind}: ${entry.text}`); },
      adapter: {
        async *ask() {
          yield { kind: "thought", text: "ephemeral reasoning" };
          queue.push("not yet delivered");
          yield { kind: "tool", text: "zoom call" };
          yield { kind: "echo", text: "tool result" };
          yield { kind: "user", text: "  delivered correction  " };
          yield { kind: "talk", text: "done" };
        },
      },
    });
    expect(log).toEqual([
      ["user", "start"], ["tool", "zoom call"], ["echo", "tool result"],
      ["user", "  delivered correction  "], ["talk", "done"],
    ]);
    expect(displayed).toContain("thought: ephemeral reasoning");
    expect(queue).toEqual(["not yet delivered"]);
  });

  test("keeps inputs queued when their append fails", async () => {
    const queue = ["persisted", "retry me", "also pending"];
    const log: string[] = [];
    await expect(runTurn(queue, {
      renderView: () => "",
      log: async (_kind, text) => {
        if (text === "retry me") throw new Error("append failed");
        log.push(text);
      },
      adapter: { async *ask() { throw new Error("must not ask"); } },
    })).rejects.toThrow("append failed");
    expect(log).toEqual(["persisted"]);
    expect(queue).toEqual(["retry me", "also pending"]);
  });

  test("preserves unanswered users on cancellation without starting the actor", async () => {
    const abort = new AbortController();
    abort.abort();
    const log: string[] = [];
    const queue = ["cancelled but retained"];
    await runTurn(queue, {
      renderView: () => "",
      signal: abort.signal,
      log: async (_kind, text) => { log.push(text); },
      adapter: { async *ask() { throw new Error("must not ask"); } },
    });
    expect(log).toEqual(["cancelled but retained"]);
    expect(queue).toEqual([]);
  });

  test("caps echoes with the shared Unicode-safe head/tail format", async () => {
    const log: [Kind, string][] = [];
    await runTurn(["inspect"], {
      renderView: () => "",
      log: async (kind, text) => { log.push([kind, text]); },
      adapter: { async *ask() { yield { kind: "echo", text: "🙂".repeat(20_000) }; } },
    });
    expect(log[1]).toEqual([
      "echo", "🙂".repeat(7_492) + "\n[... 10032 characters cut ...]\n" + "🙂".repeat(7_492),
    ]);
    expect(log[1]![1].length).toBe(30_000);
  });
});

describe("settle", () => {
  test("rechecks readiness after subscribing, without losing a wake", async () => {
    let ready = false;
    const result = await settle(() => ready, () => { ready = true; }, new AbortController().signal);
    expect(result).toBe(true);
  });

  test("does not treat an early wake as a built view and removes its waiter", async () => {
    let ready = false;
    let wake: (() => void) | undefined;
    let removed = false;
    const abort = new AbortController();
    const pending = settle(() => ready, (callback) => {
      wake = callback;
      return () => { removed = true; };
    }, abort.signal);
    wake!();
    abort.abort();
    expect(await pending).toBe(false);
    expect(removed).toBe(true);
  });
});
