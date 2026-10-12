/**
 * MCP recall surface: read-only memory tools over the stored log, tree and view.
 *
 * Recall may be model-invoked; capture is not. Nothing here writes: no writer
 * lock is taken, no message or node is appended, no view is saved. Each call
 * re-reads the stored memory, so a message captured between calls is visible
 * without restarting the server.
 */

import { byteLen, type LogMessage, type TreeNode } from "../constants";
import { openLog } from "../storage/log";
import { loadAllNodes } from "../storage/tree-store";
import { nodeKey } from "../tree/address";
import { lookup, memoryDateAt } from "../tools/date";
import { memoryZoomStore, zoom } from "../tools/zoom";
import { TOOL_DEFINITIONS } from "../tools/definitions";
import type { ToolDefinition } from "../model/adapter";
import type { Part } from "../view/fold";
import { resumeView } from "../view/persist";
import { NOT_BUILT, renderView } from "../view/render";
import type { McpTool } from "./server";

/** Messages in ID order. A stored ID gap is refused: the view cannot tile. */
async function readMessages(base: string, scope: string): Promise<LogMessage[]> {
  const writer = await openLog(base, scope);
  const messages = writer.messages;
  if (messages.some((message, i) => message.i !== i) || writer.nextId !== messages.length) {
    throw new Error("chat log ID gap: restore missing records before using memory");
  }
  return messages;
}

/** Read-only store: the log, its summaries, and the view folded over both. */
async function loadMemory(base: string, scope: string): Promise<{
  messages: LogMessage[];
  nodes: Map<string, TreeNode>;
  view: Part[];
}> {
  const messages = await readMessages(base, scope);
  const nodes = await loadAllNodes(base, scope);
  const isBuilt = (l: number, i: number): boolean => nodes.has(nodeKey(l, i));
  const sizeOf = (l: number, i: number): number =>
    nodes.get(nodeKey(l, i))?.size ?? byteLen(NOT_BUILT);
  const view = await resumeView(base, scope, messages.length, sizeOf, isBuilt);
  return { messages, nodes, view };
}

/** The native tool definition for a name, so both surfaces stay word-for-word. */
function definition(name: "zoom" | "date"): ToolDefinition {
  const found = TOOL_DEFINITIONS.find((tool) => tool.name === name);
  if (found === undefined) throw new Error(`optchat: missing ${name} tool definition`);
  return found;
}

/** The recall surface, bound to one data directory and scope. */
export function memoryTools(base: string, scope: string): McpTool[] {
  const zoomDef = definition("zoom");
  const dateDef = definition("date");
  return [
    {
      name: "recall",
      description:
        "Read stored long-term memory: the settled view, one line per summarized range " +
        "as `id+n|text`, oldest first. Open a line with zoom.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() {
        const memory = await loadMemory(base, scope);
        return renderView(memory.view, (part) => memory.nodes.get(nodeKey(part.l, part.i))?.text);
      },
    },
    {
      name: zoomDef.name,
      description: zoomDef.description,
      inputSchema: zoomDef.parameters,
      async run(input) {
        const memory = await loadMemory(base, scope);
        return zoom(
          memoryZoomStore(memory.messages, memory.nodes),
          Number(input["id"]),
          Number(input["n"]),
          memory.messages.length,
        );
      },
    },
    {
      name: dateDef.name,
      description: dateDef.description,
      inputSchema: dateDef.parameters,
      async run(input) {
        const messages = await readMessages(base, scope);
        return lookup(memoryDateAt(messages), Number(input["id"]));
      },
    },
  ];
}
